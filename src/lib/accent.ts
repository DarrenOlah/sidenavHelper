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
  { name: 'NCO Green',             hex: '#087F47' },
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

// Accepts #RGB, #RRGGBB, RGB, or RRGGBB (case-insensitive). Returns the
// normalized 6-char uppercase form with a leading #, or null for any input
// that isn't a clean hex color. We reject anything else so user typing can't
// inject CSS syntax into the output stylesheet.
export function normalizeHex(input: string): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed
    return ('#' + r + r + g + g + b + b).toUpperCase()
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) {
    return ('#' + trimmed).toUpperCase()
  }
  return null
}
