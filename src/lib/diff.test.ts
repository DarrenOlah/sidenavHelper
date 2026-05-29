import { describe, it, expect, beforeEach } from 'vitest'
import {
  diffForests,
  applyDiff,
  detectMenuScope,
  filterSiteIndexByScope,
  detectSiblingModeRoot,
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

describe('detectMenuScope', () => {
  it('returns empty string for an empty forest', () => {
    expect(detectMenuScope([])).toBe('')
  })

  it('returns the common prefix when all hrefs share one', () => {
    const menu = [
      n('r', '/programs/', 'Home'),
      n('a', '/programs/a', 'A'),
      n('b', '/programs/b/x', 'BX'),
    ]
    expect(detectMenuScope(menu)).toBe('programs')
  })

  it('returns the page itself for a single-page menu', () => {
    expect(detectMenuScope([n('a', '/programs/a', 'A')])).toBe('programs/a')
  })

  it('returns empty when top-level branches differ', () => {
    expect(detectMenuScope([n('a', '/a', 'A'), n('b', '/b', 'B')])).toBe('')
  })

  it('ignores external links when computing the scope', () => {
    const menu = [
      n('a', '/programs/a', 'A'),
      { ...n('ext', 'https://other.example.com/x', 'Other'), external: true },
      n('b', '/programs/b', 'B'),
    ]
    expect(detectMenuScope(menu)).toBe('programs')
  })

  it('ignores empty-href categories when computing the scope', () => {
    const menu = [
      cat('cat', 'Resources', []),
      n('a', '/programs/a', 'A'),
      n('b', '/programs/b', 'B'),
    ]
    expect(detectMenuScope(menu)).toBe('programs')
  })

  it('treats segments as atomic (no substring matching)', () => {
    // 'programs-a' and 'programs-b' are different segments — no shared prefix.
    expect(detectMenuScope([n('a', '/programs-a', 'A'), n('b', '/programs-b', 'B')])).toBe('')
  })

  it('uses path-only hrefs even when applySiteUrl misclassified them as external', () => {
    // The USAWC bug: a menu with mostly relative '/USAWC-AFPIMS/...' paths
    // plus a few absolute off-site links. detectSiteUrls picks one of the
    // off-site origins as dominant; applySiteUrl then marks every relative
    // path as external. Without the path-only fallback, scope detection would
    // run only on the two off-site links and return ''.
    const menu = [
      { ...n('home', '/usawc-afpims/', 'Home'), external: true },
      { ...n('about', '/usawc-afpims/about-us/', 'About'), external: true },
      { ...n('strat', '/usawc-afpims/strategic-leadership/', 'Strategic'), external: true },
      { ...n('carl', '/usawc-afpims/carlisle-experience/', 'Carlisle'), external: true },
      { ...n('ext', 'https://press.armywarcollege.edu/', 'Press'), external: false },
    ]
    expect(detectMenuScope(menu)).toBe('usawc-afpims')
  })

  it('tolerates a minority outlier (USAWC /Portals/... in a /USAWC-AFPIMS/* menu)', () => {
    // Majority-voting allows one off-prefix internal link (an Academic Program
    // Guide PDF in /Portals/) to coexist with ~50 in-prefix items. The old
    // LCP algorithm would have returned '' here.
    const menu = [
      n('home', '/usawc-afpims/', 'Home'),
      n('a', '/usawc-afpims/about/', 'About'),
      n('b', '/usawc-afpims/strategic-leadership/', 'Strategic'),
      n('c', '/usawc-afpims/carlisle-experience/', 'Carlisle'),
      n('pdf', '/portals/153/documents/usawc/registrar/guide.pdf', 'Guide'),
    ]
    expect(detectMenuScope(menu)).toBe('usawc-afpims')
  })

  it('returns empty when no segment has a strict majority', () => {
    // Two equally-sized branches with no clear winner.
    const menu = [
      n('a1', '/programs/x', 'X'),
      n('a2', '/programs/y', 'Y'),
      n('b1', '/about/p', 'P'),
      n('b2', '/about/q', 'Q'),
    ]
    expect(detectMenuScope(menu)).toBe('')
  })
})

describe('filterSiteIndexByScope', () => {
  it('returns the site forest unchanged when scope is empty', () => {
    const site = [n('a', '/a', 'A')]
    expect(filterSiteIndexByScope(site, '', [])).toBe(site)
  })

  it('returns [scopeRoot] when the menu also has the scope root', () => {
    const site = [
      n('p', '/programs/', 'Programs', [
        n('p1', '/programs/a', 'A'),
        n('p2', '/programs/b', 'B'),
      ]),
      n('other', '/about', 'About'),
    ]
    const menu = [n('mp', '/programs/', 'Programs Home')]
    const filtered = filterSiteIndexByScope(site, 'programs', menu)
    expect(filtered).toHaveLength(1)
    expect(filtered[0].id).toBe('p')
  })

  it('returns scopeRoot.children when the menu does NOT have the scope root', () => {
    const site = [
      n('p', '/programs/', 'Programs', [
        n('p1', '/programs/a', 'A'),
        n('p2', '/programs/b', 'B'),
      ]),
    ]
    // Menu has only the root's children (rootMode='hide' shape).
    const menu = [n('a', '/programs/a', 'A'), n('b', '/programs/b', 'B')]
    const filtered = filterSiteIndexByScope(site, 'programs', menu)
    expect(filtered.map(f => f.id)).toEqual(['p1', 'p2'])
  })

  it('falls back to the full site forest when scope is not found', () => {
    const site = [n('a', '/a', 'A')]
    const filtered = filterSiteIndexByScope(site, 'programs', [n('m', '/programs/a', 'A')])
    expect(filtered).toBe(site)
  })

  it('matches across relative menu hrefs and absolute site-index hrefs', () => {
    // The user's real-world case: a sibling-mode menu generated in
    // site-root-relative mode (paths like '/AMSC/News/') compared against a
    // freshly-pasted site index whose hrefs are absolute
    // ('https://armyuniversity.army.afpims.mil/AMSC/News/'). Before the fix,
    // matching used host-inclusive normalization so the two forms never
    // collided — every menu page surfaced as 'removed' and every site page
    // as 'added', and the scope filter fell back to the full site forest.
    const menu = [
      n('home', '/AMSC/', 'AMSC Home', [
        n('news', '/AMSC/News/', 'News'),
        n('about', '/AMSC/About/', 'About', [
          n('hist', '/AMSC/About/History/', 'History'),
        ]),
      ]),
    ]
    const site = [
      n('sh', 'https://example.com/', 'Home'),
      n('snews', 'https://example.com/News/', 'News'),
      n('samsc', 'https://example.com/AMSC/', 'AMSC', [
        n('snews2', 'https://example.com/AMSC/News/', 'News'),
        n('sabout', 'https://example.com/AMSC/About/', 'About', [
          n('shist', 'https://example.com/AMSC/About/History/', 'History'),
          n('snew', 'https://example.com/AMSC/About/Mission/', 'Mission'),
        ]),
      ]),
    ]
    const scope = detectMenuScope(menu)
    expect(scope).toBe('amsc')
    const scoped = filterSiteIndexByScope(site, scope, menu)
    // Scope should have found the AMSC node in the site index despite the
    // absolute-URL form; menu has /AMSC/ at top → returns [scopeRoot].
    expect(scoped).toHaveLength(1)
    expect(scoped[0].label).toBe('AMSC')
    const r = diffForests(menu, scoped)
    // The only diff should be the new /AMSC/About/Mission page.
    expect(r.entries.filter(e => e.kind === 'removed')).toEqual([])
    expect(r.entries.filter(e => e.kind === 'moved')).toEqual([])
    const added = r.entries.filter(e => e.kind === 'added')
    expect(added).toHaveLength(1)
    if (added[0].kind !== 'added') throw new Error('bad')
    expect(added[0].siteNode.label).toBe('Mission')
  })

  it('drops off-scope added entries from a full diff', () => {
    // Menu was built from /programs/ root (hide mode — root omitted). Site
    // index includes /programs/ AND /about/. Without scoping, /about would
    // appear as added; /programs/c (a new page in the branch) is the only
    // added entry that should survive scoping.
    const menu = [n('a', '/programs/a', 'A'), n('b', '/programs/b', 'B')]
    const site = [
      n('p', '/programs/', 'Programs', [
        n('a', '/programs/a', 'A'),
        n('b', '/programs/b', 'B'),
        n('c', '/programs/c', 'C'),
      ]),
      n('ab', '/about', 'About'),
    ]
    const scope = detectMenuScope(menu)
    const scoped = filterSiteIndexByScope(site, scope, menu)
    const r = diffForests(menu, scoped)
    const addedHrefs = r.entries
      .filter(e => e.kind === 'added')
      .map(e => (e.kind === 'added' ? e.siteNode.href : ''))
    expect(addedHrefs).toEqual(['/programs/c']) // /about and /programs/ root omitted
  })
})

describe('detectSiblingModeRoot', () => {
  it('returns null for an empty forest', () => {
    expect(detectSiblingModeRoot([])).toBeNull()
  })

  it('returns null for a single-node forest', () => {
    expect(detectSiblingModeRoot([n('a', '/a', 'A')])).toBeNull()
  })

  it('returns { rootIndex: 0 } for a sibling-mode-shaped forest', () => {
    const menu = [
      n('r', '/programs/', 'Programs Home'),
      n('a', '/programs/a', 'A'),
      n('b', '/programs/b/x', 'BX'),
    ]
    expect(detectSiblingModeRoot(menu)).toEqual({ rootIndex: 0 })
  })

  it('returns null when the first node has children (parent mode)', () => {
    const menu = [
      n('r', '/programs/', 'Programs', [n('a', '/programs/a', 'A')]),
      n('b', '/programs/b', 'B'),
    ]
    expect(detectSiblingModeRoot(menu)).toBeNull()
  })

  it('returns null when the first node is external', () => {
    const menu = [
      { ...n('r', 'https://other.example.com/', 'Other'), external: true },
      n('a', '/programs/a', 'A'),
    ]
    expect(detectSiblingModeRoot(menu)).toBeNull()
  })

  it('accepts top-level categories — URL-bearing descendants must be under the root', () => {
    // Users commonly add a "Resources" category at the top level of a
    // sibling-mode menu. Detection must still succeed in that case so the
    // forest is reshaped correctly and compare mode doesn't flag the root's
    // children as moved.
    const menu = [
      n('r', '/programs/', 'Programs Home'),
      cat('cat', 'Resources', [n('rx', '/programs/x', 'X')]),
      n('a', '/programs/a', 'A'),
    ]
    expect(detectSiblingModeRoot(menu)).toEqual({ rootIndex: 0 })
  })

  it('returns null when a URL-bearing descendant of a category is off-prefix', () => {
    // 50/50 split between /programs and /about → scope is empty → reject.
    const menu = [
      n('r', '/programs/', 'Programs Home'),
      cat('cat', 'Resources', [n('off', '/about/x', 'Off')]),
    ]
    expect(detectSiblingModeRoot(menu)).toBeNull()
  })

  it('accepts a single off-prefix outlier when the root prefix dominates', () => {
    // Real-world USAWC case: many in-prefix items plus one /Portals/ PDF link.
    // The old strict per-node check rejected this; the new scope-based check
    // accepts it because the majority of internal hrefs sit under /programs/.
    const menu = [
      n('r', '/programs/', 'Programs Home'),
      n('a', '/programs/a', 'A'),
      n('b', '/programs/b', 'B'),
      n('off', '/portals/guide.pdf', 'Guide'),
    ]
    expect(detectSiblingModeRoot(menu)).toEqual({ rootIndex: 0 })
  })

  it('returns null when off-prefix items prevent any segment from dominating', () => {
    // Equal counts → no majority → no scope → reject.
    const menu = [
      n('r', '/programs/', 'Programs Home'),
      n('off', '/about', 'About'),
    ]
    expect(detectSiblingModeRoot(menu)).toBeNull()
  })

  it('detects sibling-mode even when the first node was misclassified as external', () => {
    // The USAWC bug: applySiteUrl marks the relative '/usawc-afpims/' root as
    // external because detectSiteUrls picked an off-site origin. The new
    // detector relies on detectMenuScope, which uses the path-only fallback,
    // so detection still succeeds and the menu reshapes correctly.
    const menu = [
      { ...n('r', '/usawc-afpims/', 'Home'), external: true },
      { ...n('a', '/usawc-afpims/about-us/', 'About'), external: true },
      { ...n('b', '/usawc-afpims/strategic-leadership/', 'Strategic'), external: true },
    ]
    expect(detectSiblingModeRoot(menu)).toEqual({ rootIndex: 0 })
  })

  it('USAWC end-to-end: bad external flags + off-prefix outlier still reshape + diff cleanly', () => {
    // Reproduces the real bug from the user's screenshot. The pasted menu has:
    //   - mostly path-only /usawc-afpims/* paths (marked external by applySiteUrl
    //     because detectSiteUrls picked an off-site origin)
    //   - one off-prefix /portals/ PDF link
    //   - one absolute external link to https://usawc.org/
    // The site index has the full Army University sitemap.
    // Before the fix: scope was '', filter returned the entire site index, and
    // the diff showed 100+ false 'added' entries and many false 'moved' entries.
    const ext = (node: SitemapNode): SitemapNode => ({ ...node, external: true })
    const menu = [
      ext(n('home', '/usawc-afpims/', 'Home')),
      ext(cat('about', 'About Us', [
        ext(n('ov', '/usawc-afpims/about-us/overview/', 'Overview')),
        ext(n('mi', '/usawc-afpims/about-us/mission/', 'Mission')),
      ])),
      ext(cat('strat', 'Strategic Leadership', [
        ext(n('dde', '/usawc-afpims/strategic-leadership/dde/', 'DDE')),
        ext(n('pdf', '/portals/153/documents/usawc/registrar/guide.pdf', 'Guide')),
      ])),
      // Genuinely-external link, correctly marked external.
      ext(n('extlink', 'https://usawc.org/', 'Foundation')),
    ]
    const site = [
      n('shome', 'https://army.afpims.mil/', 'Home'),
      n('snews', 'https://army.afpims.mil/News/', 'News'),
      n('samsc', 'https://army.afpims.mil/AMSC/', 'AMSC', [
        n('samscnews', 'https://army.afpims.mil/AMSC/News/', 'News'),
      ]),
      n('susawc', 'https://army.afpims.mil/USAWC-AFPIMS/', 'USAWC-AFPIMS', [
        cat('saboutcat', 'About Us', [
          n('sov', 'https://army.afpims.mil/USAWC-AFPIMS/About-Us/Overview/', 'Overview'),
          n('smi', 'https://army.afpims.mil/USAWC-AFPIMS/About-Us/Mission/', 'Mission'),
        ]),
        cat('sstratcat', 'Strategic Leadership', [
          n('sdde', 'https://army.afpims.mil/USAWC-AFPIMS/Strategic-Leadership/DDE/', 'DDE'),
        ]),
      ]),
    ]

    // Step 1: detectSiblingModeRoot succeeds (was failing — first.external blocked it).
    const sibling = detectSiblingModeRoot(menu)
    expect(sibling).toEqual({ rootIndex: 0 })

    // Step 2: reshape — pull Home out, nest the rest under it.
    const root = menu[sibling!.rootIndex]
    const rest = menu.filter((_, i) => i !== sibling!.rootIndex)
    const reshaped = [{ ...root, children: rest }]

    // Step 3: scope detection finds the right prefix.
    const scope = detectMenuScope(reshaped)
    expect(scope).toBe('usawc-afpims')

    // Step 4: scoped filter restricts to the USAWC-AFPIMS subtree.
    const scoped = filterSiteIndexByScope(site, scope, reshaped)
    expect(scoped).toHaveLength(1)
    expect(scoped[0].label).toBe('USAWC-AFPIMS')

    // Step 5: diff produces no false adds (AMSC, News, Home outside scope are filtered out)
    // and no false moves (menu Overview now under Home, urlPath = ['/usawc-afpims']
    // matches site Overview's urlPath = ['/usawc-afpims']).
    const r = diffForests(reshaped, scoped)
    expect(r.entries.filter(e => e.kind === 'moved')).toEqual([])
    // The only added/removed entries should be the legitimate ones (the
    // /portals/ PDF and the external Foundation link aren't in the scoped site
    // index — those surface as 'removed', which the user can reject).
    const added = r.entries.filter(e => e.kind === 'added')
    expect(added).toEqual([])
  })

  it('produces zero moved entries after reshape against a matching site index', () => {
    // The bug this fix addresses: a sibling-mode menu compared structurally
    // against the site index produces phantom 'moved' entries.
    const flatMenu = [
      n('r', '/programs/', 'Programs'),
      n('a', '/programs/a', 'A'),
      n('b', '/programs/b', 'B'),
    ]
    const sibling = detectSiblingModeRoot(flatMenu)!
    expect(sibling).toEqual({ rootIndex: 0 })
    // Reshape: pull root out and nest the rest as its children.
    const root = flatMenu[sibling.rootIndex]
    const rest = flatMenu.filter((_, i) => i !== sibling.rootIndex)
    const reshaped = [{ ...root, children: rest }]
    // Site index has the matching shape (root with children nested).
    const site = [
      n('sr', '/programs/', 'Programs', [
        n('sa', '/programs/a', 'A'),
        n('sb', '/programs/b', 'B'),
      ]),
    ]
    const scope = detectMenuScope(reshaped)
    const scoped = filterSiteIndexByScope(site, scope, reshaped)
    const r = diffForests(reshaped, scoped)
    expect(r.entries.filter(e => e.kind === 'moved')).toEqual([])
    expect(r.entries).toEqual([]) // no diff entries at all
  })
})
