// Accent bar color customization for the au-sidenav "current ancestor chain"
// highlight. The vendored sidenav.css hardcodes the color at a single marker;
// applyAccentColor swaps it for the user's choice on both the live-preview
// stylesheet and the copied output.

export interface AccentPreset {
  name: string
  hex: string
}

export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { name: 'Civilian Blue',         hex: '#B4CFED' },
  { name: 'NCO Green',             hex: '#676C4A' },
  { name: 'Warrant Officer Brown', hex: '#804331' },
  { name: 'Command Blue',          hex: '#00427E' },
  { name: 'Army Gold',             hex: '#FFCC33' },
  { name: 'Army Black',            hex: '#000000' },
  { name: 'Carlisle Slate',        hex: '#72848D' },
]

export const DEFAULT_ACCENT = '#FFCC33'

// Targets the exact marker authored in src/vendor/au-sidenav/sidenav.css:
//   background-color: #FFCC33; /* Army Gold */
// Tight match (not a bare `#FFCC33` replace) so future drift in the vendored
// CSS surfaces via accent.test.ts instead of silently no-op'ing.
const ACCENT_MARKER = /background-color:\s*#FFCC33;\s*\/\*\s*Army Gold\s*\*\//

export function applyAccentColor(css: string, color: string): string {
  return css.replace(ACCENT_MARKER, `background-color: ${color}; /* accent */`)
}

// Accepts #RRGGBB or RRGGBB (case-insensitive). Returns the normalized 6-char
// uppercase form with a leading #, or null for any input that isn't a clean
// 6-digit hex color. We reject anything else so user typing can't inject CSS
// syntax into the output stylesheet.
//
// 3-digit shorthand is intentionally rejected: while typing a 6-digit code,
// a 3-char prefix like "FFC" would otherwise be eagerly expanded to #FFFFCC
// and committed upstream, snapping the preview to a wrong color mid-keystroke.
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return ('#' + trimmed).toUpperCase()
  }
  return null
}

// Recover the accent color from a previously-generated menu's CSS so a pasted
// menu round-trips its color instead of snapping back to the default. Keyed on
// the accent rule's selector (not the `/* accent */` comment) because DNN /
// CKEditor may strip comments on save. Accepts #RGB or #RRGGBB in either
// `background-color` or the `background` shorthand. Returns the normalized
// #RRGGBB form, or null when the paste carried no accent rule (e.g. a fresh
// site index, or a menu copied without its <style> block).
const ACCENT_RULE = /\.au-sidenav__item--current-section::after\s*\{([^}]*)\}/
const ACCENT_DECL = /background(?:-color)?\s*:\s*#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/

export function detectAccentColor(source: string): string | null {
  if (typeof source !== 'string' || !source) return null
  const body = ACCENT_RULE.exec(source)?.[1]
  if (!body) return null
  const hex = ACCENT_DECL.exec(body)?.[1]
  if (!hex) return null
  const six = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex
  return normalizeHex(six)
}
