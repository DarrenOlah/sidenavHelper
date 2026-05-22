import { describe, it, expect } from 'vitest'
import sidenavCss from '../vendor/au-sidenav/sidenav.css?raw'
import { ACCENT_PRESETS, DEFAULT_ACCENT, applyAccentColor, normalizeHex } from './accent'

describe('accent marker', () => {
  // Drift guard: applyAccentColor is a regex replace against sidenav.css. If
  // the vendored CSS ever loses this exact marker, the replace silently no-ops
  // and the accent picker stops working — fail loudly here instead.
  it('vendored sidenav.css still contains the Army Gold marker', () => {
    expect(sidenavCss).toMatch(/background-color:\s*#FFCC33;\s*\/\*\s*Army Gold\s*\*\//)
  })
})

describe('applyAccentColor', () => {
  it('replaces the marker with the chosen color', () => {
    const out = applyAccentColor(sidenavCss, '#B4CFED')
    expect(out).toContain('background-color: #B4CFED;')
    expect(out).not.toMatch(/background-color:\s*#FFCC33/)
  })

  it('still goes through the replacement when given the default color', () => {
    const out = applyAccentColor(sidenavCss, DEFAULT_ACCENT)
    expect(out).toContain('background-color: #FFCC33;')
    // The "/* Army Gold */" comment is replaced by "/* accent */" regardless
    // of the chosen color, so default and non-default paths emit the same shape.
    expect(out).not.toContain('/* Army Gold */')
    expect(out).toContain('/* accent */')
  })

  it('is idempotent: re-applying the same color produces the same string', () => {
    const once = applyAccentColor(sidenavCss, '#00427E')
    const twice = applyAccentColor(once, '#00427E')
    expect(twice).toBe(once)
  })

  it('changes only the accent rule, not the rest of the stylesheet', () => {
    const before = sidenavCss.length
    const after = applyAccentColor(sidenavCss, '#000000').length
    // The replacement keeps roughly the same length (7-char hex in, 7-char hex
    // out; "Army Gold" → "accent" trims a few chars). Bound the delta loosely.
    expect(Math.abs(after - before)).toBeLessThan(20)
  })
})

describe('normalizeHex', () => {
  it('accepts 6-char hex with or without leading #', () => {
    expect(normalizeHex('#abcdef')).toBe('#ABCDEF')
    expect(normalizeHex('abcdef')).toBe('#ABCDEF')
    expect(normalizeHex('#FFCC33')).toBe('#FFCC33')
  })

  it('rejects 3-char shorthand so mid-typing prefixes do not snap the preview', () => {
    expect(normalizeHex('#fff')).toBeNull()
    expect(normalizeHex('f0a')).toBeNull()
    expect(normalizeHex('#abc')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeHex('  #aabbcc  ')).toBe('#AABBCC')
  })

  it('rejects non-hex characters', () => {
    expect(normalizeHex('#xyzxyz')).toBeNull()
    expect(normalizeHex('#12345g')).toBeNull()
  })

  it('rejects wrong-length inputs', () => {
    expect(normalizeHex('')).toBeNull()
    expect(normalizeHex('#')).toBeNull()
    expect(normalizeHex('#12')).toBeNull()
    expect(normalizeHex('#1234')).toBeNull()
    expect(normalizeHex('#12345')).toBeNull()
    expect(normalizeHex('#1234567')).toBeNull()
  })

  it('rejects CSS-injection attempts', () => {
    expect(normalizeHex('red; } body { display:none } /*')).toBeNull()
    expect(normalizeHex('#fff; background: url(x)')).toBeNull()
  })
})

describe('ACCENT_PRESETS', () => {
  it('contains all seven service colors', () => {
    expect(ACCENT_PRESETS).toHaveLength(7)
    expect(ACCENT_PRESETS.map(p => p.name)).toEqual([
      'Civilian Blue',
      'NCO Green',
      'Warrant Officer Brown',
      'Command Blue',
      'Army Gold',
      'Army Black',
      'Carlisle Slate',
    ])
  })

  it('every preset hex is a valid 6-char hex', () => {
    for (const preset of ACCENT_PRESETS) {
      expect(normalizeHex(preset.hex)).toBe(preset.hex.toUpperCase())
    }
  })

  it('includes the default accent color', () => {
    expect(ACCENT_PRESETS.some(p => p.hex === DEFAULT_ACCENT)).toBe(true)
  })
})
