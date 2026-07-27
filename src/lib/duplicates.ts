// Detect links that collide under au-sidenav's "you are here" matcher.
//
// sidenav.js's findCurrentLink returns on the FIRST exact match in document
// order, then walks up marking that occurrence's ancestors with
// --current-section and auto-expanding them. So when two <a>s in one menu
// resolve to the same path, the second is permanently unreachable and visiting
// it highlights + expands the WRONG branch.
//
// The comparison sidenav.js performs is path-only — normalizePath() runs
// `new URL(href, window.location.origin).pathname`, which DISCARDS the host.
// This module must mirror that function exactly; neither normalizeHref
// (host-aware) nor normalizeHrefForMatch (keeps ?search, no forced trailing
// slash) produces the same buckets.

import type { SitemapNode } from './sitemap'

export type DuplicateSeverity = 'error' | 'warning'

export interface DuplicateGroup {
  // The normalized path the colliding links share.
  path: string
  // Every node in the group, in menu document order. nodes[0] is the one
  // sidenav.js will actually select; the rest are unreachable.
  nodes: SitemapNode[]
  severity: DuplicateSeverity
}

// Base used to resolve relative hrefs. Only the pathname is read, so the host
// is arbitrary — it just has to parse. sidenav.js uses window.location.origin
// for the same purpose.
const RESOLVE_BASE = 'https://sidenav.invalid'

// Mirror of normalizePath() in src/vendor/au-sidenav/sidenav.js. Keep the two
// in sync: this is the function that decides whether two links collide at
// runtime.
export function normalizeMenuPath(href: string): string {
  if (!href) return ''
  try {
    const u = new URL(href, RESOLVE_BASE)
    let path = u.pathname.toLowerCase()
    if (path.length > 1 && !path.endsWith('/')) path += '/'
    return path
  } catch {
    return href.toLowerCase()
  }
}

// Walk the forest in document order, visiting only nodes that will survive
// into the generated output. generateSidenavHtml drops any node with
// included === false along with its whole subtree, so an excluded branch can't
// produce a runtime collision.
function collectRenderedLinks(roots: SitemapNode[]): SitemapNode[] {
  const out: SitemapNode[] = []
  function walk(nodes: SitemapNode[]): void {
    for (const n of nodes) {
      if (!n.included) continue
      // Empty href renders as <span class="au-sidenav__text">, not an anchor,
      // so it never participates in findCurrentLink.
      if (n.href.trim() !== '') out.push(n)
      walk(n.children)
    }
  }
  walk(roots)
  return out
}

// Group rendered links by the path sidenav.js will compare them on, and report
// the groups that actually cause a problem.
//
// Severity:
//   'error'   — two or more INTERNAL links share a path. The second is dead and
//               the wrong section expands. This is the case worth shouting about.
//   'warning' — an internal and an external link share a path. Rarer, sometimes
//               deliberate, but the host-discarding comparison still collides them.
//
// External-only groups are NOT reported. Off-site links commonly point at a
// host root ('https://usawc.org/', 'https://warroom.armywarcollege.edu/'), so
// they all normalize to '/' — expected, harmless in practice, and flagging it
// would be pure noise.
export function findDuplicateLinks(roots: SitemapNode[]): DuplicateGroup[] {
  const byPath = new Map<string, SitemapNode[]>()
  const order: string[] = []
  for (const node of collectRenderedLinks(roots)) {
    const path = normalizeMenuPath(node.href)
    if (!path) continue
    const list = byPath.get(path)
    if (list) list.push(node)
    else {
      byPath.set(path, [node])
      order.push(path)
    }
  }

  const groups: DuplicateGroup[] = []
  for (const path of order) {
    const nodes = byPath.get(path)!
    if (nodes.length < 2) continue
    const internalCount = nodes.filter(n => !n.external).length
    if (internalCount === 0) continue // external-only — not reported
    groups.push({ path, nodes, severity: internalCount >= 2 ? 'error' : 'warning' })
  }
  return groups
}

// Ids of every link that sidenav.js will never be able to select because an
// earlier link in the menu claims the same path. Lets the UI mark the losing
// rows without re-deriving the grouping.
export function unreachableLinkIds(groups: DuplicateGroup[]): Set<string> {
  const ids = new Set<string>()
  for (const g of groups) {
    for (let i = 1; i < g.nodes.length; i++) ids.add(g.nodes[i].id)
  }
  return ids
}
