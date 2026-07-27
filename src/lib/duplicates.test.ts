import { describe, it, expect } from 'vitest'
import { findDuplicateLinks, normalizeMenuPath, unreachableLinkIds } from './duplicates'
import type { SitemapNode } from './sitemap'

function n(id: string, href: string, label: string, children: SitemapNode[] = []): SitemapNode {
  return { id, href, defaultLabel: label, label, included: true, children }
}
function ext(id: string, href: string, label: string): SitemapNode {
  return { ...n(id, href, label), external: true }
}
function cat(id: string, label: string, children: SitemapNode[]): SitemapNode {
  return { id, href: '', defaultLabel: label, label, included: true, children }
}

describe('normalizeMenuPath — mirrors sidenav.js normalizePath', () => {
  it('discards the host', () => {
    expect(normalizeMenuPath('https://example.com/USAWC/DDE/')).toBe('/usawc/dde/')
    expect(normalizeMenuPath('/USAWC/DDE/')).toBe('/usawc/dde/')
  })

  it('lowercases and forces a trailing slash', () => {
    expect(normalizeMenuPath('/About')).toBe('/about/')
    expect(normalizeMenuPath('/About/')).toBe('/about/')
  })

  it('leaves the site root as a bare slash', () => {
    expect(normalizeMenuPath('https://usawc.org/')).toBe('/')
    expect(normalizeMenuPath('/')).toBe('/')
  })

  it('ignores the query string (pathname only, like sidenav.js)', () => {
    expect(normalizeMenuPath('/news/?page=2')).toBe('/news/')
  })

  it('returns empty for an empty href', () => {
    expect(normalizeMenuPath('')).toBe('')
  })
})

describe('findDuplicateLinks', () => {
  it('returns nothing for a menu with unique links', () => {
    const forest = [n('a', '/a', 'A', [n('b', '/a/b', 'B')])]
    expect(findDuplicateLinks(forest)).toEqual([])
  })

  it('flags two internal links on the same path as an error — the DDE case', () => {
    // The same page linked both under a section and at top level. sidenav.js
    // selects the first, so visiting /usawc/dde/ expands Carlisle Experience.
    const forest = [
      n('root', '/USAWC/', 'USAWC', [
        cat('carlisle', 'Carlisle Experience', [n('dupe', '/USAWC/DDE/', 'DDE')]),
        n('real', '/USAWC/DDE/', 'Department of Distance Education (DDE)'),
      ]),
    ]
    const groups = findDuplicateLinks(forest)
    expect(groups).toHaveLength(1)
    expect(groups[0].path).toBe('/usawc/dde/')
    expect(groups[0].severity).toBe('error')
    // Document order: the nested shortcut comes first, so it is the winner and
    // the real branch is the unreachable one.
    expect(groups[0].nodes.map(x => x.id)).toEqual(['dupe', 'real'])
    expect([...unreachableLinkIds(groups)]).toEqual(['real'])
  })

  it('matches across href conventions — relative menu vs absolute index', () => {
    const forest = [
      n('a', '/USAWC/DDE/', 'DDE'),
      n('b', 'https://armyuniversity.army.afpims.mil/USAWC/DDE/', 'DDE'),
    ]
    const groups = findDuplicateLinks(forest)
    expect(groups).toHaveLength(1)
    expect(groups[0].severity).toBe('error')
  })

  it('does NOT report external-only collisions', () => {
    // Four off-site hosts all resolve to path '/'. Expected and harmless.
    const forest = [
      ext('a', 'https://usawc.org/', 'Alumni Association'),
      ext('b', 'https://dunham.tricare.mil/', 'Dunham Clinic'),
      ext('c', 'https://press.armywarcollege.edu/', 'USAWC Press'),
      ext('d', 'https://warroom.armywarcollege.edu/', 'War Room'),
    ]
    expect(findDuplicateLinks(forest)).toEqual([])
  })

  it('flags an internal/external collision as a warning', () => {
    const forest = [
      n('a', '/parameters/', 'Parameters'),
      ext('b', 'https://press.armywarcollege.edu/parameters/', 'Parameters Journal'),
    ]
    const groups = findDuplicateLinks(forest)
    expect(groups).toHaveLength(1)
    expect(groups[0].severity).toBe('warning')
  })

  it('ignores excluded nodes and their subtrees', () => {
    const excluded: SitemapNode = {
      ...n('x', '/USAWC/DDE/', 'DDE'),
      included: false,
      children: [{ ...n('x1', '/USAWC/DDE/', 'DDE again'), included: false }],
    }
    const forest = [n('a', '/USAWC/DDE/', 'DDE'), excluded]
    expect(findDuplicateLinks(forest)).toEqual([])
  })

  it('ignores href-less category rows', () => {
    const forest = [cat('c1', 'Audiences', []), cat('c2', 'Resources', [])]
    expect(findDuplicateLinks(forest)).toEqual([])
  })

  it('reports several groups in document order', () => {
    const forest = [
      n('a1', '/a/', 'A'),
      n('b1', '/b/', 'B'),
      n('a2', '/a/', 'A copy'),
      n('b2', '/b/', 'B copy'),
    ]
    expect(findDuplicateLinks(forest).map(g => g.path)).toEqual(['/a/', '/b/'])
  })

  it('treats trailing-slash and case differences as the same page', () => {
    const forest = [n('a', '/About', 'About'), n('b', '/about/', 'About us')]
    expect(findDuplicateLinks(forest)).toHaveLength(1)
  })
})
