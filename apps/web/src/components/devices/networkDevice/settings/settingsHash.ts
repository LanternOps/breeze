// The network device page's URL fragment grammar: `#<tab>[/settings/<section>]`.
// Both halves are parsed here so the page, the header button, and the two
// launcher surfaces (Discovery rows, /monitoring/network rows) can never
// disagree about what a hash means. Tab-only hashes are unchanged from before
// W04, so every pre-existing deep link keeps working.

import { VALID_TABS, type Tab } from '../types';

export const SETTINGS_SECTIONS = ['identity', 'monitoring', 'link', 'danger'] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** Where a truncated (`#overview/settings`) or unknown-section hash lands. */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'identity';
const DEFAULT_TAB: Tab = 'overview';

export type DetailHash = { tab: Tab; settings: SettingsSection | null };

export function parseDetailHash(hash: string): DetailHash {
  const segments = hash.replace(/^#/, '').split('/');
  const rawTab = segments[0] ?? '';
  const tab = (VALID_TABS as readonly string[]).includes(rawTab) ? (rawTab as Tab) : DEFAULT_TAB;

  if (segments[1] !== 'settings') return { tab, settings: null };

  const rawSection = segments[2] ?? '';
  const settings = (SETTINGS_SECTIONS as readonly string[]).includes(rawSection)
    ? (rawSection as SettingsSection)
    : DEFAULT_SETTINGS_SECTION;
  return { tab, settings };
}

/**
 * Returns the fragment WITHOUT a leading `#` — callers assign it to
 * `window.location.hash`, which prepends one, and `useHashState`'s parser is
 * handed the already-stripped value.
 */
export function buildDetailHash(tab: Tab, section?: SettingsSection | null): string {
  return section ? `${tab}/settings/${section}` : tab;
}
