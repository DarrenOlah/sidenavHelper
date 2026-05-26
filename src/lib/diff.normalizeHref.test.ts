import { describe, it, expect } from 'vitest'
import { normalizeHref } from './diff'

describe('normalizeHref', () => {
  it('preserves the empty string', () => {
    expect(normalizeHref('')).toBe('')
    expect(normalizeHref('   ')).toBe('')
  })

  it('keeps root path "/" as-is (does not strip)', () => {
    expect(normalizeHref('/')).toBe('/')
    expect(normalizeHref('https://example.com/')).toBe('example.com/')
  })

  it('strips trailing slash on non-root paths', () => {
    expect(normalizeHref('/about/')).toBe('/about')
    expect(normalizeHref('/about')).toBe('/about')
    expect(normalizeHref('/about/')).toEqual(normalizeHref('/about'))
  })

  it('is case-insensitive on host and path', () => {
    expect(normalizeHref('https://Example.COM/About')).toBe(normalizeHref('http://example.com/about/'))
  })

  it('strips the fragment', () => {
    expect(normalizeHref('/x#top')).toBe('/x')
    expect(normalizeHref('/x#')).toBe('/x')
    expect(normalizeHref('https://example.com/x/#top')).toBe('example.com/x')
  })

  it('strips default ports (80/443) when comparing equivalent URLs', () => {
    expect(normalizeHref('https://example.com:443/x')).toBe(normalizeHref('https://example.com/x'))
    expect(normalizeHref('http://example.com:80/x')).toBe(normalizeHref('http://example.com/x'))
  })

  it('keeps non-default ports', () => {
    expect(normalizeHref('https://example.com:8080/x')).toBe('example.com:8080/x')
  })

  it('preserves query strings (different ?id= values stay distinct)', () => {
    expect(normalizeHref('/page?id=1')).not.toBe(normalizeHref('/page?id=2'))
    expect(normalizeHref('/page?id=1')).toBe('/page?id=1')
  })

  it('collapses repeated slashes in the path', () => {
    expect(normalizeHref('/a//b')).toBe('/a/b')
    expect(normalizeHref('https://example.com//a///b')).toBe('example.com/a/b')
  })

  it('handles relative paths without throwing', () => {
    expect(normalizeHref('about/team/')).toBe('about/team')
    expect(normalizeHref('about/team')).toBe('about/team')
  })

  it('does not collapse slashes inside the query string', () => {
    expect(normalizeHref('/page?path=a/b/c')).toBe('/page?path=a/b/c')
  })
})
