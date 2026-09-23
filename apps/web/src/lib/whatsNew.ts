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
    version: '0.116.0',
    date: '2026-09-23',
    title: 'Accept quotes on a customer\'s behalf, IOC threat scanning, and invoices grouped by ticket',
    highlights: [
      'Record a customer\'s phone or paper acceptance on a quote: "Accept on behalf" issues the invoice straight away, with the method, signer and an optional evidence file on the record — and "Decline on behalf" for the other answer.',
      'Security ▸ IOC Scans: schedule scans from the policy Security tab, review threats across devices, and quarantine or restore them from one page.',
      'Invoice lines can now be grouped by ticket and category on the PDF, the portal and the web invoice, and billable time without an hourly rate is flagged instead of silently inflating hours.',
      'Network topology is now a partner module you switch on from Settings ▸ Partner ▸ Modules, and the customer portal gets a Network overview page.',
      'Disk Cleanup: Windows Update Cleanup no longer hangs under the agent service, and space freed on btrfs hosts is reported correctly (needs agent 0.116.0).',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
  {
    version: '0.115.0',
    date: '2026-09-21',
    title: 'Automatic network topology maps, one alert delivery resolver, and disk cleanup that actually frees space',
    highlights: [
      'Network devices now assemble themselves into a live topology map from passive agent evidence — no active scanning needed — with shared config templates and on-demand diagnostics from the map.',
      'Alerting: one delivery resolver replaces the old "send to everything enabled" fallback, with a real Delivery page (Channels, Routing, Escalation policies) and a preview of who actually gets notified.',
      'Disk Cleanup now deletes for real (space is actually reclaimed), scans any fixed volume, and adds OS-native cleaners — Windows Disk Cleanup/DISM, macOS snapshots/Homebrew, Linux caches/journal.',
      'Billing Profiles replace scattered legacy rate fields with one Rates screen, including minimums and rounding on billed time; existing rates convert automatically on upgrade.',
      'Moving a device to another organization now requires an interactive session, and a step-up MFA prompt when two-factor authentication is on.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
  {
    version: '0.114.0',
    date: '2026-09-17',
    title: 'Four new evidence report types, honest network device polling, and clearer visibility controls',
    highlights: [
      'Four new evidence report types are available under Reports for compliance and QBR evidence: identity & access review, vulnerability management, endpoint management, and threat detection.',
      'The network device page now shows what SNMP polling actually found, including failed polls, instead of hiding them. SNMPv1 devices poll correctly again, and one bad OID instance no longer blanks the whole poll.',
      'The portal Devices page is now a per-organization visibility toggle, off by default, so customers only see it once you turn it on.',
      'The org AI budget editor moved into Org settings, under a new AI tab.',
      "Variables' All Organizations view now lists only partner-wide variables, with each row showing its owning organization.",
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
  {
    version: '0.113.0',
    date: '2026-09-13',
    title: 'Remote desktop sessions that stay up, AI-authored scripts you approve on a card, and service deliverables in the customer portal',
    highlights: [
      'Remote desktop sessions no longer drop after about a minute. Since early August every peer-to-peer session was ended by the server as an orphan; the fix is server-side, so no agent update is needed. Secondary monitors also get correct input and cursor placement on Windows with the updated helper.',
      'The AI assistant can now write a script as a proposal: it is scanned, independently reviewed, and shown to you on an approval card with the goal, risk tier, findings, target devices and the code. Approved runs are verified with an independent device read before the script can be saved to the library, where its origin and reviewer stay visible.',
      'Service deliverables: define deliverable templates, apply them to an organization or contract, track key dates and evidence, and let customers see Service and Documents in the portal. Organizations also get a document library with evidence attachments.',
      'Faster navigation: a Devices & Assets section, recent devices, a jump-back palette and keyboard shortcuts. Consecutive Tier-3 approvals need one step-up ceremony instead of one per decision.',
      'Fixes: AI credit calls reach billing again, the approval mode is kept on the first AI budget save, chat sessions bind to the device you are looking at, UniFi lowercase status values count as online, and decommissioned devices stop being reconciled for peripheral policy.',
    ],
    learnMoreUrl: 'https://breezermm.com/release-notes',
  },
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
