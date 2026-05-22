import { describe, it, expect } from 'vitest'
import {
  findNode,
  findParent,
  renameNode,
  setIncluded,
  reorderSiblings,
  promoteNode,
  demoteNode,
  selectSubtree,
  addChild,
  addSiblingAfter,
  removeNode,
  setHref,
  setExternal,
  detectSiteUrl,
  detectSiteUrls,
  applySiteUrl,
  isValidSiteUrl,
  makeNode,
  type SitemapNode,
} from './sitemap'

function leaf(id: string, label: string): SitemapNode {
  return { id, href: '/' + id, defaultLabel: label, label, included: true, children: [] }
}

function parent(id: string, label: string, children: SitemapNode[]): SitemapNode {
  return { id, href: '/' + id, defaultLabel: label, label, included: true, children }
}

function buildSampleForest(): SitemapNode[] {
  return [
    parent('a', 'A', [
      leaf('a1', 'A1'),
      parent('a2', 'A2', [leaf('a2a', 'A2a')]),
    ]),
    leaf('b', 'B'),
    leaf('c', 'C'),
  ]
}

describe('findNode / findParent', () => {
  it('finds top-level nodes', () => {
    const forest = buildSampleForest()
    expect(findNode(forest, 'a')?.label).toBe('A')
    expect(findNode(forest, 'b')?.label).toBe('B')
  })

  it('finds deeply nested nodes', () => {
    const forest = buildSampleForest()
    expect(findNode(forest, 'a2a')?.label).toBe('A2a')
  })

  it('returns null for unknown ids', () => {
    expect(findNode(buildSampleForest(), 'nope')).toBeNull()
    expect(findParent(buildSampleForest(), 'nope')).toBeNull()
  })

  it('findParent returns the immediate parent', () => {
    const forest = buildSampleForest()
    expect(findParent(forest, 'a1')?.id).toBe('a')
    expect(findParent(forest, 'a2a')?.id).toBe('a2')
  })

  it('findParent returns null for top-level nodes', () => {
    expect(findParent(buildSampleForest(), 'a')).toBeNull()
  })
})

describe('renameNode', () => {
  it('updates label while leaving defaultLabel untouched', () => {
    const forest = buildSampleForest()
    const next = renameNode(forest, 'a1', 'Renamed A1')
    const node = findNode(next, 'a1')!
    expect(node.label).toBe('Renamed A1')
    expect(node.defaultLabel).toBe('A1')
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    renameNode(forest, 'a1', 'changed')
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('setIncluded', () => {
  it('cascades exclusion to descendants', () => {
    const forest = buildSampleForest()
    const next = setIncluded(forest, 'a', false)
    expect(findNode(next, 'a')?.included).toBe(false)
    expect(findNode(next, 'a1')?.included).toBe(false)
    expect(findNode(next, 'a2a')?.included).toBe(false)
    expect(findNode(next, 'b')?.included).toBe(true)
  })

  it('cascades re-inclusion to descendants', () => {
    let forest = setIncluded(buildSampleForest(), 'a', false)
    forest = setIncluded(forest, 'a', true)
    expect(findNode(forest, 'a')?.included).toBe(true)
    expect(findNode(forest, 'a2a')?.included).toBe(true)
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    setIncluded(forest, 'a', false)
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('reorderSiblings', () => {
  it('reorders top-level when parentId is null', () => {
    const forest = buildSampleForest()
    const next = reorderSiblings(forest, null, 0, 2)
    expect(next.map(n => n.id)).toEqual(['b', 'c', 'a'])
  })

  it('reorders within a parent', () => {
    const forest = buildSampleForest()
    const next = reorderSiblings(forest, 'a', 0, 1)
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a2', 'a1'])
  })

  it('returns the same forest when from === to', () => {
    const forest = buildSampleForest()
    const next = reorderSiblings(forest, null, 1, 1)
    expect(next.map(n => n.id)).toEqual(forest.map(n => n.id))
  })

  it('clamps an out-of-bounds toIndex to the end', () => {
    const forest = buildSampleForest()
    const next = reorderSiblings(forest, null, 0, 99)
    expect(next.map(n => n.id)).toEqual(['b', 'c', 'a'])
  })
})

describe('selectSubtree', () => {
  it('returns the chosen subtree wrapped in a one-element forest', () => {
    const forest = buildSampleForest()
    const next = selectSubtree(forest, 'a2')
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('a2')
    expect(next[0].children[0].id).toBe('a2a')
  })

  it('returns the original forest when id is unknown', () => {
    const forest = buildSampleForest()
    expect(selectSubtree(forest, 'nope')).toBe(forest)
  })
})

describe('makeNode', () => {
  it('creates a node with a generated id and the given label/href', () => {
    const n = makeNode('Hello', '/hi/')
    expect(n.id).toMatch(/^n\d+$/)
    expect(n.label).toBe('Hello')
    expect(n.defaultLabel).toBe('Hello')
    expect(n.href).toBe('/hi/')
    expect(n.included).toBe(true)
    expect(n.children).toEqual([])
  })

  it('uses sensible defaults', () => {
    const n = makeNode()
    expect(n.label).toBe('New page')
    expect(n.href).toBe('')
  })
})

describe('addChild', () => {
  it('appends to the top level when parentId is null', () => {
    const forest = buildSampleForest()
    const node = leaf('new', 'New')
    const next = addChild(forest, null, node)
    expect(next.map(n => n.id)).toEqual(['a', 'b', 'c', 'new'])
  })

  it('appends to a named parent', () => {
    const forest = buildSampleForest()
    const node = leaf('new', 'New')
    const next = addChild(forest, 'a', node)
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a1', 'a2', 'new'])
  })

  it('appends to a deeply nested parent', () => {
    const forest = buildSampleForest()
    const node = leaf('new', 'New')
    const next = addChild(forest, 'a2', node)
    expect(findNode(next, 'a2')?.children.map(c => c.id)).toEqual(['a2a', 'new'])
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    addChild(forest, 'a', leaf('new', 'New'))
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('addSiblingAfter', () => {
  it('inserts after a top-level sibling', () => {
    const forest = buildSampleForest()
    const next = addSiblingAfter(forest, 'b', leaf('new', 'New'))
    expect(next.map(n => n.id)).toEqual(['a', 'b', 'new', 'c'])
  })

  it('inserts after a nested sibling', () => {
    const forest = buildSampleForest()
    const next = addSiblingAfter(forest, 'a1', leaf('new', 'New'))
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a1', 'new', 'a2'])
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    addSiblingAfter(forest, 'a1', leaf('new', 'New'))
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('removeNode', () => {
  it('removes a top-level leaf', () => {
    const forest = buildSampleForest()
    const next = removeNode(forest, 'b')
    expect(next.map(n => n.id)).toEqual(['a', 'c'])
  })

  it('removes a nested leaf', () => {
    const forest = buildSampleForest()
    const next = removeNode(forest, 'a1')
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a2'])
    expect(findNode(next, 'a1')).toBeNull()
  })

  it('removes an internal node along with its subtree', () => {
    const forest = buildSampleForest()
    const next = removeNode(forest, 'a2')
    expect(findNode(next, 'a2')).toBeNull()
    expect(findNode(next, 'a2a')).toBeNull()
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a1'])
  })

  it('returns an unchanged forest for unknown ids', () => {
    const forest = buildSampleForest()
    const next = removeNode(forest, 'nope')
    expect(next.map(n => n.id)).toEqual(forest.map(n => n.id))
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    removeNode(forest, 'a2')
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('setHref', () => {
  it('updates href on the named node only', () => {
    const forest = buildSampleForest()
    const next = setHref(forest, 'a1', '/new/')
    expect(findNode(next, 'a1')?.href).toBe('/new/')
    expect(findNode(next, 'a2')?.href).toBe('/a2')
    expect(findNode(next, 'b')?.href).toBe('/b')
  })

  it('updates href on a deeply nested node', () => {
    const forest = buildSampleForest()
    const next = setHref(forest, 'a2a', '/deep/')
    expect(findNode(next, 'a2a')?.href).toBe('/deep/')
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    setHref(forest, 'a1', '/new/')
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('promoteNode', () => {
  it('promotes a child to sit immediately after its parent', () => {
    const forest = buildSampleForest()
    const next = promoteNode(forest, 'a1')
    // 'a1' was the first child of 'a'; promoting it lifts it to top level
    // right after 'a'.
    expect(next.map(n => n.id)).toEqual(['a', 'a1', 'b', 'c'])
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a2'])
  })

  it('promotes a deeply nested node up one level', () => {
    const forest = buildSampleForest()
    const next = promoteNode(forest, 'a2a')
    // 'a2a' lifts from a.a2.[a2a] up to a.[a2, a2a]
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a1', 'a2', 'a2a'])
    expect(findNode(next, 'a2')?.children).toEqual([])
  })

  it('is a no-op for top-level nodes', () => {
    const forest = buildSampleForest()
    const next = promoteNode(forest, 'a')
    expect(next).toBe(forest)
  })

  it('preserves the promoted node subtree intact', () => {
    const forest = buildSampleForest()
    const next = promoteNode(forest, 'a2')
    expect(findNode(next, 'a2')?.children.map(c => c.id)).toEqual(['a2a'])
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    promoteNode(forest, 'a2a')
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('demoteNode', () => {
  it('moves a node into its previous siblings children', () => {
    const forest = buildSampleForest()
    const next = demoteNode(forest, 'c')
    // 'c' (idx 2 at top) demotes into 'b' (its previous sibling).
    expect(next.map(n => n.id)).toEqual(['a', 'b'])
    expect(findNode(next, 'b')?.children.map(c => c.id)).toEqual(['c'])
  })

  it('demotes a nested node into its previous sibling', () => {
    const forest = buildSampleForest()
    const next = demoteNode(forest, 'a2')
    // 'a2' (idx 1 under 'a') demotes into 'a1'.
    expect(findNode(next, 'a')?.children.map(c => c.id)).toEqual(['a1'])
    expect(findNode(next, 'a1')?.children.map(c => c.id)).toEqual(['a2'])
    // The subtree carries with it.
    expect(findNode(next, 'a2a')).not.toBeNull()
  })

  it('is a no-op for the first sibling at any level', () => {
    const forest = buildSampleForest()
    expect(demoteNode(forest, 'a')).toBe(forest)
    expect(demoteNode(forest, 'a1')).toBe(forest)
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    demoteNode(forest, 'c')
    expect(JSON.stringify(forest)).toBe(original)
  })
})

describe('setExternal', () => {
  it('marks a node as external', () => {
    const forest = buildSampleForest()
    const next = setExternal(forest, 'a1', true)
    expect(findNode(next, 'a1')?.external).toBe(true)
    expect(findNode(next, 'a2')?.external).toBeUndefined()
  })

  it('clears the external flag', () => {
    let forest = setExternal(buildSampleForest(), 'a1', true)
    forest = setExternal(forest, 'a1', false)
    expect(findNode(forest, 'a1')?.external).toBe(false)
  })

  it('does not mutate the input forest', () => {
    const forest = buildSampleForest()
    const original = JSON.stringify(forest)
    setExternal(forest, 'a1', true)
    expect(JSON.stringify(forest)).toBe(original)
  })
})

function nodeWithHref(id: string, href: string, children: SitemapNode[] = []): SitemapNode {
  return { id, href, defaultLabel: id, label: id, included: true, children }
}

describe('detectSiteUrl', () => {
  it('returns the most common origin with a trailing slash', () => {
    const forest = [
      nodeWithHref('1', 'https://www.army.edu/about'),
      nodeWithHref('2', 'https://www.army.edu/contact'),
      nodeWithHref('3', 'https://www.army.edu/news'),
      nodeWithHref('4', 'https://other.example.com/foo'),
    ]
    expect(detectSiteUrl(forest)).toBe('https://www.army.edu/')
  })

  it('counts origins across nested children', () => {
    const forest = [
      nodeWithHref('1', 'https://other.example.com/x', [
        nodeWithHref('1a', 'https://www.army.edu/a'),
        nodeWithHref('1b', 'https://www.army.edu/b'),
      ]),
      nodeWithHref('2', 'https://www.army.edu/c'),
    ]
    expect(detectSiteUrl(forest)).toBe('https://www.army.edu/')
  })

  it('returns empty string when no node has a parseable absolute href', () => {
    const forest = [
      nodeWithHref('1', '/relative/path'),
      nodeWithHref('2', ''),
    ]
    expect(detectSiteUrl(forest)).toBe('')
  })

  it('returns empty string for an empty forest', () => {
    expect(detectSiteUrl([])).toBe('')
  })

  it('tie-break: first origin encountered in tree order wins', () => {
    const forest = [
      nodeWithHref('1', 'https://first.example.com/a'),
      nodeWithHref('2', 'https://second.example.com/b'),
    ]
    expect(detectSiteUrl(forest)).toBe('https://first.example.com/')
  })

  it('ignores nodes with empty hrefs when tallying', () => {
    const forest = [
      nodeWithHref('1', ''),
      nodeWithHref('2', 'https://www.army.edu/a'),
    ]
    expect(detectSiteUrl(forest)).toBe('https://www.army.edu/')
  })
})

describe('detectSiteUrls', () => {
  it('returns every distinct origin ranked by frequency descending', () => {
    const forest = [
      nodeWithHref('1', 'https://www.army.edu/about'),
      nodeWithHref('2', 'https://other.example.com/x'),
      nodeWithHref('3', 'https://www.army.edu/contact'),
      nodeWithHref('4', 'https://www.army.edu/news'),
      nodeWithHref('5', 'https://docs.army.edu/api'),
    ]
    expect(detectSiteUrls(forest)).toEqual([
      'https://www.army.edu/',
      'https://other.example.com/',
      'https://docs.army.edu/',
    ])
  })

  it('tie-break preserves first-encountered tree order', () => {
    const forest = [
      nodeWithHref('1', 'https://first.example.com/a'),
      nodeWithHref('2', 'https://second.example.com/b'),
      nodeWithHref('3', 'https://third.example.com/c'),
    ]
    expect(detectSiteUrls(forest)).toEqual([
      'https://first.example.com/',
      'https://second.example.com/',
      'https://third.example.com/',
    ])
  })

  it('returns [] when no node has a parseable absolute href', () => {
    expect(detectSiteUrls([nodeWithHref('1', '/relative')])).toEqual([])
    expect(detectSiteUrls([])).toEqual([])
  })

  it('every result ends with a trailing slash', () => {
    const forest = [
      nodeWithHref('1', 'https://www.army.edu/about'),
      nodeWithHref('2', 'https://other.example.com/x'),
    ]
    for (const url of detectSiteUrls(forest)) {
      expect(url.endsWith('/')).toBe(true)
    }
  })
})

describe('isValidSiteUrl', () => {
  it('blank is invalid (a site URL is required)', () => {
    expect(isValidSiteUrl('')).toBe(false)
  })

  it('full URL with trailing slash is valid', () => {
    expect(isValidSiteUrl('https://www.army.edu/')).toBe(true)
  })

  it('full URL with a path + trailing slash is valid', () => {
    expect(isValidSiteUrl('https://www.army.edu/about/')).toBe(true)
  })

  it('rejects URL without trailing slash', () => {
    expect(isValidSiteUrl('https://www.army.edu')).toBe(false)
  })

  it('rejects partial host (no trailing slash)', () => {
    expect(isValidSiteUrl('https://www.army')).toBe(false)
  })

  it('rejects non-URL strings', () => {
    expect(isValidSiteUrl('not a url')).toBe(false)
  })

  it('rejects a relative path (URL constructor needs a base)', () => {
    expect(isValidSiteUrl('/relative/')).toBe(false)
  })
})

describe('applySiteUrl', () => {
  it('marks hrefs not starting with siteUrl as external', () => {
    const forest = [
      nodeWithHref('1', 'https://www.army.edu/about'),
      nodeWithHref('2', 'https://other.example.com/x'),
    ]
    const result = applySiteUrl(forest, 'https://www.army.edu/')
    expect(findNode(result, '1')?.external).toBe(false)
    expect(findNode(result, '2')?.external).toBe(true)
  })

  it('recurses into children', () => {
    const forest = [
      nodeWithHref('1', 'https://www.army.edu/a', [
        nodeWithHref('1a', 'https://other.example.com/y'),
        nodeWithHref('1b', 'https://www.army.edu/b'),
      ]),
    ]
    const result = applySiteUrl(forest, 'https://www.army.edu/')
    expect(findNode(result, '1a')?.external).toBe(true)
    expect(findNode(result, '1b')?.external).toBe(false)
  })

  it('leaves empty-href (plain-text) rows alone', () => {
    const forest = [
      nodeWithHref('1', ''),
      nodeWithHref('2', 'https://other.example.com/x'),
    ]
    const result = applySiteUrl(forest, 'https://www.army.edu/')
    expect(findNode(result, '1')?.external).toBeUndefined()
    expect(findNode(result, '2')?.external).toBe(true)
  })

  it('blank siteUrl treats every link as internal', () => {
    const forest = [
      nodeWithHref('1', 'https://www.army.edu/a'),
      nodeWithHref('2', 'https://other.example.com/x'),
    ]
    const result = applySiteUrl(forest, '')
    expect(findNode(result, '1')?.external).toBe(false)
    expect(findNode(result, '2')?.external).toBe(false)
  })

  it('overwrites prior external flags', () => {
    const forest = [
      { ...nodeWithHref('1', 'https://www.army.edu/a'), external: true },
      { ...nodeWithHref('2', 'https://other.example.com/x'), external: false },
    ]
    const result = applySiteUrl(forest, 'https://www.army.edu/')
    expect(findNode(result, '1')?.external).toBe(false)
    expect(findNode(result, '2')?.external).toBe(true)
  })

  it('does not mutate the input forest', () => {
    const forest = [nodeWithHref('1', 'https://other.example.com/x')]
    const original = JSON.stringify(forest)
    applySiteUrl(forest, 'https://www.army.edu/')
    expect(JSON.stringify(forest)).toBe(original)
  })
})
