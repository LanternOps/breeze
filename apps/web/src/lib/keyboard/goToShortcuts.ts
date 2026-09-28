/**
 * Two-key chords (GitHub / Linear style):
 *   g then <key>  go to a page
 *   c then <key>  create something
 *
 * Every go-to entry must point at a sidebar item (top level or inside a
 * section) — `Sidebar.nav.test.tsx` asserts each href is in the nav and reuses
 * its label, so the cheat sheet, the chord handler and the nav can never
 * disagree about where a key goes.
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
  { key: 'o', href: '/organizations', labelKey: 'nav.organizations' },
  { key: 'd', href: '/devices', labelKey: 'nav.devices' },
  { key: 'a', href: '/alerts', labelKey: 'nav.alerts' },
  { key: 'i', href: '/incidents', labelKey: 'nav.incidents' },
  { key: 'r', href: '/remote', labelKey: 'nav.remoteAccess' },
  { key: 's', href: '/scripts', labelKey: 'nav.scripts' },
  { key: 'p', href: '/patches', labelKey: 'nav.patches' },
  { key: 'v', href: '/vulnerabilities', labelKey: 'nav.vulnerabilities' },
  { key: 'j', href: '/jobs', labelKey: 'nav.jobs' },
  { key: 't', href: '/tickets', labelKey: 'nav.tickets' },
  { key: 'q', href: '/billing/quotes', labelKey: 'nav.quotes' },
  { key: 'b', href: '/billing/invoices', labelKey: 'nav.invoices' },
  { key: 'c', href: '/contracts', labelKey: 'nav.contracts' },
];

/** Pages whose create form is a dialog on the list page (see `createIntent.ts`). */
export type CreateIntentKind = 'quote' | 'invoice';

export interface CreateShortcut {
  key: string;
  href: string;
  /** common.json key for the action's label. */
  labelKey: string;
  /** Set when `href` is a list page that opens its create dialog on this intent. */
  intent?: CreateIntentKind;
}

export const CREATE_SHORTCUTS: readonly CreateShortcut[] = [
  { key: 't', href: '/tickets/new', labelKey: 'layout.shortcuts.newItems.ticket' },
  { key: 'q', href: '/billing/quotes', labelKey: 'layout.shortcuts.newItems.quote', intent: 'quote' },
  { key: 'i', href: '/billing/invoices', labelKey: 'layout.shortcuts.newItems.invoice', intent: 'invoice' },
  { key: 'c', href: '/contracts/new', labelKey: 'layout.shortcuts.newItems.contract' },
  { key: 's', href: '/scripts/new', labelKey: 'layout.shortcuts.newItems.script' },
];

export const CREATE_BY_KEY: ReadonlyMap<string, CreateShortcut> = new Map(
  CREATE_SHORTCUTS.map((s) => [s.key, s]),
);

export type ChordPrefix = 'g' | 'c';

export const GO_TO_BY_KEY: ReadonlyMap<string, GoToShortcut> = new Map(
  GO_TO_SHORTCUTS.map((s) => [s.key, s]),
);
