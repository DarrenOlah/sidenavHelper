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

// Why findDuplicateLinks (src/lib/duplicates.ts) exists. These assert the
// broken behavior on purpose: it is a property of the vendored component, not
// something the helper can fix, so the helper must refuse to emit menus that
// trigger it.
describe('sidenav findCurrentLink — duplicate links (first occurrence wins)', () => {
  // The same page linked twice: once as a shortcut inside Carlisle Experience,
  // once as the real Distance Education branch. Mirrors the site index that
  // motivated the duplicate validator.
  function duplicateMenu(): SitemapNode[] {
    return [
      parent('carlisle', 'Carlisle Experience', '/usawc/carlisle-experience/', [
        leaf('shortcut', 'DDE', '/usawc/dde/'),
      ]),
      parent('dde', 'Department of Distance Education (DDE)', '/usawc/dde/', [
        leaf('techsupport', 'Tech Support', '/usawc/dde/tech-support/'),
      ]),
    ]
  }

  it('selects the FIRST link in document order, leaving the second unreachable', () => {
    const nav = buildNav(duplicateMenu(), '/usawc/dde/')
    const matches = nav.querySelectorAll('a.au-sidenav__link--current')
    expect(matches).toHaveLength(1)
    // Both anchors have href="/usawc/dde/", so identify the winner by its
    // position rather than its href.
    const all = Array.from(nav.querySelectorAll('a[href="/usawc/dde/"]'))
    expect(all).toHaveLength(2)
    expect(matches[0]).toBe(all[0])
  })

  it('marks and expands the WRONG section when the duplicate comes first', () => {
    const nav = buildNav(duplicateMenu(), '/usawc/dde/')
    const carlisleLi = nav
      .querySelector('a[href="/usawc/carlisle-experience/"]')!
      .closest('.au-sidenav__item')!
    // The shortcut's ancestor lights up...
    expect(carlisleLi.classList.contains('au-sidenav__item--current-section')).toBe(true)
    expect(carlisleLi.classList.contains('au-sidenav__item--expanded')).toBe(true)
    // ...while the real DDE branch stays collapsed and unmarked.
    const realDdeLi = nav
      .querySelector('a[href="/usawc/dde/tech-support/"]')!
      .closest('.au-sidenav__sublist')!
      .closest('.au-sidenav__item')!
    expect(realDdeLi.classList.contains('au-sidenav__item--current-section')).toBe(false)
    expect(realDdeLi.classList.contains('au-sidenav__item--expanded')).toBe(false)
  })

  it('resolves an absolute external href against pathname only (host discarded)', () => {
    // Why external-only collisions on '/' are noise but internal/external
    // collisions on a real path are not: the host never enters the comparison.
    // external: true keeps the absolute href in the output; without it
    // generateSidenavHtml would strip the host and the point would be moot.
    const press: SitemapNode = {
      ...leaf('press', 'Parameters Journal', 'https://press.armywarcollege.edu/parameters/'),
      external: true,
    }
    const nav = buildNav([press, leaf('internal', 'Parameters', '/parameters/')], '/parameters/')
    expect(currentHref(nav)).toBe('https://press.armywarcollege.edu/parameters/')
  })
})
