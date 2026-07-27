// Turn the low-level diff between a customized menu and a fresh site index
// into a small set of semantic changes a human can review one at a time.
//
// The merge policy this encodes:
//   - the SITE INDEX is authoritative for structure and URLs
//   - the EXISTING MENU is authoritative for page names and for logical
//     groupings that have no counterpart in the site hierarchy
//
// diffForests() answers "what is textually different". It cannot answer "what
// happened", and the difference matters: when a disabled group page
// (/USAWC/Carlisle-Experience/, href-less in the menu because it could not be
// visited) becomes a real page, the raw diff reports one add plus one move for
// every descendant — 38 entries for a single editorial event. Reviewing those
// individually is not just tedious, it is misleading: each move points at a
// parent that does not exist yet.
//
// So this module consolidates first, then hands the UI a plan:
//
//   phase 'identity'  — what a node IS   (promote/demote, url-rename)
//   phase 'structure' — where nodes LIVE (add-subtree, move, remove)
//   phase 'labels'    — cosmetic         (relabel)
//
// Phases fall out of a real dependency graph — you cannot place a page inside a
// container before deciding what that container is — which is what makes the
// review order explainable rather than arbitrary.
//
// Nothing here mutates. buildMergePlan is pure; applyPlan takes the plan plus
// the user's decisions and produces one new forest in a single pass, so the
// menu never sits in a half-merged state and node ids never churn mid-review.

import {
  diffForests,
  normalizeHrefForMatch,
  insertAtSitePosition,
  cloneSiteSubtree,
  type DiffEntry,
} from './diff'
import { findDuplicateLinks } from './duplicates'
import {
  addChild,
  findNode,
  removeNode,
  renameNode,
  selectSubtree,
  setExternal,
  setHref,
  type SitemapNode,
} from './sitemap'

// ── Types ───────────────────────────────────────────────────────────────────

export type ChangePhase = 'identity' | 'structure' | 'labels'

export type ChangeKind =
  | 'promote'      // href-less group in the menu is a real page in the index
  | 'demote'       // real page in the menu is href-less/absent as a page
  | 'url-rename'   // same page, new slug (a paired add + remove)
  | 'add-subtree'  // page in the index that the menu lacks, with its descendants
  | 'move'         // page re-parented in the index
  | 'remove'       // page in the menu that the index no longer has
  | 'relabel'      // same URL, different page name

export type Confidence = 'high' | 'medium' | 'low'

export interface ChangeOption {
  id: string
  label: string
  description: string
  // Selecting this option means "make no change".
  isSkip?: boolean
}

interface ChangeBase {
  // Stable for the life of the plan. Derived from node identity rather than
  // list position so decisions survive a scope change that rebuilds the plan.
  id: string
  phase: ChangePhase
  title: string
  // One line explaining what accepting would do.
  detail: string
  // Change ids that must be applied before this one can be.
  dependsOn: string[]
  defaultOptionId: string
  options: ChangeOption[]
  // Raw diff entries folded into this change. Powers "37 move artifacts hidden".
  absorbedCount: number
  // Set when the change cannot be applied at all — surfaced in the UI before
  // the user wastes a decision on it, rather than failing at apply time.
  blockedReason?: string
}

export type MergeChange =
  | (ChangeBase & {
      kind: 'promote'
      menuNode: SitemapNode
      siteNode: SitemapNode
      newHref: string
    })
  | (ChangeBase & {
      kind: 'demote'
      menuNode: SitemapNode
    })
  | (ChangeBase & {
      kind: 'url-rename'
      menuNode: SitemapNode
      siteNode: SitemapNode
      newHref: string
      siteLabel: string
      confidence: Confidence
      matchReason: string
      // Needed only by the 'split' option, which falls back to remove + add.
      parentMenuNodeId: string | null
      siteSiblingHrefs: string[]
      siteSiblingIndex: number
    })
  | (ChangeBase & {
      kind: 'add-subtree'
      siteNode: SitemapNode
      parentMenuNodeId: string | null
      parentLabel: string
      // Descendants coming along with this page (absorbed child adds).
      descendantCount: number
      siteSiblingHrefs: string[]
      siteSiblingIndex: number
    })
  | (ChangeBase & {
      kind: 'move'
      menuNode: SitemapNode
      toMenuParentId: string | null
      toMenuParentLabel: string
    })
  | (ChangeBase & {
      kind: 'remove'
      menuNode: SitemapNode
      childCount: number
    })
  | (ChangeBase & {
      kind: 'relabel'
      menuNode: SitemapNode
      siteLabel: string
      // True when the menu's name looks strictly more informative than the
      // index's — e.g. "Strategic Research and Assessment Department (SRAD)"
      // against "SRAD". Informational; the default is to keep the menu's name
      // either way.
      menuLabelExpandsSite: boolean
    })

export interface MergePlan {
  // Topologically ordered: dependencies first, then phase, then menu order.
  changes: MergeChange[]
  // What consolidation removed from the raw diff, for the "n hidden" line.
  suppressed: {
    moveArtifacts: number
    duplicateLinks: number
    absorbedAdds: number
    autoHomeRelabels: number
  }
}

// changeId → selected option id.
export type Decisions = Record<string, string>

export interface ApplyResult {
  forest: SitemapNode[]
  applied: string[]
  skipped: string[]
  // Changes that could not be applied, with the reason.
  blocked: Array<{ id: string; reason: string }>
}

// ── Option vocabulary ───────────────────────────────────────────────────────

const ACCEPT: ChangeOption = {
  id: 'accept',
  label: 'Accept',
  description: 'Apply this change to the menu.',
}
const SKIP: ChangeOption = {
  id: 'skip',
  label: 'Skip',
  description: 'Leave the menu as it is.',
  isSkip: true,
}
const KEEP_LABEL: ChangeOption = {
  id: 'keep-label',
  label: 'Adopt new URL, keep my label',
  description: 'The page moves to its new address and keeps the name you gave it.',
}
const TAKE_LABEL: ChangeOption = {
  id: 'take-label',
  label: 'Adopt new URL and label',
  description: "Use the site index's address and page name.",
}
const SPLIT: ChangeOption = {
  id: 'split',
  label: 'Not the same page',
  description: 'Treat these as an unrelated removal and addition instead.',
}
const KEEP_MY_LABEL: ChangeOption = {
  id: 'keep',
  label: 'Keep my label',
  description: 'Your page name wins.',
  isSkip: true,
}
const TAKE_SITE_LABEL: ChangeOption = {
  id: 'take',
  label: "Use the site index's label",
  description: 'Replace your page name with the one from the site index.',
}

// ── Small text helpers used by rename pairing ───────────────────────────────

function alnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

// Last path segment of an href: '/a/b/emerging-tech/' → 'emerging-tech'.
function lastSlug(href: string): string {
  const segs = normalizeHrefForMatch(href).split('/').filter(Boolean)
  return segs[segs.length - 1] ?? ''
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

// Sørensen–Dice over character bigrams. Cheap, order-insensitive, and forgiving
// of the small edits that slug renames actually involve.
function dice(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter += 1
  return (2 * inter) / (A.size + B.size)
}

// 'shadows-and-steel' ⊂ 'shadows-and-steel-2045', 'wdc' ⊂
// 'wargame-designer-course-wdc'. The '-' boundary requirement stops 'news' from
// matching 'newsroom'.
function slugPrefixOrSuffix(a: string, b: string): boolean {
  if (!a || !b || a === b) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < 3) return false
  return long.startsWith(short + '-') || long.endsWith('-' + short)
}

// 'Emerging Tech' → 'Emerging Technology': same token count, each token of one
// a prefix of the other's.
//
// Requires at least two tokens on purpose. With a single token this rule
// degenerates into bare string-prefix matching and would call 'News' →
// 'Newsroom' a rename with high confidence. Multi-token names carry their own
// corroboration: the untouched words have to line up exactly.
function tokenwisePrefix(a: string, b: string): boolean {
  const A = tokens(a)
  const B = tokens(b)
  if (A.length < 2 || A.length !== B.length) return false
  let anyShorter = false
  for (let i = 0; i < A.length; i++) {
    const [short, long] = A[i].length <= B[i].length ? [A[i], B[i]] : [B[i], A[i]]
    if (!long.startsWith(short)) return false
    if (short !== long) {
      if (short.length < 3) return false
      anyShorter = true
    }
  }
  return anyShorter
}

// 'WDC' against 'Wargame Designer Course (WDC)' — parenthetical first, then
// plain initials.
export function isAcronymOf(acronym: string, phrase: string): boolean {
  const a = alnum(acronym)
  if (a.length < 2) return false
  for (const paren of phrase.match(/\(([^)]+)\)/g) ?? []) {
    if (alnum(paren) === a) return true
  }
  const initials = tokens(phrase).map(t => t[0]).join('')
  return initials.length >= 2 && initials === a
}

// 'Strategic Competition' ⊂ 'Strategic Competition Center'.
function tokenSubset(a: string, b: string): boolean {
  const A = new Set(tokens(a))
  const B = new Set(tokens(b))
  if (A.size === 0 || B.size === 0 || A.size === B.size) return false
  const [small, big] = A.size <= B.size ? [A, B] : [B, A]
  for (const t of small) if (!big.has(t)) return false
  return true
}

interface RenameMatch {
  score: number
  confidence: Confidence | null
  reason: string
}

// How likely it is that a removed menu page and an added site page are the same
// page under a new URL. Only ever called on candidates that already share a
// parent, so this is a tiebreaker among siblings, not a global search.
//
// 'high' is reserved for structural evidence. A good bigram overlap earns
// 'medium' at best — it is suggestive, not proof.
export function scoreRename(menuNode: SitemapNode, siteNode: SitemapNode): RenameMatch {
  const mSlug = lastSlug(menuNode.href)
  const sSlug = lastSlug(siteNode.href)
  const mLabel = menuNode.label
  const sLabel = siteNode.label

  if (slugPrefixOrSuffix(mSlug, sSlug)) {
    return { score: 1, confidence: 'high', reason: 'the URL slug is a prefix of the other' }
  }
  if (tokenwisePrefix(mSlug, sSlug) || tokenwisePrefix(mLabel, sLabel)) {
    return { score: 1, confidence: 'high', reason: 'the names differ only by an abbreviated word' }
  }
  if (isAcronymOf(sLabel, mLabel) || isAcronymOf(mLabel, sLabel)) {
    return { score: 1, confidence: 'high', reason: 'one name is the acronym of the other' }
  }
  if (tokenSubset(mLabel, sLabel)) {
    return { score: 1, confidence: 'high', reason: 'one name contains the other' }
  }
  const d = Math.max(dice(alnum(mSlug), alnum(sSlug)), dice(alnum(mLabel), alnum(sLabel)))
  if (d >= 0.6) return { score: d, confidence: 'medium', reason: 'the names are closely similar' }
  if (d >= 0.35) return { score: d, confidence: 'low', reason: 'the names are loosely similar' }
  return { score: d, confidence: null, reason: '' }
}

// ── Forest indexing ─────────────────────────────────────────────────────────

interface IndexEntry {
  node: SitemapNode
  parent: SitemapNode | null
  order: number
}

function indexForest(roots: SitemapNode[]): Map<string, IndexEntry> {
  const map = new Map<string, IndexEntry>()
  let order = 0
  function walk(nodes: SitemapNode[], parent: SitemapNode | null): void {
    for (const n of nodes) {
      map.set(n.id, { node: n, parent, order: order++ })
      walk(n.children, n)
    }
  }
  walk(roots, null)
  return map
}

function descendants(node: SitemapNode): SitemapNode[] {
  const out: SitemapNode[] = []
  function walk(nodes: SitemapNode[]): void {
    for (const n of nodes) {
      out.push(n)
      walk(n.children)
    }
  }
  walk(node.children)
  return out
}

function countNodes(node: SitemapNode): number {
  return 1 + descendants(node).length
}

// Is `maybeAncestorId` an ancestor of `node` in the indexed forest?
function hasAncestor(index: Map<string, IndexEntry>, node: SitemapNode, ancestorId: string): boolean {
  let cur = index.get(node.id)?.parent ?? null
  while (cur) {
    if (cur.id === ancestorId) return true
    cur = index.get(cur.id)?.parent ?? null
  }
  return false
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// ── buildMergePlan ──────────────────────────────────────────────────────────

export interface BuildPlanOptions {
  // The picked menu root, when the user has one. Used to recognise the
  // tool-generated " Home" suffix and to keep top-level inserts inside the root.
  rootId?: string | null
}

export function buildMergePlan(
  menuForest: SitemapNode[],
  siteForest: SitemapNode[],
  options: BuildPlanOptions = {},
): MergePlan {
  const diff = diffForests(menuForest, siteForest)
  const menuIndex = indexForest(menuForest)
  const siteIndex = indexForest(siteForest)

  const changes: MergeChange[] = []
  const suppressed = {
    moveArtifacts: 0,
    duplicateLinks: diff.siteShortcutNodes.length,
    absorbedAdds: 0,
    autoHomeRelabels: 0,
  }

  const addEntries = diff.entries.filter(e => e.kind === 'added')
  const moveEntries = diff.entries.filter(e => e.kind === 'moved')
  const removeEntries = diff.entries.filter(e => e.kind === 'removed')
  const relabelEntries = diff.entries.filter(e => e.kind === 'renamed')

  // Site href (normalized) → the menu node that represents it, plus the change
  // that has to be applied first for that to be true. Seeded from the pages the
  // two trees already agree on, then extended by promotions and url-renames.
  const menuNodeBySiteHref = new Map<string, { menuNodeId: string; dependsOn: string | null }>()
  for (const pair of diff.matched) {
    const h = normalizeHrefForMatch(pair.siteNode.href)
    if (h && !menuNodeBySiteHref.has(h)) {
      menuNodeBySiteHref.set(h, { menuNodeId: pair.menuNode.id, dependsOn: null })
    }
  }

  const consumedAddIds = new Set<string>()
  const consumedRemoveIds = new Set<string>()
  const suppressedMoveIds = new Set<string>()

  // ── Rule A: a menu-only group turns out to be a real page ─────────────────
  //
  // Detected from the menu side: find the href-less category whose internal
  // pages all live under the new page's URL. Keeping the existing node (rather
  // than adding the site's copy beside it) preserves the label, the children,
  // their order and their include flags — and makes every descendant "move"
  // evaporate, because those moves only existed to describe a level that the
  // menu was missing.
  const menuCategories = diff.unmatchedMenuCategories
  for (const entry of addEntries) {
    if (entry.kind !== 'added') continue
    const siteHref = normalizeHrefForMatch(entry.siteNode.href)
    if (!siteHref) continue

    let best: SitemapNode | null = null
    let bestDepth = -1
    for (const category of menuCategories) {
      // Only weigh internal pages: a logical group commonly also holds a couple
      // of off-site links, and those legitimately sit outside the prefix.
      const internal = descendants(category).filter(
        d => d.href.trim() !== '' && !d.external,
      )
      if (internal.length === 0) continue
      const allUnder = internal.every(d =>
        normalizeHrefForMatch(d.href).startsWith(siteHref + '/'),
      )
      if (!allUnder) continue
      const depth = countAncestors(menuIndex, category)
      if (depth > bestDepth) {
        best = category
        bestDepth = depth
      }
    }
    if (!best) continue

    const category = best
    const id = `promote:${category.id}`
    consumedAddIds.add(entry.id)

    // Every "moved" whose only difference is the newly-introduced level is an
    // artifact of the group having had no URL. Genuine moves inside the same
    // subtree survive this test because removing the new segment still leaves
    // their paths different.
    let artifacts = 0
    for (const mv of moveEntries) {
      if (mv.kind !== 'moved') continue
      if (suppressedMoveIds.has(mv.id)) continue
      if (!hasAncestor(menuIndex, mv.menuNode, category.id)) continue
      const withoutNewLevel = mv.siteParentPath.filter(p => p !== siteHref)
      const menuPath = menuPathOf(menuIndex, mv.menuNode)
      if (pathsEqual(withoutNewLevel, menuPath)) {
        suppressedMoveIds.add(mv.id)
        artifacts += 1
      }
    }
    suppressed.moveArtifacts += artifacts

    menuNodeBySiteHref.set(siteHref, { menuNodeId: category.id, dependsOn: id })

    changes.push({
      id,
      kind: 'promote',
      phase: 'identity',
      title: `${category.label} is now a real page`,
      detail:
        `"${category.label}" is a heading with no link in your menu, but the site index ` +
        `has it as a page at ${entry.siteNode.href}. Give the existing heading that ` +
        `address — its label, its ${category.children.length} child ` +
        `${category.children.length === 1 ? 'item' : 'items'} and their order all stay.`,
      dependsOn: [],
      defaultOptionId: ACCEPT.id,
      options: [ACCEPT, SKIP],
      absorbedCount: artifacts + 1,
      menuNode: category,
      siteNode: entry.siteNode,
      newHref: entry.siteNode.href,
    })
  }

  // ── Rule B: pair leftover removes and adds into URL renames ───────────────
  //
  // Same-parent only. A page that was renamed AND moved will surface as a
  // separate remove and add, which is the honest reading when we have no
  // positional evidence tying them together.
  const remainingRemoves = removeEntries.filter(e => !consumedRemoveIds.has(e.id))
  const remainingAdds = addEntries.filter(e => !consumedAddIds.has(e.id))

  const removeBuckets = new Map<string, DiffEntry[]>()
  for (const e of remainingRemoves) {
    if (e.kind !== 'removed') continue
    const parent = menuIndex.get(e.menuNode.id)?.parent ?? null
    const key = parent ? parent.id : '__root__'
    const list = removeBuckets.get(key) ?? []
    list.push(e)
    removeBuckets.set(key, list)
  }

  // Resolve where each add wants to live, following promotions.
  interface AddTarget {
    entry: DiffEntry & { kind: 'added' }
    parentMenuNodeId: string | null
    parentResolved: boolean
    dependsOn: string[]
  }
  const addTargets: AddTarget[] = []
  for (const e of remainingAdds) {
    if (e.kind !== 'added') continue
    addTargets.push({ entry: e, ...resolveAddParent(e, menuNodeBySiteHref) })
  }

  const addBuckets = new Map<string, AddTarget[]>()
  for (const t of addTargets) {
    // Unresolved parents get a bucket of their own so they cannot be paired
    // against a removal from an unrelated part of the menu.
    const key = t.parentResolved
      ? t.parentMenuNodeId ?? '__root__'
      : `__unresolved__:${t.entry.id}`
    const list = addBuckets.get(key) ?? []
    list.push(t)
    addBuckets.set(key, list)
  }

  for (const [key, removesHere] of removeBuckets) {
    const addsHere = addBuckets.get(key)
    if (!addsHere || addsHere.length === 0) continue

    interface Candidate { r: number; a: number; match: RenameMatch }
    const candidates: Candidate[] = []
    for (let i = 0; i < removesHere.length; i++) {
      const r = removesHere[i]
      if (r.kind !== 'removed') continue
      for (let j = 0; j < addsHere.length; j++) {
        const match = scoreRename(r.menuNode, addsHere[j].entry.siteNode)
        if (match.confidence === null) continue
        candidates.push({ r: i, a: j, match })
      }
    }
    candidates.sort((x, y) => y.match.score - x.match.score || x.r - y.r || x.a - y.a)

    const usedR = new Set<number>()
    const usedA = new Set<number>()
    const pairs: Array<{ r: number; a: number; match: RenameMatch }> = []
    for (const c of candidates) {
      if (usedR.has(c.r) || usedA.has(c.a)) continue
      usedR.add(c.r)
      usedA.add(c.a)
      pairs.push(c)
    }

    // Unique-residual fallback: one unexplained removal and one unexplained
    // addition under the same parent is almost always the same page, even when
    // nothing about the text says so ("Mideast" → "Middle East").
    if (pairs.length < Math.min(removesHere.length, addsHere.length)) {
      const freeR = removesHere.map((_, i) => i).filter(i => !usedR.has(i))
      const freeA = addsHere.map((_, i) => i).filter(i => !usedA.has(i))
      if (freeR.length === 1 && freeA.length === 1) {
        pairs.push({
          r: freeR[0],
          a: freeA[0],
          match: {
            score: 0,
            confidence: 'low',
            reason: 'the only unexplained removal and addition under this parent',
          },
        })
      }
    }

    for (const p of pairs) {
      const removeEntry = removesHere[p.r]
      const target = addsHere[p.a]
      if (removeEntry.kind !== 'removed') continue
      consumedRemoveIds.add(removeEntry.id)
      consumedAddIds.add(target.entry.id)

      const id = `rename-url:${removeEntry.menuNode.id}`
      const siteHref = normalizeHrefForMatch(target.entry.siteNode.href)
      if (siteHref) menuNodeBySiteHref.set(siteHref, { menuNodeId: removeEntry.menuNode.id, dependsOn: id })

      changes.push({
        id,
        kind: 'url-rename',
        phase: 'identity',
        title: `${removeEntry.menuNode.label} → ${target.entry.siteNode.label}`,
        detail:
          `The site index no longer has ${removeEntry.menuNode.href} but does have ` +
          `${target.entry.siteNode.href} under the same parent — ${p.match.reason}. ` +
          `Point your existing entry at the new address instead of removing and re-adding it, ` +
          `so its children, position and include state survive.`,
        dependsOn: target.dependsOn,
        defaultOptionId: KEEP_LABEL.id,
        options: [KEEP_LABEL, TAKE_LABEL, SPLIT, SKIP],
        absorbedCount: 2,
        menuNode: removeEntry.menuNode,
        siteNode: target.entry.siteNode,
        newHref: target.entry.siteNode.href,
        siteLabel: target.entry.siteNode.label,
        confidence: p.match.confidence ?? 'low',
        matchReason: p.match.reason,
        parentMenuNodeId: target.parentMenuNodeId,
        siteSiblingHrefs: target.entry.siteSiblingHrefs,
        siteSiblingIndex: target.entry.siteSiblingIndex,
      })
    }
  }

  // ── Rule C: fold descendant adds into their ancestor's subtree add ────────
  const survivingAdds = addTargets.filter(t => !consumedAddIds.has(t.entry.id))
  const survivingAddSiteIds = new Set(survivingAdds.map(t => t.entry.siteNode.id))
  const topLevelAdds: AddTarget[] = []
  for (const t of survivingAdds) {
    let ancestor = siteIndex.get(t.entry.siteNode.id)?.parent ?? null
    let absorbed = false
    while (ancestor) {
      if (survivingAddSiteIds.has(ancestor.id)) {
        absorbed = true
        break
      }
      ancestor = siteIndex.get(ancestor.id)?.parent ?? null
    }
    if (absorbed) suppressed.absorbedAdds += 1
    else topLevelAdds.push(t)
  }

  for (const t of topLevelAdds) {
    const { entry, parentMenuNodeId, parentResolved, dependsOn } = t
    const descendantCount = descendants(entry.siteNode).length
    const parentLabel = parentMenuNodeId
      ? menuIndex.get(parentMenuNodeId)?.node.label ?? ''
      : ''
    const extra = descendantCount > 0 ? ` (+${descendantCount})` : ''
    changes.push({
      id: entry.id,
      kind: 'add-subtree',
      phase: 'structure',
      title: `Add ${entry.siteNode.label}${extra}`,
      detail: parentResolved
        ? parentMenuNodeId
          ? `The site index has this page under "${parentLabel}" and your menu does not.` +
            (descendantCount > 0 ? ` Its ${descendantCount} sub-pages come with it.` : '')
          : 'The site index has this page at the top level and your menu does not.'
        : 'Its parent page is not in your menu.',
      dependsOn,
      defaultOptionId: ACCEPT.id,
      options: [ACCEPT, SKIP],
      absorbedCount: 1 + descendantCount,
      blockedReason: parentResolved
        ? undefined
        : "The page this belongs under isn't in your menu, so there is nowhere to put it.",
      siteNode: entry.siteNode,
      parentMenuNodeId,
      parentLabel,
      descendantCount,
      siteSiblingHrefs: entry.siteSiblingHrefs,
      siteSiblingIndex: entry.siteSiblingIndex,
    })
  }

  // ── Moves that survived promotion suppression ─────────────────────────────
  for (const mv of moveEntries) {
    if (mv.kind !== 'moved') continue
    if (suppressedMoveIds.has(mv.id)) continue
    // A page paired into a url-rename is handled there; its old node is gone.
    if (consumedRemoveIds.has(`remove:${mv.menuNode.id}`)) continue
    changes.push({
      id: mv.id,
      kind: 'move',
      phase: 'structure',
      title: `Move ${mv.menuNode.label}`,
      detail: mv.toMenuParentResolved
        ? mv.toMenuParentLabel
          ? `The site index puts this under "${mv.toMenuParentLabel}".`
          : 'The site index puts this at the top level.'
        : 'The site index puts this under a page that is not in your menu.',
      dependsOn: [],
      defaultOptionId: ACCEPT.id,
      options: [ACCEPT, SKIP],
      absorbedCount: 1,
      blockedReason: mv.toMenuParentResolved
        ? undefined
        : "The page it would move under isn't in your menu.",
      menuNode: mv.menuNode,
      toMenuParentId: mv.toMenuParentId,
      toMenuParentLabel: mv.toMenuParentLabel,
    })
  }

  // ── Removals — never staged by default ────────────────────────────────────
  //
  // A truncated paste or a mis-picked compare scope both look exactly like
  // "these pages are gone". Deleting curated work on that evidence is not a
  // default worth having; accepting is one click away.
  for (const rm of removeEntries) {
    if (rm.kind !== 'removed') continue
    if (consumedRemoveIds.has(rm.id)) continue
    const childCount = descendants(rm.menuNode).length
    changes.push({
      id: rm.id,
      kind: 'remove',
      phase: 'structure',
      title: `Remove ${rm.menuNode.label}`,
      detail:
        `${rm.menuNode.href} is not in the site index.` +
        (childCount > 0 ? ` Removing it would also drop its ${childCount} sub-pages.` : ''),
      dependsOn: [],
      defaultOptionId: SKIP.id,
      options: [SKIP, ACCEPT],
      absorbedCount: 1,
      menuNode: rm.menuNode,
      childCount,
    })
  }

  // ── Labels ────────────────────────────────────────────────────────────────
  for (const rl of relabelEntries) {
    if (rl.kind !== 'renamed') continue
    // The " Home" suffix on a sibling-mode root is this tool's own doing;
    // diffing against it and asking the user about it is noise.
    if (isAutoHomeSuffix(rl.menuNode, rl.siteLabel, options.rootId)) {
      suppressed.autoHomeRelabels += 1
      continue
    }
    const expands =
      isAcronymOf(rl.siteLabel, rl.menuNode.label) ||
      (rl.menuNode.label.length > rl.siteLabel.length &&
        alnum(rl.menuNode.label).includes(alnum(rl.siteLabel)))
    changes.push({
      id: rl.id,
      kind: 'relabel',
      phase: 'labels',
      title: `${rl.menuNode.label} → ${rl.siteLabel}`,
      detail: expands
        ? 'Your label spells out what the site index abbreviates.'
        : 'The site index uses a different name for this page.',
      dependsOn: [],
      defaultOptionId: KEEP_MY_LABEL.id,
      options: [KEEP_MY_LABEL, TAKE_SITE_LABEL],
      absorbedCount: 1,
      menuNode: rl.menuNode,
      siteLabel: rl.siteLabel,
      menuLabelExpandsSite: expands,
    })
  }

  return { changes: orderChanges(changes, menuIndex), suppressed }
}

// Where an added page wants to live, following any promotion or url-rename that
// creates its parent.
function resolveAddParent(
  entry: DiffEntry & { kind: 'added' },
  menuNodeBySiteHref: Map<string, { menuNodeId: string; dependsOn: string | null }>,
): { parentMenuNodeId: string | null; parentResolved: boolean; dependsOn: string[] } {
  const parentHref = entry.siteParentPath[entry.siteParentPath.length - 1] ?? ''
  if (!parentHref) {
    // Genuinely top-level in the (scoped) site index.
    return { parentMenuNodeId: null, parentResolved: true, dependsOn: [] }
  }
  const hit = menuNodeBySiteHref.get(parentHref)
  if (hit) {
    return {
      parentMenuNodeId: hit.menuNodeId,
      parentResolved: true,
      dependsOn: hit.dependsOn ? [hit.dependsOn] : [],
    }
  }
  if (entry.suggestedMenuParentResolved && entry.suggestedMenuParentId) {
    return { parentMenuNodeId: entry.suggestedMenuParentId, parentResolved: true, dependsOn: [] }
  }
  return { parentMenuNodeId: null, parentResolved: false, dependsOn: [] }
}

function countAncestors(index: Map<string, IndexEntry>, node: SitemapNode): number {
  let depth = 0
  let cur = index.get(node.id)?.parent ?? null
  while (cur) {
    depth += 1
    cur = index.get(cur.id)?.parent ?? null
  }
  return depth
}

// URL-bearing ancestor path of a menu node, matching how diff.ts builds
// UrlPath: href-less ancestors are skipped.
function menuPathOf(index: Map<string, IndexEntry>, node: SitemapNode): string[] {
  const path: string[] = []
  let cur = index.get(node.id)?.parent ?? null
  while (cur) {
    const h = normalizeHrefForMatch(cur.href)
    if (h) path.unshift(h)
    cur = index.get(cur.id)?.parent ?? null
  }
  return path
}

function isAutoHomeSuffix(
  menuNode: SitemapNode,
  siteLabel: string,
  rootId: string | null | undefined,
): boolean {
  if (rootId && menuNode.id !== rootId) return false
  return menuNode.label.trim() === `${siteLabel.trim()} Home`
}

const PHASE_RANK: Record<ChangePhase, number> = { identity: 0, structure: 1, labels: 2 }

// Phase, then menu document order, then a stable topological pass so a change
// never precedes something it depends on. Dependencies always run identity →
// structure or ancestor-add → descendant-add, so this settles in one sweep.
function orderChanges(changes: MergeChange[], menuIndex: Map<string, IndexEntry>): MergeChange[] {
  const docOrder = (c: MergeChange): number => {
    const id = 'menuNode' in c ? c.menuNode.id : ('parentMenuNodeId' in c ? c.parentMenuNodeId : null)
    if (!id) return Number.MAX_SAFE_INTEGER - 1
    return menuIndex.get(id)?.order ?? Number.MAX_SAFE_INTEGER - 1
  }
  const sorted = changes
    .slice()
    .sort((a, b) => PHASE_RANK[a.phase] - PHASE_RANK[b.phase] || docOrder(a) - docOrder(b))

  const emitted = new Set<string>()
  const out: MergeChange[] = []
  const pending = sorted.slice()
  while (pending.length > 0) {
    const readyIdx = pending.findIndex(c =>
      c.dependsOn.every(d => emitted.has(d) || !changes.some(x => x.id === d)),
    )
    // A dependency cycle should be impossible; emitting in sorted order beats
    // looping forever if one ever appears.
    const idx = readyIdx === -1 ? 0 : readyIdx
    const [next] = pending.splice(idx, 1)
    emitted.add(next.id)
    out.push(next)
  }
  return out
}

// ── Decisions ───────────────────────────────────────────────────────────────

export function defaultDecisions(plan: MergePlan): Decisions {
  const out: Decisions = {}
  for (const c of plan.changes) out[c.id] = c.defaultOptionId
  return out
}

export function decisionFor(change: MergeChange, decisions: Decisions): string {
  return decisions[change.id] ?? change.defaultOptionId
}

export function isStaged(change: MergeChange, decisions: Decisions): boolean {
  if (change.blockedReason) return false
  const chosen = decisionFor(change, decisions)
  const option = change.options.find(o => o.id === chosen)
  return option !== undefined && !option.isSkip
}

// ── applyPlan ───────────────────────────────────────────────────────────────

export interface ApplyPlanOptions {
  // The picked menu root. A page the site index calls top-level must land
  // inside this root: appending it to the forest instead would put it outside
  // selectSubtree()'s view, which silently drops it from both the editor and
  // the generated HTML.
  rootId?: string | null
  // The menu's own site URL. '/' means the menu uses root-relative hrefs, so
  // absolute hrefs pulled from the site index get rebased to match.
  menuSiteUrl?: string
}

function rebaseHref(href: string, menuSiteUrl: string | undefined): string {
  if (menuSiteUrl !== '/') return href
  try {
    const u = new URL(href)
    return (u.pathname || '/') + u.search + u.hash
  } catch {
    return href
  }
}

function rebaseSubtree(node: SitemapNode, menuSiteUrl: string | undefined): SitemapNode {
  if (menuSiteUrl !== '/') return node
  return {
    ...node,
    href: node.external ? node.href : rebaseHref(node.href, menuSiteUrl),
    children: node.children.map(c => rebaseSubtree(c, menuSiteUrl)),
  }
}

function collectIds(roots: SitemapNode[]): Set<string> {
  const ids = new Set<string>()
  function walk(nodes: SitemapNode[]): void {
    for (const n of nodes) {
      ids.add(n.id)
      walk(n.children)
    }
  }
  walk(roots)
  return ids
}

function visibleForest(forest: SitemapNode[], rootId: string | null | undefined): SitemapNode[] {
  return rootId ? selectSubtree(forest, rootId) : forest
}

function errorCount(forest: SitemapNode[]): number {
  return findDuplicateLinks(forest).filter(g => g.severity === 'error').length
}

// Apply the staged decisions in one pass. Changes arrive topologically ordered,
// so a dependency has already been applied (or recorded as skipped) by the time
// its dependent is reached.
//
// Two invariants are enforced per change, and a change that would break either
// is rejected rather than half-applied:
//
//   no orphans     — every insert resolves a concrete parent. Nothing is ever
//                    appended to the forest top level, which is how pages used
//                    to disappear behind selectSubtree.
//   no duplicates  — a change that would put the same path in the menu twice is
//                    refused, because au-sidenav's current-page detection stops
//                    at the first match and would light up the wrong branch.
export function applyPlan(
  forest: SitemapNode[],
  plan: MergePlan,
  decisions: Decisions,
  options: ApplyPlanOptions = {},
): ApplyResult {
  const { rootId = null, menuSiteUrl } = options
  let current = forest
  const applied: string[] = []
  const skipped: string[] = []
  const blocked: Array<{ id: string; reason: string }> = []
  const appliedIds = new Set<string>()

  // Ids that must still be reachable at the end: everything we started with,
  // minus whatever an accepted change deliberately deletes.
  const mustSurvive = collectIds(visibleForest(forest, rootId))

  for (const change of plan.changes) {
    if (change.blockedReason) {
      blocked.push({ id: change.id, reason: change.blockedReason })
      continue
    }
    const chosen = decisionFor(change, decisions)
    const option = change.options.find(o => o.id === chosen)
    if (!option || option.isSkip) {
      skipped.push(change.id)
      continue
    }
    const unmet = change.dependsOn.filter(d => !appliedIds.has(d))
    if (unmet.length > 0) {
      blocked.push({ id: change.id, reason: 'A change it depends on was not applied.' })
      continue
    }

    const before = errorCount(visibleForest(current, rootId))
    const outcome = applyOne(current, change, chosen, rootId, menuSiteUrl, mustSurvive)
    if (typeof outcome === 'string') {
      blocked.push({ id: change.id, reason: outcome })
      continue
    }
    if (errorCount(visibleForest(outcome, rootId)) > before) {
      blocked.push({
        id: change.id,
        reason:
          'It would put the same link in the menu twice, which breaks the highlighted-page feature.',
      })
      continue
    }
    current = outcome
    applied.push(change.id)
    appliedIds.add(change.id)
  }

  // Safety net for the class of bug this rework exists to kill: a node that was
  // in the menu, was never deliberately removed, and is gone anyway.
  const survivors = collectIds(visibleForest(current, rootId))
  const lost = [...mustSurvive].filter(id => !survivors.has(id))
  if (lost.length > 0) {
    throw new Error(
      `applyPlan dropped ${lost.length} node(s) that no accepted change removed: ${lost.join(', ')}`,
    )
  }

  return { forest: current, applied, skipped, blocked }
}

// Apply a single change. Returns the new forest, or a string explaining why the
// change had to be refused.
function applyOne(
  forest: SitemapNode[],
  change: MergeChange,
  chosen: string,
  rootId: string | null,
  menuSiteUrl: string | undefined,
  mustSurvive: Set<string>,
): SitemapNode[] | string {
  switch (change.kind) {
    case 'promote': {
      if (!findNode(forest, change.menuNode.id)) return 'The heading is no longer in the menu.'
      const href = rebaseHref(change.newHref, menuSiteUrl)
      return setExternal(setHref(forest, change.menuNode.id, href), change.menuNode.id, false)
    }

    case 'demote': {
      if (!findNode(forest, change.menuNode.id)) return 'The page is no longer in the menu.'
      return setHref(forest, change.menuNode.id, '')
    }

    case 'url-rename': {
      if (!findNode(forest, change.menuNode.id)) return 'The page is no longer in the menu.'
      if (chosen === SPLIT.id) {
        // Genuinely unrelated after all: drop the old page and insert the new
        // subtree in its place.
        const parentId = resolveInsertParent(forest, change.parentMenuNodeId, rootId)
        if (parentId === undefined) return 'There is nowhere to put the new page.'
        mustSurvive.delete(change.menuNode.id)
        for (const d of descendants(change.menuNode)) mustSurvive.delete(d.id)
        const withoutOld = removeNode(forest, change.menuNode.id)
        const cloned = rebaseSubtree(cloneSiteSubtree(change.siteNode), menuSiteUrl)
        return insertAtSitePosition(
          withoutOld,
          parentId,
          cloned,
          change.siteSiblingHrefs,
          change.siteSiblingIndex,
        )
      }
      const href = rebaseHref(change.newHref, menuSiteUrl)
      let next = setExternal(setHref(forest, change.menuNode.id, href), change.menuNode.id, false)
      if (chosen === TAKE_LABEL.id) next = renameNode(next, change.menuNode.id, change.siteLabel)
      return next
    }

    case 'add-subtree': {
      const parentId = resolveInsertParent(forest, change.parentMenuNodeId, rootId)
      if (parentId === undefined) return 'There is nowhere to put this page.'
      const cloned = rebaseSubtree(cloneSiteSubtree(change.siteNode), menuSiteUrl)
      return insertAtSitePosition(
        forest,
        parentId,
        cloned,
        change.siteSiblingHrefs,
        change.siteSiblingIndex,
      )
    }

    case 'move': {
      const node = findNode(forest, change.menuNode.id)
      if (!node) return 'The page is no longer in the menu.'
      if (change.toMenuParentId !== null && findNode([node], change.toMenuParentId)) {
        return 'That would move the page inside itself.'
      }
      const parentId = resolveInsertParent(forest, change.toMenuParentId, rootId)
      if (parentId === undefined) return 'The page it would move under is no longer in the menu.'
      return addChild(removeNode(forest, change.menuNode.id), parentId, node)
    }

    case 'remove': {
      if (!findNode(forest, change.menuNode.id)) return 'The page is no longer in the menu.'
      mustSurvive.delete(change.menuNode.id)
      for (const d of descendants(change.menuNode)) mustSurvive.delete(d.id)
      return removeNode(forest, change.menuNode.id)
    }

    case 'relabel': {
      if (!findNode(forest, change.menuNode.id)) return 'The page is no longer in the menu.'
      return renameNode(forest, change.menuNode.id, change.siteLabel)
    }
  }
}

// Resolve the id to insert under. `undefined` means "refuse" — the caller turns
// that into a blocked change. Never returns a value that would append to the
// forest top level while a root is picked.
function resolveInsertParent(
  forest: SitemapNode[],
  parentMenuNodeId: string | null,
  rootId: string | null,
): string | null | undefined {
  if (parentMenuNodeId === null) {
    // Genuinely top-level. With a picked root, "top level" means the top of
    // that root, not a second forest entry that selectSubtree would discard.
    if (rootId) return findNode(forest, rootId) ? rootId : undefined
    return null
  }
  return findNode(forest, parentMenuNodeId) ? parentMenuNodeId : undefined
}

// ── Summary helpers for the UI ──────────────────────────────────────────────

export interface PlanCounts {
  identity: number
  structure: number
  labels: number
  total: number
  staged: number
  blocked: number
}

export function planCounts(plan: MergePlan, decisions: Decisions): PlanCounts {
  const counts: PlanCounts = {
    identity: 0,
    structure: 0,
    labels: 0,
    total: plan.changes.length,
    staged: 0,
    blocked: 0,
  }
  for (const c of plan.changes) {
    counts[c.phase] += 1
    if (c.blockedReason) counts.blocked += 1
    else if (isStaged(c, decisions)) counts.staged += 1
  }
  return counts
}

// Preview the result of the current decisions without touching app state.
// Returns null when applying would violate an invariant — the caller should
// keep showing the previous preview rather than render a corrupt tree.
export function previewPlan(
  forest: SitemapNode[],
  plan: MergePlan,
  decisions: Decisions,
  options: ApplyPlanOptions = {},
): ApplyResult | null {
  try {
    return applyPlan(forest, plan, decisions, options)
  } catch {
    return null
  }
}

export { countNodes }
