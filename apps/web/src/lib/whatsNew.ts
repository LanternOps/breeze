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
    version: '0.105.0',
    date: '2026-08-12',
    title: 'Faster fleet views and clearer device health',
    highlights: [
      'Fleet lists load noticeably faster on large tenants.',
      'Device health cards surface reliability at a glance.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
  {
    version: '0.104.1',
    date: '2026-08-13',
    title: 'Nodes Unlimited branding, working agent installs, and a trusted update chain',
    highlights: [
      'Agents are now NU Agent throughout — service names, installer text and system service descriptions.',
      'Fixed the crash that stopped agents starting on Apple Silicon (M-series) Macs entirely.',
      'The server now serves our own signed agent builds instead of upstream ones.',
      'Added native Windows on ARM agent builds, which were previously unavailable.',
      'New Linux endpoint support, verified end-to-end from enrollment through remote script execution.',
    ],
  },
];
