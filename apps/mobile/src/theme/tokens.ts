// Brand: oklch(58% 0.13 200)  → cyan-leaning teal
// Approve: oklch(70% 0.18 145) → confident green
// Deny:    oklch(62% 0.22 25)  → earnest red
// Warning: oklch(78% 0.15 75)  → amber
// Surface dark: oklch(15% 0.012 200) → near-black tinted to brand
// Surface light: oklch(98% 0.005 200)
//
// Derived via lib/oklch.ts. Re-derive whenever you change a source value
// to keep this file authoritative.

export const palette = {
  brand: {
    base:    '#1c8a9e',
    soft:    '#3eaec3',
    deep:    '#0f5f6e',
  },
  approve: {
    base:    '#2cb567',
    wash:    'rgba(44,181,103,0.18)',
    onBase:  '#04230f',
  },
  deny: {
    base:    '#d94a3d',
    wash:    'rgba(217,74,61,0.18)',
    onBase:  '#fff5f3',
  },
  warning: {
    base:    '#dba84a',
    onBase:  '#241906',
  },
  dark: {
    bg0:     '#0a1014',
    bg1:     '#0f161b',
    bg2:     '#162026',
    bg3:     '#1f2c33',
    border:  '#2b3940',
    textHi:  '#eef4f6',
    textMd:  '#a8b8be',
    textLo:  '#6b7d83',
  },
  light: {
    bg0:     '#f9fbfb',
    bg1:     '#f1f5f6',
    bg2:     '#e6ecee',
    bg3:     '#d8e0e3',
    border:  '#bfc9cd',
    textHi:  '#0a1014',
    textMd:  '#3a484e',
    textLo:  '#6b7d83',
  },
} as const;

export const riskTier = {
  low:      { band: palette.brand.deep,   text: palette.dark.textHi },
  medium:   { band: palette.warning.base, text: palette.warning.onBase },
  high:     { band: palette.deny.base,    text: palette.deny.onBase },
  critical: { band: '#7a1d18',            text: '#fff5f3' },
} as const;

export type RiskTier = keyof typeof riskTier;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  full: 999,
} as const;

export const spacing = {
  px: 1,
  '0.5': 2,
  '1': 4,
  '2': 8,
  '3': 12,
  '4': 16,
  '5': 20,
  '6': 24,
  '8': 32,
  '10': 40,
  '12': 48,
  '16': 64,
  '20': 80,
} as const;
