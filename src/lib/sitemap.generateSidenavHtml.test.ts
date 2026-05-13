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

  it('uses # as href fallback for nodes with empty href', () => {
    const html = generateSidenavHtml([leaf('1', 'Heading', '')])
    expect(html).toContain('<a href="#">Heading</a>')
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
