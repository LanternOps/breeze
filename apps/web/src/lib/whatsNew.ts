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
    date: '2026-09-01',
    title: 'MFA everywhere, AI ticket triage, and ticketing on mobile',
    highlights: [
      'Multi-factor sign-in is complete: enrol an authenticator, SMS or passkey, and your recovery codes are shown once at enrolment — a mistyped code now tells you instead of silently discarding the setup.',
      'AI agents can now triage tickets: draft a reply you send as yourself, discard, or resolve with a prefilled note — plus weekly org narratives and scheduled sweeps, all off by default.',
      'Tickets on mobile: comment attachments, a running timer with a weekly timesheet, push categories, and auto-suggested time entries from remote sessions.',
      'Organizations can be archived (read-only, with restore) or merged; installer keys default to 30 days and 50 devices.',
      'Remote desktop: Paste Text arrives exactly as typed on any keyboard layout, the macOS helper reconnects after sleep instead of exiting, and the Terminal tab connects first time.',
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
