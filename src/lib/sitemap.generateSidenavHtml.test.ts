import { describe, it, expect } from 'vitest'
import { generateSidenavHtml, parseSitemapHtml, type SitemapNode } from './sitemap'

function leaf(id: string, label: string, href: string, included = true): SitemapNode {
  return { id, href, defaultLabel: label, label, included, children: [] }
}

function parent(id: string, label: string, href: string, children: SitemapNode[], included = true): SitemapNode {
  return { id, href, defaultLabel: label, label, included, children }
}

describe('generateSidenavHtml', () => {
  it('emits a <nav class="au-sidenav"> wrapper with default header text', () => {
    const html = generateSidenavHtml([leaf('1', 'A', '/a/')])
    expect(html.startsWith('<nav class="au-sidenav" aria-label="In this section">')).toBe(true)
    expect(html).toContain('<h3 class="au-sidenav__header">In this section</h3>')
    expect(html.endsWith('</nav>')).toBe(true)
  })

  it('uses a custom headerText for both aria-label and the <h3>', () => {
    const html = generateSidenavHtml([leaf('1', 'A', '/a/')], { headerText: 'About' })
    expect(html).toContain('aria-label="About"')
    expect(html).toContain('<h3 class="au-sidenav__header">About</h3>')
  })

  it('emits leaf items without chevron <button> or sublist', () => {
    const html = generateSidenavHtml([leaf('1', 'Leaf', '/leaf/')])
    expect(html).toContain('<a href="/leaf/">Leaf</a>')
    expect(html).not.toContain('au-sidenav__toggle')
    expect(html).not.toContain('au-sidenav__sublist')
  })

  it('emits parent items with all three required elements (a + button + ul)', () => {
    const html = generateSidenavHtml([
      parent('1', 'Parent', '/p/', [leaf('2', 'Child', '/p/c/')]),
    ])
    expect(html).toContain('<a href="/p/">Parent</a>')
    expect(html).toContain('<button type="button" class="au-sidenav__toggle" aria-label="Toggle submenu"></button>')
    expect(html).toContain('<ul class="au-sidenav__sublist">')
    expect(html).toContain('<a href="/p/c/">Child</a>')
  })

  it('omits excluded nodes and their descendants', () => {
    const html = generateSidenavHtml([
      leaf('1', 'Keep', '/k/'),
      parent('2', 'Drop', '/d/', [leaf('3', 'Drop child', '/d/c/')], false),
    ])
    expect(html).toContain('Keep')
    expect(html).not.toContain('Drop')
    expect(html).not.toContain('Drop child')
  })

  it('treats a parent whose children are all excluded as a leaf', () => {
    const html = generateSidenavHtml([
      parent('1', 'P', '/p/', [
        leaf('2', 'C1', '/p/c1/', false),
        leaf('3', 'C2', '/p/c2/', false),
      ]),
    ])
    expect(html).toContain('<a href="/p/">P</a>')
    expect(html).not.toContain('au-sidenav__toggle')
    expect(html).not.toContain('au-sidenav__sublist')
  })

  it('renders an empty-href node as a plain-text span (covered in depth below)', () => {
    const html = generateSidenavHtml([leaf('1', 'Heading', '')])
    expect(html).toContain('<span class="au-sidenav__text">Heading</span>')
    expect(html).not.toContain('<a href="#"')
  })

  it('uses node.label (override) rather than defaultLabel for output', () => {
    const node: SitemapNode = {
      id: '1', href: '/a/', defaultLabel: 'Original', label: 'Renamed',
      included: true, children: [],
    }
    const html = generateSidenavHtml([node])
    expect(html).toContain('Renamed')
    expect(html).not.toContain('Original')
  })

  it('escapes HTML-significant characters in labels and hrefs', () => {
    const html = generateSidenavHtml([
      leaf('1', 'A & B <ok>', '/q?x=1&y=2'),
    ])
    expect(html).toContain('A &amp; B &lt;ok&gt;')
    expect(html).toContain('href="/q?x=1&amp;y=2"')
  })

  describe('XSS hardening', () => {
    // A malicious sitemap could contain payloads in either the link text
    // (label) or the href attribute. generateSidenavHtml is the last gate
    // before the string hits dangerouslySetInnerHTML in the preview, so this
    // test asserts the worst-case output contains nothing that a browser
    // would execute as script when parsed as HTML.
    const malicious: SitemapNode[] = [
      {
        id: '1',
        href: 'javascript:alert(1)',
        defaultLabel: 'attempted js href',
        label: 'attempted js href',
        included: true,
        children: [],
      },
      {
        id: '2',
        href: '" onmouseover="alert(1)" data-x="',
        defaultLabel: 'attribute breakout',
        label: 'attribute breakout',
        included: true,
        children: [],
      },
      {
        id: '3',
        href: '/ok/',
        defaultLabel: 'tag in label',
        label: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
        included: true,
        children: [],
      },
      {
        id: '4',
        href: '/ok/',
        defaultLabel: 'svg label',
        label: '<svg onload=alert(3)></svg>',
        included: true,
        children: [],
      },
    ]
    const html = generateSidenavHtml(malicious)

    it('contains no <script> tags from label injection attempts', () => {
      expect(html.toLowerCase()).not.toContain('<script')
      expect(html.toLowerCase()).not.toContain('</script')
    })

    it('contains no <img>, <svg>, or other tag injections from labels', () => {
      // Any unescaped < followed by a letter would form a tag. After escaping,
      // < should only appear as &lt; so no `<` followed by a letter survives.
      expect(html).not.toMatch(/<(img|svg|iframe|object|embed)\b/i)
    })

    it('parses cleanly as HTML with no injected event handlers or schemes', () => {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const anchors = Array.from(doc.querySelectorAll('a'))
      // Each malicious node yielded one anchor, all from our template.
      expect(anchors).toHaveLength(malicious.length)
      // No anchor should have a href starting with javascript:, data:, etc.
      for (const a of anchors) {
        const href = a.getAttribute('href') || ''
        expect(href.toLowerCase()).not.toMatch(/^(javascript|data|vbscript|file):/)
      }
      // No anchor should have any on* attributes.
      for (const a of anchors) {
        for (const attr of Array.from(a.attributes)) {
          expect(attr.name.toLowerCase()).not.toMatch(/^on/)
        }
      }
    })
  })

  describe('rootMode', () => {
    // A picked-root forest is a single-element array (matches what
    // selectSubtree returns in App.tsx). The mode only takes effect for
    // single-root forests; multi-root forests render as before.
    const root = parent('1', 'About', '/about/', [
      leaf('2', 'Team', '/about/team/'),
      parent('3', 'History', '/about/history/', [
        leaf('4', 'Founders', '/about/history/founders/'),
      ]),
    ])

    it("'parent' renders the root as a parent <li> with sublist (legacy default)", () => {
      const html = generateSidenavHtml([root], { rootMode: 'parent', hrefMode: 'absolute' })
      expect(html).toContain('<a href="/about/">About</a>')
      expect(html).toContain('<ul class="au-sidenav__sublist">')
      expect(html).toContain('<a href="/about/team/">Team</a>')
      expect(html).toContain('<a href="/about/history/founders/">Founders</a>')
    })

    it("'hide' omits the root and renders its children at top level", () => {
      const html = generateSidenavHtml([root], { rootMode: 'hide', hrefMode: 'absolute' })
      expect(html).not.toContain('>About<')
      expect(html).toContain('<a href="/about/team/">Team</a>')
      expect(html).toContain('<a href="/about/history/">History</a>')
      // History keeps its own children since only the picked root is reshaped.
      expect(html).toContain('<a href="/about/history/founders/">Founders</a>')
    })

    it("'sibling' renders the root as a leaf first, then its children as siblings", () => {
      const html = generateSidenavHtml([root], { rootMode: 'sibling', hrefMode: 'absolute' })
      const aboutIdx = html.indexOf('>About<')
      const teamIdx = html.indexOf('>Team<')
      expect(aboutIdx).toBeGreaterThan(-1)
      expect(teamIdx).toBeGreaterThan(aboutIdx)
      // Root is a leaf in sibling mode — no chevron/sublist for the About row.
      // (Team and History are at the same nesting level as About, not below it.)
      const aboutBlock = html.slice(aboutIdx, teamIdx)
      expect(aboutBlock).not.toContain('au-sidenav__toggle')
      // History keeps its own children since only the picked root is reshaped.
      expect(html).toContain('<a href="/about/history/founders/">Founders</a>')
    })

    it("'parent-expanded' tags the root <li> with data-au-default-expanded", () => {
      const html = generateSidenavHtml([root], { rootMode: 'parent-expanded', hrefMode: 'absolute' })
      // Root <li> opens with the marker.
      expect(html).toMatch(/<li class="au-sidenav__item" data-au-default-expanded="true">\s*\n\s*<a href="\/about\/">About<\/a>/)
      // Marker only on the root, not nested parents like History.
      expect(html.match(/data-au-default-expanded/g) ?? []).toHaveLength(1)
      // Children still render nested as in 'parent' mode.
      expect(html).toContain('<a href="/about/team/">Team</a>')
      expect(html).toContain('<a href="/about/history/founders/">Founders</a>')
    })

    it("'parent-expanded' falls back to plain class on multi-root forests", () => {
      const forest = [leaf('1', 'A', '/a/'), leaf('2', 'B', '/b/')]
      const html = generateSidenavHtml(forest, { rootMode: 'parent-expanded', hrefMode: 'absolute' })
      expect(html).not.toContain('data-au-default-expanded')
    })

    it("'sibling' uses rootSiblingLabel when provided", () => {
      const html = generateSidenavHtml([root], {
        rootMode: 'sibling',
        hrefMode: 'absolute',
        rootSiblingLabel: 'About Home',
      })
      expect(html).toContain('>About Home<')
    })

    it('rootMode is ignored for multi-root forests', () => {
      const forest = [leaf('1', 'A', '/a/'), leaf('2', 'B', '/b/')]
      const html = generateSidenavHtml(forest, { rootMode: 'hide', hrefMode: 'absolute' })
      expect(html).toContain('>A<')
      expect(html).toContain('>B<')
    })
  })

  describe('hrefMode', () => {
    it("'site-root-relative' (default) strips protocol+host", () => {
      const html = generateSidenavHtml([leaf('1', 'A', 'https://example.com/foo/bar?x=1#h')])
      expect(html).toContain('href="/foo/bar?x=1#h"')
      expect(html).not.toContain('https://example.com')
    })

    it("'absolute' preserves the full URL", () => {
      const html = generateSidenavHtml(
        [leaf('1', 'A', 'https://example.com/foo/bar')],
        { hrefMode: 'absolute' },
      )
      expect(html).toContain('href="https://example.com/foo/bar"')
    })

    it('site-root-relative leaves already-relative hrefs untouched', () => {
      const html = generateSidenavHtml([leaf('1', 'A', '/foo/bar')])
      expect(html).toContain('href="/foo/bar"')
    })

    it('keeps the host on a node flagged external, even in site-root-relative mode', () => {
      const node: SitemapNode = {
        id: '1', href: 'https://other.example.com/docs', defaultLabel: 'Docs', label: 'Docs',
        included: true, children: [], external: true,
      }
      const html = generateSidenavHtml([node])
      expect(html).toContain('href="https://other.example.com/docs"')
    })

    it('still strips host on a node not flagged external', () => {
      const node: SitemapNode = {
        id: '1', href: 'https://other.example.com/docs', defaultLabel: 'Docs', label: 'Docs',
        included: true, children: [], external: false,
      }
      const html = generateSidenavHtml([node])
      expect(html).toContain('href="/docs"')
      expect(html).not.toContain('other.example.com')
    })
  })

  describe('plain-text items (empty href)', () => {
    it('emits a <span class="au-sidenav__text"> instead of <a> for an href-less leaf', () => {
      const html = generateSidenavHtml([leaf('1', 'Group label', '')])
      expect(html).toContain('<span class="au-sidenav__text">Group label</span>')
      expect(html).not.toContain('<a href=')
    })

    it('emits a span for an href-less parent while keeping its toggle + sublist', () => {
      const html = generateSidenavHtml([
        parent('1', 'Group', '', [leaf('2', 'Child', '/c/')]),
      ])
      expect(html).toContain('<span class="au-sidenav__text">Group</span>')
      // Parent structure must still include the toggle and sublist so sidenav.js
      // can collapse/expand the group.
      expect(html).toContain('au-sidenav__toggle')
      expect(html).toContain('au-sidenav__sublist')
      expect(html).toContain('<a href="/c/">Child</a>')
    })

    it('still escapes labels inside the plain-text span (XSS)', () => {
      const html = generateSidenavHtml([leaf('1', '<script>x</script>', '')])
      expect(html).not.toContain('<script>x</script>')
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
    })

    it('a generated plain-text leaf round-trips through parseSitemapHtml', () => {
      const original: SitemapNode[] = [
        parent('1', 'Section', '/s/', [
          leaf('2', 'Real page', '/s/p/'),
          leaf('3', 'Just a label', ''),
        ]),
      ]
      const html = generateSidenavHtml(original)
      const { forest } = parseSitemapHtml(html)
      const labels = forest[0].children.map(c => c.label)
      expect(labels).toContain('Just a label')
      const reparsed = forest[0].children.find(c => c.label === 'Just a label')
      expect(reparsed?.href).toBe('')
    })
  })

  it('produces output that round-trips through parseSitemapHtml with the same structure', () => {
    const original: SitemapNode[] = [
      parent('1', 'Parent', '/p/', [
        leaf('2', 'C1', '/p/c1/'),
        parent('3', 'C2', '/p/c2/', [leaf('4', 'GC', '/p/c2/gc/')]),
      ]),
      leaf('5', 'Sibling', '/s/'),
    ]
    const html = generateSidenavHtml(original)
    const { forest, pageCount } = parseSitemapHtml(html)

    // 1 nav heading -> ignored. The au-sidenav__list is the top <ul>.
    // parseSitemapHtml treats it as the topmost ul and yields the same shape.
    expect(pageCount).toBe(5)
    expect(forest[0].label).toBe('Parent')
    expect(forest[0].children.map(c => c.label)).toEqual(['C1', 'C2'])
    expect(forest[0].children[1].children[0].label).toBe('GC')
    expect(forest[1].label).toBe('Sibling')
  })
})
