// Compare a customized au-sidenav menu against a freshly-parsed site index and
// produce a list of accept/reject-able differences (added, removed, renamed,
// moved). Pure functions; no React.
//
// Matching strategy:
//   1. URL pass — pair nodes whose normalized hrefs match (DFS order on
//      collisions). Empty hrefs (logical categories) never participate.
//   2. Label pass — for nodes unmatched after the URL pass, pair by trimmed
//      lowercase label. Only unique-on-both-sides matches; ambiguous matches
//      are left as added/removed to avoid false positives.
//
// Move detection compares URL-bearing ancestor paths only — empty-href
// categories in the menu are skipped when computing each side's path, so a
// child sitting under a logical category in the menu and directly under its
// real URL parent in the site index is NOT flagged as moved.

import {
  type SitemapNode,
  addChild,
  findNode,
  removeNode,
  renameNode,
} from './sitemap'

// ── Normalization ───────────────────────────────────────────────────────────

// Normalize an href for matching. Behavior:
//   - '' (empty) stays '' (categories never match)
//   - trim, lowercase the whole string
//   - strip fragment (#...)
//   - parseable absolute URL: drop protocol, drop default ports (:80/:443),
//     lowercase host, keep pathname + search
//   - collapse repeated slashes in the pathname
//   - strip trailing '/' EXCEPT when pathname is just '/'
//   - non-parseable input: apply the trailing-slash + slash-collapse rules
export function normalizeHref(href: string): string {
  if (!href) return ''
  let s = href.trim().toLowerCase()
  if (!s) return ''
  // Strip fragment first so it doesn't confuse URL parsing.
  const hashIdx = s.indexOf('#')
  if (hashIdx !== -1) s = s.slice(0, hashIdx)
  if (!s) return ''

  try {
    const u = new URL(s)
    let host = u.hostname
    if (u.port && u.port !== '80' && u.port !== '443') host = host + ':' + u.port
    let path = u.pathname || '/'
    path = path.replace(/\/{2,}/g, '/')
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
    return host + path + u.search
  } catch {
    // Relative path or otherwise non-URL — apply path normalization only.
    // Split off query so we don't collapse slashes inside ?foo=bar/baz.
    const queryIdx = s.indexOf('?')
    let path = queryIdx === -1 ? s : s.slice(0, queryIdx)
    const query = queryIdx === -1 ? '' : s.slice(queryIdx)
    path = path.replace(/\/{2,}/g, '/')
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
    return path + query
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

// URL-bearing ancestor hrefs, root → direct parent (normalized).
// Empty-href ancestors are SKIPPED — that's the whole point of UrlPath:
// matching the structural position of a page through any logical categories
// the menu has layered on top.
export type UrlPath = string[]

export interface MatchedPair {
  menuNode: SitemapNode
  menuPath: UrlPath
  siteNode: SitemapNode
  sitePath: UrlPath
  matchedBy: 'href' | 'label'
}

export type DiffEntry =
  | {
      kind: 'added'
      id: string
      siteNode: SitemapNode
      siteParentPath: UrlPath
      // The menu-side parent id where the page should be inserted on accept.
      // Derived by URL-matching the site-side direct URL-bearing parent against
      // the menu. null = top of menu (user can drag into place after).
      suggestedMenuParentId: string | null
      // Display-only label of the suggested parent (or '' for top of menu).
      suggestedMenuParentLabel: string
    }
  | {
      kind: 'removed'
      id: string
      menuNode: SitemapNode
    }
  | {
      kind: 'renamed'
      id: string
      menuNode: SitemapNode
      siteLabel: string
    }
  | {
      kind: 'moved'
      id: string
      menuNode: SitemapNode
      fromMenuParentId: string | null
      toMenuParentId: string | null
      siteParentPath: UrlPath
      // Display-only label of the new parent (or '' for top of menu).
      toMenuParentLabel: string
    }

export interface DiffResult {
  entries: DiffEntry[]
  matched: MatchedPair[]
  // Menu nodes with empty href — surfaced so tests/UI can assert they were
  // correctly ignored by matching. Categories are never reported as removed.
  unmatchedMenuCategories: SitemapNode[]
}

// ── Internals ───────────────────────────────────────────────────────────────

interface Indexed {
  node: SitemapNode
  // URL-bearing ancestor path (normalized), root → direct parent.
  urlPath: UrlPath
  // Direct parent in the original tree (any kind), for menu-side parent id
  // lookups. null = top-level.
  parent: SitemapNode | null
}

function indexForest(roots: SitemapNode[]): Indexed[] {
  const out: Indexed[] = []
  function walk(nodes: SitemapNode[], urlPath: UrlPath, parent: SitemapNode | null): void {
    for (const n of nodes) {
      out.push({ node: n, urlPath, parent })
      const nh = normalizeHref(n.href)
      const childPath = nh ? [...urlPath, nh] : urlPath
      walk(n.children, childPath, n)
    }
  }
  walk(roots, [], null)
  return out
}

function pathsEqual(a: UrlPath, b: UrlPath): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Find the menu node whose normalized href matches `targetHref`. Returns the
// id, or null if none. Used for resolving "where should this added page go"
// and "where does this moved page belong now" from a site-side parent path.
function findMenuNodeByHref(roots: SitemapNode[], targetHref: string): SitemapNode | null {
  if (!targetHref) return null
  function walk(nodes: SitemapNode[]): SitemapNode | null {
    for (const n of nodes) {
      if (normalizeHref(n.href) === targetHref) return n
      const found = walk(n.children)
      if (found) return found
    }
    return null
  }
  return walk(roots)
}

// Walks a SitemapNode subtree and emits a structural twin with fresh ids.
// Uses an internal closure counter rather than makeNode() so the generated ids
// have a distinct 'd<n>' shape that cannot collide with parser-generated 'n<n>'
// ids regardless of when in the session this runs.
let __cloneCounter = 0
function cloneWithFreshIds(node: SitemapNode): SitemapNode {
  __cloneCounter += 1
  const id = 'd' + __cloneCounter
  return {
    id,
    href: node.href,
    defaultLabel: node.defaultLabel,
    label: node.label,
    included: node.included,
    external: node.external,
    children: node.children.map(cloneWithFreshIds),
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function diffForests(
  menuForest: SitemapNode[],
  siteForest: SitemapNode[],
): DiffResult {
  const menuIdx = indexForest(menuForest)
  const siteIdx = indexForest(siteForest)

  const unmatchedMenuCategories = menuIdx
    .filter(e => e.node.href.trim() === '')
    .map(e => e.node)

  // URL pass: build per-side queues keyed by normalized href. Skip empties.
  const menuByHref = new Map<string, Indexed[]>()
  for (const m of menuIdx) {
    const h = normalizeHref(m.node.href)
    if (!h) continue
    const list = menuByHref.get(h) ?? []
    list.push(m)
    menuByHref.set(h, list)
  }
  const siteByHref = new Map<string, Indexed[]>()
  for (const s of siteIdx) {
    const h = normalizeHref(s.node.href)
    if (!h) continue
    const list = siteByHref.get(h) ?? []
    list.push(s)
    siteByHref.set(h, list)
  }

  const matched: MatchedPair[] = []
  const menuMatched = new Set<string>()
  const siteMatched = new Set<string>()

  for (const [href, menuList] of menuByHref) {
    const siteList = siteByHref.get(href) ?? []
    const n = Math.min(menuList.length, siteList.length)
    for (let i = 0; i < n; i++) {
      const m = menuList[i]
      const s = siteList[i]
      matched.push({
        menuNode: m.node,
        menuPath: m.urlPath,
        siteNode: s.node,
        sitePath: s.urlPath,
        matchedBy: 'href',
      })
      menuMatched.add(m.node.id)
      siteMatched.add(s.node.id)
    }
  }

  // Label fallback: among nodes still unmatched, build label indexes (trim +
  // lowercase). Only unique-on-both-sides pairs match — ambiguity is left
  // unmatched so spurious renames/moves don't surface.
  const menuLabelIdx = new Map<string, Indexed[]>()
  for (const m of menuIdx) {
    if (menuMatched.has(m.node.id)) continue
    if (m.node.href.trim() === '') continue // skip categories
    const k = m.node.label.trim().toLowerCase()
    if (!k) continue
    const list = menuLabelIdx.get(k) ?? []
    list.push(m)
    menuLabelIdx.set(k, list)
  }
  const siteLabelIdx = new Map<string, Indexed[]>()
  for (const s of siteIdx) {
    if (siteMatched.has(s.node.id)) continue
    if (s.node.href.trim() === '') continue
    const k = s.node.label.trim().toLowerCase()
    if (!k) continue
    const list = siteLabelIdx.get(k) ?? []
    list.push(s)
    siteLabelIdx.set(k, list)
  }
  for (const [label, menuList] of menuLabelIdx) {
    const siteList = siteLabelIdx.get(label)
    if (!siteList) continue
    if (menuList.length !== 1 || siteList.length !== 1) continue // ambiguous
    const m = menuList[0]
    const s = siteList[0]
    matched.push({
      menuNode: m.node,
      menuPath: m.urlPath,
      siteNode: s.node,
      sitePath: s.urlPath,
      matchedBy: 'label',
    })
    menuMatched.add(m.node.id)
    siteMatched.add(s.node.id)
  }

  // ── Entry generation ──
  const entries: DiffEntry[] = []

  // Renamed (only from href-matched pairs — label pairs already have equal labels).
  for (const pair of matched) {
    if (pair.matchedBy !== 'href') continue
    if (pair.menuNode.label.trim() === pair.siteNode.label.trim()) continue
    entries.push({
      kind: 'renamed',
      id: `rename:${pair.menuNode.id}`,
      menuNode: pair.menuNode,
      siteLabel: pair.siteNode.label,
    })
  }

  // Moved (matched pair whose URL-bearing ancestor paths differ).
  for (const pair of matched) {
    if (pathsEqual(pair.menuPath, pair.sitePath)) continue
    const siteParentHref = pair.sitePath[pair.sitePath.length - 1] ?? ''
    const targetParent = siteParentHref
      ? findMenuNodeByHref(menuForest, siteParentHref)
      : null
    const fromParent = menuIdx.find(e => e.node.id === pair.menuNode.id)?.parent ?? null
    entries.push({
      kind: 'moved',
      id: `move:${pair.menuNode.id}`,
      menuNode: pair.menuNode,
      fromMenuParentId: fromParent ? fromParent.id : null,
      toMenuParentId: targetParent ? targetParent.id : null,
      siteParentPath: pair.sitePath,
      toMenuParentLabel: targetParent ? targetParent.label : '',
    })
  }

  // Added (site nodes still unmatched, with non-empty href).
  for (const s of siteIdx) {
    if (siteMatched.has(s.node.id)) continue
    if (s.node.href.trim() === '') continue // skip categories on site side too
    const siteParentHref = s.urlPath[s.urlPath.length - 1] ?? ''
    const suggested = siteParentHref
      ? findMenuNodeByHref(menuForest, siteParentHref)
      : null
    entries.push({
      kind: 'added',
      id: `add:${normalizeHref(s.node.href)}`,
      siteNode: s.node,
      siteParentPath: s.urlPath,
      suggestedMenuParentId: suggested ? suggested.id : null,
      suggestedMenuParentLabel: suggested ? suggested.label : '',
    })
  }

  // Removed (menu nodes still unmatched, with non-empty href — categories excluded).
  for (const m of menuIdx) {
    if (menuMatched.has(m.node.id)) continue
    if (m.node.href.trim() === '') continue
    entries.push({
      kind: 'removed',
      id: `remove:${m.node.id}`,
      menuNode: m.node,
    })
  }

  return { entries, matched, unmatchedMenuCategories }
}

// Apply an entry to the menu forest. Returns the new forest (immutable).
// No-op (returns input forest) when the entry's target id is no longer in
// the forest — e.g. the user already accepted a related change that removed it.
export function applyDiff(menuForest: SitemapNode[], entry: DiffEntry): SitemapNode[] {
  switch (entry.kind) {
    case 'added': {
      const targetParent = entry.suggestedMenuParentId
      // If the suggested parent was removed in the meantime, fall back to top.
      const targetExists = targetParent === null || findNode(menuForest, targetParent) !== null
      const cloned = cloneWithFreshIds(entry.siteNode)
      return addChild(menuForest, targetExists ? targetParent : null, cloned)
    }
    case 'removed': {
      if (!findNode(menuForest, entry.menuNode.id)) return menuForest
      return removeNode(menuForest, entry.menuNode.id)
    }
    case 'renamed': {
      if (!findNode(menuForest, entry.menuNode.id)) return menuForest
      return renameNode(menuForest, entry.menuNode.id, entry.siteLabel)
    }
    case 'moved': {
      const node = findNode(menuForest, entry.menuNode.id)
      if (!node) return menuForest
      // Preserve children + customizations by carrying the current node (not
      // the entry's stale snapshot). Remove from current spot, re-add under
      // the target parent.
      const targetExists =
        entry.toMenuParentId === null || findNode(menuForest, entry.toMenuParentId) !== null
      const afterRemove = removeNode(menuForest, entry.menuNode.id)
      return addChild(afterRemove, targetExists ? entry.toMenuParentId : null, node)
    }
  }
}

// Test-only helper — resets the clone counter so tests get deterministic ids.
// Not exported from the package's main barrel; only the diff tests import it.
export function __resetCloneCounter(): void {
  __cloneCounter = 0
}
