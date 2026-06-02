import { describe, it, expect } from 'vitest'
import { parseSitemapHtml, parseBestSitemap, generateSidenavHtml } from './sitemap'

describe('parseBestSitemap', () => {
  // When you copy raw source from a code editor / view-source pane, the
  // text/html flavor is a syntax-highlighted rendering — styling spans with the
  // angle brackets escaped to entities, no real <ul>/<li>/<a>. The real markup
  // lives in text/plain. parseBestSitemap must keep the text/plain parse.
  it('prefers text/plain when text/html is syntax-highlight noise', () => {
    const noise =
      '<div class="hl"><span style="color:#000">&lt;ul&gt;&lt;li&gt;&lt;a href="/a/"&gt;A&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;</span></div>'
    const realMarkup = '<ul><li><a href="/a/">A</a><ul><li><a href="/a/b/">B</a></li></ul></li></ul>'
    const { result, source } = parseBestSitemap(noise, realMarkup)
    expect(result.pageCount).toBe(2)
    expect(result.forest[0].label).toBe('A')
    expect(source).toBe(realMarkup)
  })

  // Copying a rendered page gives real DOM in text/html and flattened text in
  // text/plain — keep the richer text/html parse (ties favor text/html).
  it('prefers text/html when it carries the real rendered tree', () => {
    const realHtml = '<ul><li><a href="/a/">A</a><ul><li><a href="/a/b/">B</a></li></ul></li></ul>'
    const flattened = 'A\nB'
    const { result, source } = parseBestSitemap(realHtml, flattened)
    expect(result.pageCount).toBe(2)
    expect(source).toBe(realHtml)
  })

  it('returns an empty result when both flavors are empty', () => {
    const { result, source } = parseBestSitemap('', '')
    expect(result.forest).toEqual([])
    expect(result.pageCount).toBe(0)
    expect(source).toBe('')
  })

  it('falls back to whichever single flavor is present', () => {
    const markup = '<ul><li><a href="/a/">A</a></li></ul>'
    expect(parseBestSitemap(markup, '').source).toBe(markup)
    expect(parseBestSitemap('', markup).source).toBe(markup)
  })
})

describe('parseSitemapHtml', () => {
  it('returns an empty forest for empty input', () => {
    expect(parseSitemapHtml('')).toEqual({ forest: [], pageCount: 0, maxDepth: 0, detectedHeaderText: '', isAuSidenavOutput: false })
    expect(parseSitemapHtml('   ')).toEqual({ forest: [], pageCount: 0, maxDepth: 0, detectedHeaderText: '', isAuSidenavOutput: false })
  })

  describe('isAuSidenavOutput', () => {
    it('is true for output produced by generateSidenavHtml (round-trip)', () => {
      const seed = parseSitemapHtml(`<ul><li><a href="/a/">A</a><ul><li><a href="/a/b/">B</a></li></ul></li></ul>`)
      const html = generateSidenavHtml(seed.forest)
      expect(parseSitemapHtml(html).isAuSidenavOutput).toBe(true)
    })

    it('is true when only the .au-sidenav__sublist marker is present', () => {
      const html = `<ul class="au-sidenav__list"><li><a href="/a/">A</a><ul class="au-sidenav__sublist"><li><a href="/a/b/">B</a></li></ul></li></ul>`
      expect(parseSitemapHtml(html).isAuSidenavOutput).toBe(true)
    })

    it('is false for a plain site-index <ul>/<li>/<a> tree', () => {
      const html = `<ul><li><a href="/a/">A</a><ul><li><a href="/a/b/">B</a></li></ul></li></ul>`
      expect(parseSitemapHtml(html).isAuSidenavOutput).toBe(false)
    })

    it('is false for empty input', () => {
      expect(parseSitemapHtml('').isAuSidenavOutput).toBe(false)
    })
  })

  describe('detectedHeaderText', () => {
    it('returns empty string when no .au-sidenav__header is present', () => {
      const html = `<ul><li><a href="/a/">A</a></li></ul>`
      expect(parseSitemapHtml(html).detectedHeaderText).toBe('')
    })

    it('extracts the text of the first .au-sidenav__header element', () => {
      const html = `
        <nav class="au-sidenav">
          <h3 class="au-sidenav__header">Programs &amp; Degrees</h3>
          <ul class="au-sidenav__list">
            <li><a href="/a/">A</a></li>
          </ul>
        </nav>
      `
      expect(parseSitemapHtml(html).detectedHeaderText).toBe('Programs & Degrees')
    })

    it('collapses whitespace in the detected header text', () => {
      const html = `
        <h3 class="au-sidenav__header">
          About
          Us
        </h3>
        <ul><li><a href="/a/">A</a></li></ul>
      `
      expect(parseSitemapHtml(html).detectedHeaderText).toBe('About Us')
    })
  })

  it('parses a flat single-level <ul>', () => {
    const html = `
      <ul>
        <li><a href="/a/">A</a></li>
        <li><a href="/b/">B</a></li>
        <li><a href="/c/">C</a></li>
      </ul>
    `
    const { forest, pageCount, maxDepth } = parseSitemapHtml(html)
    expect(pageCount).toBe(3)
    expect(maxDepth).toBe(1)
    expect(forest.map(n => n.label)).toEqual(['A', 'B', 'C'])
    expect(forest.map(n => n.href)).toEqual(['/a/', '/b/', '/c/'])
    expect(forest.every(n => n.included)).toBe(true)
    expect(forest.every(n => n.children.length === 0)).toBe(true)
  })

  it('parses nested <ul>s into children arrays', () => {
    const html = `
      <ul>
        <li>
          <a href="/parent/">Parent</a>
          <ul>
            <li><a href="/parent/a/">Child A</a></li>
            <li><a href="/parent/b/">Child B</a></li>
          </ul>
        </li>
      </ul>
    `
    const { forest, maxDepth } = parseSitemapHtml(html)
    expect(maxDepth).toBe(2)
    expect(forest).toHaveLength(1)
    expect(forest[0].label).toBe('Parent')
    expect(forest[0].children.map(c => c.label)).toEqual(['Child A', 'Child B'])
  })

  it('handles three levels of nesting', () => {
    const html = `
      <ul>
        <li>
          <a href="/l1/">L1</a>
          <ul>
            <li>
              <a href="/l1/l2/">L2</a>
              <ul>
                <li><a href="/l1/l2/l3/">L3</a></li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
    `
    const { forest, maxDepth, pageCount } = parseSitemapHtml(html)
    expect(maxDepth).toBe(3)
    expect(pageCount).toBe(3)
    expect(forest[0].children[0].children[0].label).toBe('L3')
  })

  it('assigns unique stable ids to every node', () => {
    const html = `
      <ul>
        <li><a href="/a/">A</a></li>
        <li>
          <a href="/b/">B</a>
          <ul><li><a href="/b/c/">C</a></li></ul>
        </li>
      </ul>
    `
    const { forest } = parseSitemapHtml(html)
    const ids = [forest[0].id, forest[1].id, forest[1].children[0].id]
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('skips javascript: and fragment-only hrefs (resolves to empty)', () => {
    const html = `
      <ul>
        <li><a href="javascript:void(0)">Bad</a></li>
        <li><a href="#top">Top</a></li>
        <li><a href="/ok/">OK</a></li>
      </ul>
    `
    const { forest } = parseSitemapHtml(html)
    expect(forest.find(n => n.label === 'Bad')?.href).toBe('')
    expect(forest.find(n => n.label === 'Top')?.href).toBe('')
    expect(forest.find(n => n.label === 'OK')?.href).toBe('/ok/')
  })

  it('resolves relative hrefs against a <base href>', () => {
    const html = `
      <html>
        <head><base href="https://www.army.edu/"></head>
        <body>
          <ul>
            <li><a href="/About/">About</a></li>
            <li><a href="Programs/">Programs</a></li>
          </ul>
        </body>
      </html>
    `
    const { forest } = parseSitemapHtml(html)
    expect(forest[0].href).toBe('https://www.army.edu/About/')
    expect(forest[1].href).toBe('https://www.army.edu/Programs/')
  })

  it('collapses whitespace in labels', () => {
    const html = `
      <ul>
        <li><a href="/a/">  Multi
          line
          label  </a></li>
      </ul>
    `
    const { forest } = parseSitemapHtml(html)
    expect(forest[0].label).toBe('Multi line label')
    expect(forest[0].defaultLabel).toBe('Multi line label')
  })

  it('falls back to flat <a> list when no <ul> is present', () => {
    const html = `
      <p><a href="/a/">A</a></p>
      <p><a href="/b/">B</a></p>
    `
    const { forest, pageCount } = parseSitemapHtml(html)
    expect(pageCount).toBe(2)
    expect(forest.map(n => n.label)).toEqual(['A', 'B'])
  })

  it('handles a headerless <li> (text + nested <ul>) as a no-href parent', () => {
    const html = `
      <ul>
        <li>
          Section heading
          <ul>
            <li><a href="/x/">X</a></li>
          </ul>
        </li>
      </ul>
    `
    const { forest } = parseSitemapHtml(html)
    expect(forest).toHaveLength(1)
    expect(forest[0].href).toBe('')
    expect(forest[0].label).toBe('Section heading')
    expect(forest[0].children[0].label).toBe('X')
  })

  it('label defaults to the same string as defaultLabel', () => {
    const { forest } = parseSitemapHtml('<ul><li><a href="/a/">Alpha</a></li></ul>')
    expect(forest[0].label).toBe(forest[0].defaultLabel)
    expect(forest[0].label).toBe('Alpha')
  })
})
