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

// Internal: host-stripped normalization used by every matching/scoping
// helper below. The user's menu is typically generated in site-root-relative
// mode (paths only) while a freshly-pasted site index carries absolute URLs.
// Comparing them via the host-inclusive `normalizeHref` would never match the
// same internal page across those two forms. This helper canonicalizes both
// to a path-only form so '/AMSC/' (menu) and 'https://example.com/AMSC/'
// (site index) compare equal.
//
// Trade-off: two pages on different hosts with the same path also compare
// equal — acceptable because the menu is built from one site's index, so
// cross-host collisions would have to come from user-added external links
// (which are excluded from scope detection via the `external` flag) or
// genuine duplicates the user is already aware of.
function normalizeHrefForMatch(href: string): string {
  if (!href) return ''
  const s = href.trim()
  if (!s) return ''
  const noFragment = s.split('#')[0]
  if (!noFragment) return ''
  try {
    const u = new URL(noFragment)
    let path = (u.pathname || '/').toLowerCase().replace(/\/{2,}/g, '/')
    if (path !== '/' && path.endsWith('/')) path = path.slice(0, -1)
    return path + u.search.toLowerCase()
  } catch {
    // Relative — defer to normalizeHref, which already produces a path-only
    // result for non-URL inputs.
    return normalizeHref(href)
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
      const nh = normalizeHrefForMatch(n.href)
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

// Find the menu node whose normalized href matches `targetHref`. The caller
// passes an already-normalized href (taken from a urlPath entry built by
// indexForest, which uses normalizeHrefForMatch). Returns the matching node
// or null. Used for resolving "where should this added page go" and "where
// does this moved page belong now" from a site-side parent path.
function findMenuNodeByHref(roots: SitemapNode[], targetHref: string): SitemapNode | null {
  if (!targetHref) return null
  function walk(nodes: SitemapNode[]): SitemapNode | null {
    for (const n of nodes) {
      if (normalizeHrefForMatch(n.href) === targetHref) return n
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
    const h = normalizeHrefForMatch(m.node.href)
    if (!h) continue
    const list = menuByHref.get(h) ?? []
    list.push(m)
    menuByHref.set(h, list)
  }
  const siteByHref = new Map<string, Indexed[]>()
  for (const s of siteIdx) {
    const h = normalizeHrefForMatch(s.node.href)
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
      id: `add:${normalizeHrefForMatch(s.node.href)}`,
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

// ── Scope detection ─────────────────────────────────────────────────────────

// Split a normalized href into segments. Empty input → [].
function hrefSegments(normalized: string): string[] {
  if (!normalized) return []
  return normalized.split('/').filter(s => s !== '')
}

// True for relative path hrefs ('/foo/bar', '/portals/x.pdf'). These can only
// refer to the current site, so they're a robust internal-ness signal even
// when applySiteUrl misclassified them as external — which happens when the
// user pasted a menu whose internal links are mostly relative but whose only
// absolute links point off-site (so detectSiteUrls picks one of those as the
// dominant origin).
function isPathOnlyHref(href: string): boolean {
  const s = href.trim()
  if (!s) return false
  try {
    new URL(s)
    return false
  } catch {
    return s.startsWith('/')
  }
}

// Dominant URL-path prefix among the menu's internal-looking hrefs. Returns
// the segment-joined string (e.g. 'programs' — never includes a host since the
// internal normalizer strips it) or '' when nothing dominates.
//
// "Internal-looking" means: not external, OR path-only (relative). The
// path-only fallback is critical when applySiteUrl misclassified internal
// links as external — see isPathOnlyHref above.
//
// Algorithm: majority-voting per depth. At each level, pick the segment with a
// strict majority (> 50% of remaining candidates) and recurse on that subset.
// Stop on tie or sub-majority. This tolerates outliers — a single
// '/Portals/...' resource link tucked into a menu otherwise built around
// '/USAWC-AFPIMS/...' no longer kills detection.
//
// Relative and absolute forms of the same internal page produce the same
// segments — '/AMSC/News/' and 'https://example.com/AMSC/News/' both become
// ['amsc', 'news'] via normalizeHrefForMatch — so a relative menu and an
// absolute site index match correctly.
export function detectMenuScope(menuForest: SitemapNode[]): string {
  const paths: string[][] = []
  function walk(nodes: SitemapNode[]): void {
    for (const n of nodes) {
      if (n.href && (!n.external || isPathOnlyHref(n.href))) {
        const segs = hrefSegments(normalizeHrefForMatch(n.href))
        if (segs.length > 0) paths.push(segs)
      }
      walk(n.children)
    }
  }
  walk(menuForest)
  if (paths.length === 0) return ''

  const result: string[] = []
  let candidates = paths
  while (candidates.length > 0) {
    const depth = result.length
    const counts = new Map<string, number>()
    for (const p of candidates) {
      if (p.length <= depth) continue
      const seg = p[depth]
      counts.set(seg, (counts.get(seg) ?? 0) + 1)
    }
    if (counts.size === 0) break
    let topSeg: string | null = null
    let topCount = 0
    let tied = false
    for (const [seg, c] of counts) {
      if (c > topCount) { topSeg = seg; topCount = c; tied = false }
      else if (c === topCount) tied = true
    }
    if (tied || topSeg === null) break
    // Strict majority required — guards against committing to a segment that
    // only barely edges out alternatives on noisy small inputs.
    if (topCount * 2 <= candidates.length) break
    result.push(topSeg)
    candidates = candidates.filter(p => p.length > depth && p[depth] === topSeg)
  }
  return result.join('/')
}

function segmentsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Find the first node in `forest` whose normalized-href segments match
// `target`'s segments. Compares by segments (not by string equality) so a
// scope value like 'programs' matches a node whose normalized href is
// '/programs' — the leading slash format differs between detectMenuScope's
// segments-joined output and normalizeHref's relative-path output.
function findNodeByNormalizedHref(forest: SitemapNode[], target: string): SitemapNode | null {
  const targetSegs = hrefSegments(target)
  function walk(nodes: SitemapNode[]): SitemapNode | null {
    for (const n of nodes) {
      if (segmentsEqual(hrefSegments(normalizeHrefForMatch(n.href)), targetSegs)) return n
      const found = walk(n.children)
      if (found) return found
    }
    return null
  }
  return walk(forest)
}

// Restrict the fresh site forest to the subtree implied by `scope`. See diff.ts
// module docs for the algorithm + rationale.
export function filterSiteIndexByScope(
  siteForest: SitemapNode[],
  scope: string,
  menuForest: SitemapNode[],
): SitemapNode[] {
  if (!scope) return siteForest
  const scopeRoot = findNodeByNormalizedHref(siteForest, scope)
  if (!scopeRoot) return siteForest
  const menuHasScopeRoot = findNodeByNormalizedHref(menuForest, scope) !== null
  return menuHasScopeRoot ? [scopeRoot] : scopeRoot.children
}

// Detect whether the parsed menu has the structural signature of a sibling-
// mode rooting: first item is a URL-bearing leaf whose URL matches the
// dominant scope of the forest. Returns the root's index or null.
//
// The per-node "every URL-bearing descendant is strictly under the first
// node's URL" check has been replaced with a single equality against
// detectMenuScope's output. The scope's majority-voting already establishes
// that the bulk of internal hrefs sit under the chosen prefix; outliers
// (e.g. a single '/Portals/Academic-Program-Guide.pdf' tucked into a menu
// otherwise built around '/USAWC-AFPIMS/...') are accepted rather than
// rejecting the whole shape. This also means we don't need to re-check
// first.external — detectMenuScope already handles the bad-external-flag
// case via its path-only fallback.
export function detectSiblingModeRoot(menuForest: SitemapNode[]): { rootIndex: number } | null {
  if (menuForest.length < 2) return null
  const first = menuForest[0]
  if (!first.href || first.children.length > 0) return null
  const scope = detectMenuScope(menuForest)
  if (!scope) return null
  const firstSegs = hrefSegments(normalizeHrefForMatch(first.href))
  const scopeSegs = hrefSegments(scope)
  return segmentsEqual(firstSegs, scopeSegs) ? { rootIndex: 0 } : null
}
