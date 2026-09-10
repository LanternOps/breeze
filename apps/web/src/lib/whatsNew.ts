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
    version: '0.112.0',
    date: '2026-09-10',
    title: 'Windows MSI installs again, bound authority for automation, and bare-metal recovery that restores the whole machine',
    highlights: [
      'The Windows agent MSI installs on Windows 10 and 11 again. Since v0.110.0 it refused every fresh install with "requires Windows 10 or Server 2016 or later"; existing agents were never affected.',
      'Some automation now waits for a human after this upgrade: PAM auto-approve rules are suspended until an admin re-approves them, and recurring sensitive-data and network-baseline scans pause until re-saved. QuickBooks, Workspace, connected apps and PAM approval use new dedicated permissions; custom roles need them granted in Settings → Roles.',
      'Remote desktop sessions are capped at 12 hours and end within seconds when a technician loses membership, role, site scope or MFA standing. Devices need the updated agent first.',
      'Bare-metal recovery restores system state (packages, services, firewall, crontabs, /etc) with checksum verification, file backups keep symlinks and ownership, and each system-image snapshot shows whether it is bare-metal restorable.',
      'Lenovo warranty lookup works, approval headlines name the device, and on mobile you can acknowledge or dismiss findings, set a requester contact on new tickets, and land in the note composer when you stop a timer.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
  {
    version: '0.111.0',
    date: '2026-09-09',
    title: 'Work that queues for offline devices, a customer record page, and Stop for running scripts',
    highlights: [
      'Patch jobs, automation script and command actions, and scan/rollback work aimed at an offline device now wait for it instead of failing. The step reads "Queued \u2014 device offline" and the agent claims it on its next heartbeat, so a nightly run across sleeping laptops no longer shows a wall of red. Each automation action has a new "If the device is offline" control (Queue or Skip).',
      'Stop a running script or automation from the UI \u2014 a Stop button on execution history and run detail, a Force stop option, and an honest status when the stop lands too late to take effect.',
      'Every customer now has an organization record page: contacts, sites, devices, tickets, contracts and billing, and activity in one place \u2014 plus a Service Desk section you can switch on or off for your whole partner account.',
      'Devices without an agent are first class. Add a manual asset by hand for anything you track but cannot install on, monitor a website or URL as a target, and open the new network device page for switches, firewalls, printers and NAS that discovery found.',
      'Configuration policies can inherit from a parent policy, and the AI agent builder is now a four-step guided flow with a capability picker that spells out exactly what each agent may do on its own before you create it.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
  {
    version: '0.110.0',
    date: '2026-09-05',
    title: 'Restart prompts users can postpone, device-set billing, and QuickBooks payments',
    highlights: [
      'End users now get a native restart dialog on Windows, macOS and Linux when a patch needs a reboot, and can postpone it a set number of times within a deadline you choose in the patch policy (off by default). The device page shows the scheduled restart and how many postponements are left.',
      'Contracts can bill by device role or device group, with included quantities and overage. Every generated invoice records exactly which devices it billed, and an optional "Billed devices" appendix can print on the PDF. Quotes price by device set too.',
      'QuickBooks Online: push issued invoices, and payments recorded in QuickBooks flow back onto the Breeze invoice automatically.',
      'The customer portal grew Security, Backups, Devices, Tickets with SLA badges, and Reports pages, each behind a per-organization visibility toggle you control.',
      'Run a script again from its history, run scripts as the logged-in user, write device custom fields from script output, set AI budget alert thresholds, and see AI agent impact and graduation evidence before widening an agent\'s autonomy.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
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
