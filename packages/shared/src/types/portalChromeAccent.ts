/**
 * Curated accents for the customer portal's chrome (primary button, active-nav
 * mark, links, score rule). A partner picks a KEY, never a colour: each preset
 * ships with pre-checked light and dark tokens so the chrome stays readable
 * and inside the portal's warm paper world whatever is picked. Status colours
 * (success / warning / destructive) never change.
 *
 * The stored value is one of these keys or null (= the default, 'spruce').
 * The portal maps the key to token overrides in its stylesheet
 * (apps/portal/src/styles/globals.css, `[data-accent="…"]` blocks); the API
 * validates writes against PORTAL_CHROME_ACCENT_KEYS.
 */
export const PORTAL_CHROME_ACCENT_KEYS = [
  'spruce',
  'ink',
  'oxblood',
  'navy',
  'plum',
  'bronze',
  'teal',
  'forest',
] as const;

export type PortalChromeAccent = (typeof PORTAL_CHROME_ACCENT_KEYS)[number];

export const PORTAL_CHROME_ACCENT_DEFAULT: PortalChromeAccent = 'spruce';

/** HSL triplets ("h s% l%") for each preset. `light` is the ink on the
 *  plaster ground; `dark` is the lightened after-hours variant. Swatches in
 *  the MSP settings UI use `light`. */
export interface PortalChromeAccentSpec {
  label: string;
  light: { primary: string; primaryForeground: string; primaryOnTint: string; ring: string };
  dark: { primary: string; primaryForeground: string; primaryOnTint: string; ring: string };
}

export const PORTAL_CHROME_ACCENTS: Record<PortalChromeAccent, PortalChromeAccentSpec> = {
  spruce: {
    label: 'Spruce',
    light: { primary: '155 32% 24%', primaryForeground: '42 45% 97%', primaryOnTint: '155 32% 24%', ring: '155 32% 30%' },
    dark: { primary: '152 30% 64%', primaryForeground: '155 40% 10%', primaryOnTint: '152 38% 70%', ring: '152 30% 52%' },
  },
  ink: {
    label: 'Ink',
    light: { primary: '30 12% 18%', primaryForeground: '42 45% 97%', primaryOnTint: '30 12% 18%', ring: '30 12% 26%' },
    dark: { primary: '38 20% 78%', primaryForeground: '30 12% 10%', primaryOnTint: '38 22% 82%', ring: '38 20% 64%' },
  },
  oxblood: {
    label: 'Oxblood',
    light: { primary: '8 55% 30%', primaryForeground: '42 45% 97%', primaryOnTint: '8 55% 30%', ring: '8 55% 36%' },
    dark: { primary: '10 45% 68%', primaryForeground: '8 50% 10%', primaryOnTint: '10 50% 74%', ring: '10 45% 56%' },
  },
  navy: {
    label: 'Navy',
    light: { primary: '222 40% 28%', primaryForeground: '42 45% 97%', primaryOnTint: '222 40% 28%', ring: '222 40% 34%' },
    dark: { primary: '218 38% 70%', primaryForeground: '222 45% 10%', primaryOnTint: '218 42% 76%', ring: '218 38% 58%' },
  },
  plum: {
    label: 'Plum',
    light: { primary: '300 30% 26%', primaryForeground: '42 45% 97%', primaryOnTint: '300 30% 26%', ring: '300 30% 32%' },
    dark: { primary: '300 26% 70%', primaryForeground: '300 35% 10%', primaryOnTint: '300 30% 76%', ring: '300 26% 58%' },
  },
  bronze: {
    label: 'Bronze',
    light: { primary: '30 55% 26%', primaryForeground: '42 45% 97%', primaryOnTint: '30 55% 26%', ring: '30 55% 32%' },
    dark: { primary: '34 50% 66%', primaryForeground: '30 55% 10%', primaryOnTint: '34 55% 72%', ring: '34 50% 54%' },
  },
  teal: {
    label: 'Teal',
    light: { primary: '190 45% 24%', primaryForeground: '42 45% 97%', primaryOnTint: '190 45% 24%', ring: '190 45% 30%' },
    dark: { primary: '188 38% 64%', primaryForeground: '190 45% 10%', primaryOnTint: '188 42% 70%', ring: '188 38% 52%' },
  },
  forest: {
    label: 'Forest',
    light: { primary: '140 40% 20%', primaryForeground: '42 45% 97%', primaryOnTint: '140 40% 20%', ring: '140 40% 26%' },
    dark: { primary: '138 32% 64%', primaryForeground: '140 40% 10%', primaryOnTint: '138 36% 70%', ring: '138 32% 52%' },
  },
};

export function isPortalChromeAccent(value: unknown): value is PortalChromeAccent {
  return typeof value === 'string' && (PORTAL_CHROME_ACCENT_KEYS as readonly string[]).includes(value);
}
