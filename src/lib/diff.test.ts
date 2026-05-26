import { describe, it, expect, beforeEach } from 'vitest'
import {
  diffForests,
  applyDiff,
  __resetCloneCounter,
  type DiffEntry,
} from './diff'
import { findNode, type SitemapNode } from './sitemap'

// Small fixture helpers tuned for diff tests. `href` is required (use n for
// URL-bearing pages and cat for empty-href logical categories).
function n(id: string, href: string, label: string, children: SitemapNode[] = []): SitemapNode {
  return { id, href, defaultLabel: label, label, included: true, children }
}
function cat(id: string, label: string, children: SitemapNode[]): SitemapNode {
  return { id, href: '', defaultLabel: label, label, included: true, children }
}

beforeEach(() => {
  __resetCloneCounter()
})

describe('diffForests — basic cases', () => {
  it('produces zero entries for identical trees', () => {
    const tree = [n('a', '/a', 'A'), n('b', '/b', 'B', [n('b1', '/b/1', 'B1')])]
    const menu = JSON.parse(JSON.stringify(tree))
    const site = JSON.parse(JSON.stringify(tree))
    const r = diffForests(menu, site)
    expect(r.entries).toEqual([])
    expect(r.matched).toHaveLength(3)
  })

  it('detects an added page and points it at the URL-matched menu parent', () => {
    const menu = [n('a', '/a', 'A', [n('a1', '/a/1', 'A1')])]
    const site = [n('sa', '/a', 'A', [n('sa1', '/a/1', 'A1'), n('sa2', '/a/2', 'A2')])]
    const r = diffForests(menu, site)
    const added = r.entries.filter(e => e.kind === 'added')
    expect(added).toHaveLength(1)
    const e = added[0]
    if (e.kind !== 'added') throw new Error('bad')
    expect(e.siteNode.href).toBe('/a/2')
    expect(e.suggestedMenuParentId).toBe('a')
    expect(e.suggestedMenuParentLabel).toBe('A')
  })

  it('detects a removed page', () => {
    const menu = [n('a', '/a', 'A'), n('b', '/b', 'B')]
    const site = [n('sa', '/a', 'A')]
    const r = diffForests(menu, site)
    const removed = r.entries.filter(e => e.kind === 'removed')
    expect(removed).toHaveLength(1)
    const e = removed[0]
    if (e.kind !== 'removed') throw new Error('bad')
    expect(e.menuNode.id).toBe('b')
  })

  it('detects a renamed page (same href, different label)', () => {
    const menu = [n('a', '/a', 'About Us')]
    const site = [n('sa', '/a', 'About')]
    const r = diffForests(menu, site)
    const renamed = r.entries.filter(e => e.kind === 'renamed')
    expect(renamed).toHaveLength(1)
    const e = renamed[0]
    if (e.kind !== 'renamed') throw new Error('bad')
    expect(e.menuNode.id).toBe('a')
    expect(e.siteLabel).toBe('About')
  })

  it('detects a move when the URL-bearing parent differs', () => {
    const menu = [
      n('a', '/a', 'A', [n('p', '/p', 'Page')]),
      n('b', '/b', 'B'),
    ]
    const site = [
      n('sa', '/a', 'A'),
      n('sb', '/b', 'B', [n('sp', '/p', 'Page')]),
    ]
    const r = diffForests(menu, site)
    const moved = r.entries.filter(e => e.kind === 'moved')
    expect(moved).toHaveLength(1)
    const e = moved[0]
    if (e.kind !== 'moved') throw new Error('bad')
    expect(e.menuNode.id).toBe('p')
    expect(e.fromMenuParentId).toBe('a')
    expect(e.toMenuParentId).toBe('b')
    expect(e.toMenuParentLabel).toBe('B')
  })
})

describe('diffForests — logical categories', () => {
  it('does not flag a menu-only logical category as removed', () => {
    const menu = [cat('cat', 'Resources', [n('p', '/p', 'Page')])]
    const site = [n('sp', '/p', 'Page')]
    const r = diffForests(menu, site)
    expect(r.entries.filter(e => e.kind === 'removed')).toEqual([])
    expect(r.unmatchedMenuCategories.map(c => c.id)).toEqual(['cat'])
  })

  it('does NOT flag a move when the only difference is a menu-only category in the path', () => {
    // Menu: [Resources(no url) > Page(/p)]
    // Site: [Page(/p) at top]
    // URL-bearing path for menu side: [] (Resources is skipped — no href)
    // URL-bearing path for site side: []
    // → no move.
    const menu = [cat('cat', 'Resources', [n('p', '/p', 'Page')])]
    const site = [n('sp', '/p', 'Page')]
    const r = diffForests(menu, site)
    expect(r.entries.filter(e => e.kind === 'moved')).toEqual([])
  })

  it('flags a real move (different URL parent) even when categories are present', () => {
    const menu = [
      cat('cat', 'Resources', [n('p', '/p', 'Page')]),
      n('a', '/a', 'A'),
    ]
    const site = [n('sa', '/a', 'A', [n('sp', '/p', 'Page')])]
    const r = diffForests(menu, site)
    const moved = r.entries.filter(e => e.kind === 'moved')
    expect(moved).toHaveLength(1)
    const e = moved[0]
    if (e.kind !== 'moved') throw new Error('bad')
    expect(e.toMenuParentId).toBe('a')
  })
})

describe('diffForests — label fallback', () => {
  it('matches by label when URLs differ; does not emit renamed', () => {
    const menu = [n('a', '/old-path', 'Contact Us')]
    const site = [n('sa', '/new-path', 'Contact Us')]
    const r = diffForests(menu, site)
    // label-fallback match → no renamed (labels are equal)
    expect(r.entries.filter(e => e.kind === 'renamed')).toEqual([])
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].matchedBy).toBe('label')
    // Same URL-bearing path (both top-level), so no moved either.
    expect(r.entries.filter(e => e.kind === 'moved')).toEqual([])
  })

  it('does NOT match ambiguously when multiple unmatched nodes share a label', () => {
    const menu = [n('a1', '/x', 'Overview'), n('a2', '/y', 'Overview')]
    const site = [n('s1', '/p', 'Overview'), n('s2', '/q', 'Overview')]
    const r = diffForests(menu, site)
    // No URL matches. Label fallback skipped due to ambiguity. → all four become added/removed.
    expect(r.matched).toEqual([])
    expect(r.entries.filter(e => e.kind === 'added')).toHaveLength(2)
    expect(r.entries.filter(e => e.kind === 'removed')).toHaveLength(2)
  })
})

describe('diffForests — edge cases', () => {
  it('handles duplicate URLs by pairing in DFS order', () => {
    const menu = [n('a', '/x', 'A1'), n('b', '/x', 'B1')]
    const site = [n('sa', '/x', 'A1')]
    const r = diffForests(menu, site)
    expect(r.matched).toHaveLength(1)
    expect(r.matched[0].menuNode.id).toBe('a')
    // Second menu /x has no site counterpart → removed
    const removed = r.entries.filter(e => e.kind === 'removed')
    expect(removed).toHaveLength(1)
    if (removed[0].kind !== 'removed') throw new Error('bad')
    expect(removed[0].menuNode.id).toBe('b')
  })

  it('case-insensitive URL matching', () => {
    const menu = [n('a', '/About', 'About')]
    const site = [n('sa', '/about', 'About')]
    const r = diffForests(menu, site)
    expect(r.matched).toHaveLength(1)
    expect(r.entries).toEqual([])
  })

  it('still diffs nodes with included:false', () => {
    const menu = [{ ...n('a', '/a', 'A'), included: false }]
    const site = [n('sa', '/a', 'About')]
    const r = diffForests(menu, site)
    const renamed = r.entries.filter(e => e.kind === 'renamed')
    expect(renamed).toHaveLength(1)
  })

  it('skips empty-href nodes (treated as categories) in matching', () => {
    // Hash-only/javascript: hrefs are stripped to '' by parseSitemapHtml.
    // Such nodes must NOT produce phantom matches or diff entries.
    const menu = [cat('m1', 'Header', [])]
    const site = [cat('s1', 'Header', [])]
    const r = diffForests(menu, site)
    expect(r.entries).toEqual([])
    expect(r.matched).toEqual([])
    expect(r.unmatchedMenuCategories.map(c => c.id)).toEqual(['m1'])
  })
})

describe('applyDiff', () => {
  function buildScenarioForRename(): [SitemapNode[], DiffEntry] {
    const menu = [n('a', '/a', 'About Us')]
    const site = [n('sa', '/a', 'About')]
    const r = diffForests(menu, site)
    return [menu, r.entries[0]]
  }

  it('rename preserves defaultLabel and updates label', () => {
    const [menu, entry] = buildScenarioForRename()
    const after = applyDiff(menu, entry)
    const node = findNode(after, 'a')!
    expect(node.label).toBe('About')
    expect(node.defaultLabel).toBe('About Us')
  })

  it('remove deletes the node + subtree', () => {
    const menu = [n('a', '/a', 'A', [n('a1', '/a/1', 'A1')]), n('b', '/b', 'B')]
    const site = [n('sb', '/b', 'B')]
    const r = diffForests(menu, site)
    const removeEntry = r.entries.find(e => e.kind === 'removed')!
    const after = applyDiff(menu, removeEntry)
    expect(findNode(after, 'a')).toBeNull()
    expect(findNode(after, 'a1')).toBeNull()
    expect(findNode(after, 'b')).not.toBeNull()
  })

  it('added clones with fresh d-prefixed ids and inserts under the suggested parent', () => {
    const menu = [n('a', '/a', 'A')]
    const site = [n('sa', '/a', 'A', [n('sa1', '/a/1', 'A1', [n('sa1a', '/a/1/a', 'A1a')])])]
    const r = diffForests(menu, site)
    const addEntry = r.entries.find(e => e.kind === 'added')!
    const after = applyDiff(menu, addEntry)
    const a = findNode(after, 'a')!
    expect(a.children).toHaveLength(1)
    const inserted = a.children[0]
    expect(inserted.id).toMatch(/^d\d+$/)
    expect(inserted.label).toBe('A1')
    expect(inserted.children[0].id).toMatch(/^d\d+$/)
    expect(inserted.children[0].label).toBe('A1a')
    // Ids should be distinct between root and child of the inserted subtree.
    expect(inserted.id).not.toBe(inserted.children[0].id)
  })

  it('added falls back to top-of-menu when the suggested parent no longer exists', () => {
    const menu = [n('a', '/a', 'A')]
    const site = [n('sa', '/a', 'A', [n('sa1', '/a/1', 'A1')])]
    const r = diffForests(menu, site)
    const addEntry = r.entries.find(e => e.kind === 'added')!
    // Simulate the user already removed 'a' before accepting the add.
    const afterRemove: SitemapNode[] = []
    const after = applyDiff(afterRemove, addEntry)
    expect(after).toHaveLength(1)
    expect(after[0].label).toBe('A1')
  })

  it('moved preserves the node\'s current children and re-parents it', () => {
    // Menu: A > Page(with custom child); B
    // Site: A; B > Page
    // After accepting move: B > Page(with custom child) and A childless.
    const customChild = n('px', '/p/x', 'Page-X')
    const menu = [
      n('a', '/a', 'A', [n('p', '/p', 'Page', [customChild])]),
      n('b', '/b', 'B'),
    ]
    const site = [n('sa', '/a', 'A'), n('sb', '/b', 'B', [n('sp', '/p', 'Page')])]
    const r = diffForests(menu, site)
    const moveEntry = r.entries.find(e => e.kind === 'moved')!
    const after = applyDiff(menu, moveEntry)
    expect(findNode(after, 'a')!.children).toEqual([])
    const movedPage = findNode(after, 'p')!
    expect(movedPage.children.map(c => c.id)).toEqual(['px'])
    expect(findNode(after, 'b')!.children.map(c => c.id)).toEqual(['p'])
  })

  it('is a no-op when the entry target no longer exists', () => {
    const menu = [n('a', '/a', 'A')]
    const stale: DiffEntry = {
      kind: 'removed',
      id: 'remove:ghost',
      menuNode: n('ghost', '/g', 'Ghost'),
    }
    const after = applyDiff(menu, stale)
    expect(after).toBe(menu)
  })
})
