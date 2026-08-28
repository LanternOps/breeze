/** One release's "what's new" content, bundled with the web build. */
export interface WhatsNewEntry {
  /** Exact release version, e.g. "0.105.0". Compared with semverCompare. */
  version: string;
  /** ISO date, e.g. "2026-08-12". */
  date: string;
  /** One-line headline. */
  title: string;
  /** 2–5 short bullets. */
  highlights: string[];
  /** Optional deep link (docs / release notes). */
  learnMoreUrl?: string;
}

/**
 * Newest-first. Authored per release alongside the release-notes flow.
 * Entry content is English-only in v1 (see spec non-goals).
 */
export const WHATS_NEW_ENTRIES: WhatsNewEntry[] = [
  {
    version: '0.109.0',
    date: '2026-08-28',
    title: 'Org archive, guided SSO linking, and 30-day installer keys',
    highlights: [
      'Installer and enrollment keys now default to 30 days and 50 devices — staged rollouts no longer die when the download window expires.',
      'Organizations can now be archived (read-only, with restore) instead of only removed.',
      'SSO users with an existing password account get a guided "Connect your sign-in" flow instead of a lockout.',
      'The new AI Agent Runs view shows what an agent did, step by step, with verification results.',
      'Remote terminal fixes: no more dead Terminal tab until you switch tabs, and the garbled welcome message is gone.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
  {
    version: '0.105.0',
    date: '2026-08-12',
    title: 'Faster fleet views and clearer device health',
    highlights: [
      'Fleet lists load noticeably faster on large tenants.',
      'Device health cards surface reliability at a glance.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
];
