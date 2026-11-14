import { contrastRatio } from '@breeze-brand-contrast';

import { activeCardTheme, brandAccentFor } from '../prompt/theme';

/*
 * Runtime Helper branding as the webview sees it. The Rust side has already
 * validated the values read from helper_config.yaml; this module validates
 * them again (the contract is "validated on write and again on the device")
 * and is the only place branding turns into UI state.
 *
 * Plain text only: values are rendered as React text, never HTML, Markdown,
 * URL or CSS. Colours are strict #RRGGBB and reach the DOM only as CSS custom
 * properties set from here, never from server-supplied CSS.
 */

export interface HelperBranding {
  displayName?: string;
  companyName?: string;
  welcomeTitle?: string;
  welcomeMessage?: string;
  supportLabel?: string;
  portalLabel?: string;
  primaryColor?: string;
  accentColor?: string;
}

/** Code-point limits; mirror agent/internal/helper/branding.go and apps/api helperBranding.ts. */
const TEXT_LIMITS = {
  displayName: 60,
  companyName: 60,
  welcomeTitle: 120,
  welcomeMessage: 500,
  supportLabel: 40,
  portalLabel: 40,
} as const;

const COLOR_KEYS = ['primaryColor', 'accentColor'] as const;

const HEX = /^#[0-9A-Fa-f]{6}$/;
// Control, format, surrogate, private-use and line/paragraph separators. ZWNJ
// and ZWJ are allowed (some scripts and emoji need them), as on the Agent.
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;

function validText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value === '' || [...value].length > max) return false;
  return ![...value].some((ch) => ch !== '‌' && ch !== '‍' && FORBIDDEN.test(ch));
}

/** Keeps only valid known fields; anything else is dropped (that field falls back to the Breeze default). */
export function sanitizeBranding(raw: unknown): HelperBranding {
  const out: HelperBranding = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const [key, max] of Object.entries(TEXT_LIMITS)) {
    if (validText(src[key], max)) out[key as keyof typeof TEXT_LIMITS] = src[key] as string;
  }
  for (const key of COLOR_KEYS) {
    const v = src[key];
    if (typeof v === 'string' && HEX.test(v)) out[key] = v;
  }
  return out;
}

/**
 * Windows that ask the device user for a security decision (remote-session
 * consent, the session banner, Caller Verification). They never take tenant
 * styling: the colours stay the Breeze palette whatever the branding says.
 */
export function isSecurityWindowHash(hash: string): boolean {
  return hash === '#consent' || hash === '#banner' || hash.startsWith('#caller-verify/');
}

const VARS = ['--ws-accent', '--ws-accent-contrast', '--ws-accent-soft', '--ws-brand-accent'] as const;

/**
 * Semantic colours as local CSS variables on `root`. A colour that is not
 * readable in the active theme (or in forced-colors / more-contrast modes) is
 * not applied, so the Breeze palette stays. The foreground is derived here.
 */
export function applyBrandingColors(
  branding: HelperBranding,
  root: HTMLElement = document.documentElement,
): void {
  for (const name of VARS) root.style.removeProperty(name);
  const theme = activeCardTheme();
  const primary = brandAccentFor(branding.primaryColor, theme);
  if (primary) {
    root.style.setProperty('--ws-accent', primary);
    root.style.setProperty(
      '--ws-accent-contrast',
      contrastRatio(primary, '#FFFFFF') >= contrastRatio(primary, '#000000') ? '#FFFFFF' : '#000000',
    );
    root.style.setProperty('--ws-accent-soft', `color-mix(in srgb, ${primary} 10%, transparent)`);
  }
  const accent = brandAccentFor(branding.accentColor, theme);
  if (accent) root.style.setProperty('--ws-brand-accent', accent);
}
