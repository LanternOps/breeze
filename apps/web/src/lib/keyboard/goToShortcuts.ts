/**
 * "g then <key>" navigation chords (GitHub / Linear style).
 *
 * Every entry must point at a top-level sidebar item — `Sidebar.nav.test.tsx`
 * asserts each href here appears in `topLevelNav`, so the cheat sheet, the
 * chord handler and the nav can never disagree about where a key goes.
 * Permission-gated pages are still listed: the route renders its own
 * access-denied state, the same as clicking the nav item would.
 */
export interface GoToShortcut {
  key: string;
  href: string;
  /** common.json key for the destination's nav label. */
  labelKey: string;
}

export const GO_TO_SHORTCUTS: readonly GoToShortcut[] = [
  { key: 'h', href: '/', labelKey: 'nav.dashboard' },
  { key: 'o', href: '/settings/organizations', labelKey: 'nav.organizations' },
  { key: 'd', href: '/devices', labelKey: 'nav.devices' },
  { key: 'a', href: '/alerts', labelKey: 'nav.alerts' },
  { key: 'i', href: '/incidents', labelKey: 'nav.incidents' },
  { key: 'r', href: '/remote', labelKey: 'nav.remoteAccess' },
  { key: 's', href: '/scripts', labelKey: 'nav.scripts' },
  { key: 'p', href: '/patches', labelKey: 'nav.patches' },
  { key: 'v', href: '/vulnerabilities', labelKey: 'nav.vulnerabilities' },
];

export const GO_TO_BY_KEY: ReadonlyMap<string, GoToShortcut> = new Map(
  GO_TO_SHORTCUTS.map((s) => [s.key, s]),
);
