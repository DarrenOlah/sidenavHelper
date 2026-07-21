import { describe, it, expect, beforeAll } from 'vitest'
import { generateSidenavHtml, type SitemapNode } from '../../lib/sitemap'
// Side-effect import: the IIFE registers window.AuSidenav.
import './sidenav.js'

function leaf(id: string, label: string, href: string): SitemapNode {
  return { id, href, defaultLabel: label, label, included: true, children: [] }
}

function parent(id: string, label: string, href: string, children: SitemapNode[]): SitemapNode {
  return { id, href, defaultLabel: label, label, included: true, children }
}

const AuSidenav = () => (window as unknown as { AuSidenav: { initNav: (n: Element) => void } }).AuSidenav

// Build the nav markup, insert it, apply the previewed current path, and run the
// real initNav so class modifiers reflect the current-page detection.
function buildNav(roots: SitemapNode[], currentPath: string): Element {
  document.body.innerHTML = generateSidenavHtml(roots)
  const nav = document.body.querySelector('.au-sidenav')!
  nav.setAttribute('data-au-current-path', currentPath)
  AuSidenav().initNav(nav)
  return nav
}

// href of the anchor that ended up marked as the current page (null if none).
function currentHref(nav: Element): string | null {
  const a = nav.querySelector('a.au-sidenav__link--current')
  return a ? a.getAttribute('href') : null
}

// A representative menu: a CSL section with News + Newsroom siblings, plus a
// Home root, mirroring the live site shape.
function sampleMenu(): SitemapNode[] {
  return [
    leaf('home', 'Home', '/'),
    parent('csl', 'CSL', '/csl/', [
      leaf('news', 'News', '/csl/news/'),
      leaf('newsroom', 'Newsroom', '/csl/newsroom/'),
    ]),
  ]
}

describe('sidenav findCurrentLink', () => {
  beforeAll(() => {
    // Registered by the side-effect import; guards against a load regression.
    expect(AuSidenav()?.initNav).toBeTypeOf('function')
  })

  it('highlights the exact page and marks its ancestor section', () => {
    const nav = buildNav(sampleMenu(), '/csl/news/')
    expect(currentHref(nav)).toBe('/csl/news/')
    const cslLi = nav.querySelector('a[href="/csl/"]')!.closest('.au-sidenav__item')!
    expect(cslLi.classList.contains('au-sidenav__item--current-section')).toBe(true)
    expect(cslLi.classList.contains('au-sidenav__item--expanded')).toBe(true)
  })

  it('falls back to the nearest ancestor for an off-menu descendant', () => {
    // A dynamically generated News article that is not itself in the menu.
    const nav = buildNav(sampleMenu(), '/csl/news/view/article/4548118/book-review/')
    expect(currentHref(nav)).toBe('/csl/news/')
    const cslLi = nav.querySelector('a[href="/csl/"]')!.closest('.au-sidenav__item')!
    expect(cslLi.classList.contains('au-sidenav__item--current-section')).toBe(true)
    expect(cslLi.classList.contains('au-sidenav__item--expanded')).toBe(true)
  })

  it('prefers the longest matching prefix over a shorter ancestor', () => {
    // Both /csl/ and /csl/news/ are ancestors; the deeper one must win.
    const nav = buildNav(sampleMenu(), '/csl/news/view/article/1/x/')
    expect(currentHref(nav)).toBe('/csl/news/')
  })

  it('does not treat a sibling with a shared prefix as an ancestor', () => {
    // /csl/newsroom/... must match Newsroom, never News.
    const nav = buildNav(sampleMenu(), '/csl/newsroom/some-article/')
    expect(currentHref(nav)).toBe('/csl/newsroom/')
  })

  it('does not over-match the site root for an unrelated deep page', () => {
    // Home "/" prefixes everything; it must not light up as a fallback.
    const nav = buildNav(sampleMenu(), '/some/unrelated/deep/page/')
    expect(currentHref(nav)).toBeNull()
  })

  it('matches case-insensitively and ignores trailing-slash differences', () => {
    const nav = buildNav(sampleMenu(), '/CSL/News/View/Article/9/Title')
    expect(currentHref(nav)).toBe('/csl/news/')
  })

  it('leaves nothing highlighted when there is no ancestor in the menu', () => {
    const nav = buildNav([leaf('a', 'A', '/a/'), leaf('b', 'B', '/b/')], '/c/child/')
    expect(currentHref(nav)).toBeNull()
  })
})
