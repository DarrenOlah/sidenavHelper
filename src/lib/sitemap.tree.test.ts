import { describe, it, expect } from 'vitest'
import {
  findNode,
  findParent,
  renameNode,
  setIncluded,
  reorderSiblings,
  selectSubtree,
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
