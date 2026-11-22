import { navSections, topLevelNav } from '../components/layout/Sidebar';
import { ALL_TABS } from '../components/settings/partnerSettings/tabRegistry';
import { SETTINGS_CATALOG } from './settingsCatalog';
import { isNavGateVisible, navItemHref, type NavGateContext } from './navGates';
import type { SettingsTranslate } from './settingsSearch';

/**
 * Cmd+K "Pages" and Partner Settings section results (#12210, #12216). Derived
 * from the sidebar's own `topLevelNav` / `navSections` and the Partner Settings
 * tab registry, and filtered by the same `isNavGateVisible` predicate, so the
 * palette never offers a page the user cannot open and a new nav item is
 * findable without touching a second list.
 */
export interface PaletteIndexHit {
  id: string;
  title: string;
  description: string;
  href: string;
}

/**
 * Extra search terms per nav href (English; the localized title is matched
 * separately). Only synonyms people actually type, not restatements of the
 * label. Keyed by href so the list can't drift from a renamed label.
 */
export const NAV_KEYWORDS: Record<string, readonly string[]> = {
  '/': ['home', 'overview'],
  '/organizations': ['customers', 'clients', 'tenants', 'companies'],
  '/devices': ['computers', 'endpoints', 'machines', 'servers', 'assets', 'inventory', 'agents'],
  '/alerts': ['notifications', 'warnings', 'incidents', 'alarms'],
  '/approvals': ['pending', 'authorize', 'elevation'],
  '/incidents': ['threats', 'breach', 'security events'],
  '/remote': ['rdp', 'remote desktop', 'terminal', 'ssh', 'screen sharing', 'connect'],
  '/scripts': ['powershell', 'bash', 'commands', 'run script'],
  '/jobs': ['automation', 'automations', 'scheduled tasks', 'schedule', 'cron', 'tasks'],
  '/flows': ['automation', 'workflow', 'workflows'],
  '/patches': ['updates', 'windows update', 'patching', 'hotfix', 'update rings'],
  '/vulnerabilities': ['cve', 'cves', 'exposure', 'security holes'],
  '/wisp': ['assistant', 'ai assistant'],
  '/ai/chat': ['assistant', 'chatbot', 'llm', 'ai assistant'],
  '/settings/ai-agents': ['workers', 'ai workers'],
  '/devices/groups': ['group', 'collections', 'tags'],
  '/settings/sites': ['locations', 'offices', 'branches'],
  '/devices/unassigned': ['pre-assignment', 'unclaimed'],
  '/configuration-policies': ['policy', 'policies', 'baseline', 'gpo', 'profiles'],
  '/software': ['apps', 'applications', 'deploy', 'install', 'packages'],
  '/software-inventory': ['installed software', 'applications', 'apps'],
  '/software-policies': ['allowlist', 'blocklist', 'blacklist', 'whitelist'],
  '/monitoring': ['snmp', 'ping', 'uptime', 'network monitor', 'switches', 'routers', 'printers'],
  '/discovery': ['scan', 'network scan', 'find devices'],
  '/onedrive': ['sharepoint', 'cloud files'],
  '/endpoint-messages': ['popup', 'notify users', 'message users', 'broadcast'],
  '/security': ['antivirus', 'protection', 'posture'],
  '/security/scans': ['ioc', 'yara', 'malware', 'threat hunt'],
  '/security/detection-rules': ['yara', 'rules', 'ioc'],
  '/security/edr': ['endpoint detection', 'sentinelone', 'huntress', 'defender'],
  '/dns-security': ['dns filtering', 'web filter', 'content filter', 'blocklist'],
  '/pam': ['privileged', 'privileged access', 'elevation', 'admin rights', 'local admin', 'uac'],
  '/security/user-risk': ['risky users', 'identity'],
  '/sensitive-data': ['pii', 'dlp', 'data loss', 'credit card'],
  '/peripherals': ['usb', 'removable', 'devices control', 'external drives'],
  '/ai-risk': ['shadow ai', 'chatgpt', 'llm usage'],
  '/cis-hardening': ['benchmark', 'hardening', 'cis'],
  '/audit-baselines': ['compliance', 'baseline', 'drift'],
  '/backup': ['restore', 'recovery', 'snapshots', 'backups'],
  '/c2c': ['microsoft 365 backup', 'm365 backup', 'google workspace backup', 'cloud to cloud', 'saas backup'],
  '/dr': ['dr', 'failover', 'bare metal', 'bmr', 'business continuity'],
  '/tickets': ['helpdesk', 'help desk', 'service desk', 'support', 'issues', 'cases', 'psa', 'sla'],
  '/timesheet': ['time tracking', 'hours', 'time entries', 'billable'],
  '/billing/quotes': ['proposals', 'estimates'],
  '/billing/invoices': ['billing', 'payments', 'bills', 'invoicing'],
  '/contracts': ['agreements', 'recurring', 'mrr'],
  '/agreements/templates': ['contracts', 'terms', 'signed', 'documents'],
  '/settings/catalog': ['products', 'services', 'pricing', 'skus', 'price list'],
  '/reports': ['export', 'scheduled reports', 'pdf', 'executive summary'],
  '/analytics': ['dashboards', 'charts', 'metrics', 'stats'],
  '/devices/posture': ['health', 'fleet health', 'score'],
  '/devices/time': ['ntp', 'clock', 'time drift'],
  '/audit': ['audit log', 'activity', 'history', 'who did what', 'changes'],
  '/logs': ['event logs', 'logs', 'syslog', 'windows events', 'event viewer'],
};

/** English-only extra terms for Partner Settings sections, keyed by URL hash. */
export const PARTNER_SETTINGS_KEYWORDS: Record<string, readonly string[]> = {
  company: ['business', 'name', 'address', 'logo'],
  regional: ['timezone', 'language', 'locale', 'currency', 'date format'],
  modules: ['features', 'enable', 'service desk', 'products'],
  defaults: ['default settings', 'agent defaults'],
  'event-logs': ['retention', 'logs'],
  'remote-access': ['rdp', 'remote desktop', 'consent', 'session recording'],
  'known-guests': ['wifi', 'guest network'],
  security: ['mfa', '2fa', 'password policy', 'session timeout', 'ip allowlist'],
  'caller-verification': ['phone', 'callers', 'voice'],
  notifications: ['alerts', 'email notifications', 'sms', 'slack', 'teams', 'webhooks', 'channels'],
  'email-templates': ['email templates', 'templates', 'email', 'invoice email', 'quote email', 'invite email'],
  'sending-domains': ['sender', 'dkim', 'spf', 'from address', 'smtp'],
  'ai-provider': ['openai', 'anthropic', 'models', 'api key', 'llm'],
  'ai-features': ['copilot', 'wisp', 'assistant'],
  'ai-budgets': ['spend', 'limits', 'cost', 'credits', 'tokens'],
  'ai-approvals': ['approval', 'human in the loop', 'tool approvals'],
  branding: ['logo', 'colors', 'theme', 'white label', 'whitelabel', 'customize'],
  'login-branding': ['login page', 'sign in page', 'logo', 'white label'],
  'trust-center': ['trust page', 'security page', 'compliance page', 'soc 2'],
  'customer-portal': ['portal', 'registration', 'sign up', 'end users', 'self service'],
};

const matches = (needle: string, ...parts: Array<string | undefined | readonly string[]>): boolean =>
  parts.flat().some((p) => p !== undefined && p.toLowerCase().includes(needle));

/**
 * Sidebar pages for the palette. `ctx` is the palette's partial gate context:
 * flags it does not know (autopay, pre-assignment, AI operator tasks) leave
 * their pages hidden rather than offering a link the sidebar would not show.
 */
export function searchNavPages(
  query: string,
  ctx: NavGateContext,
  translate: SettingsTranslate,
): PaletteIndexHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const hits: PaletteIndexHit[] = [];
  const seen = new Set<string>();
  const consider = (
    items: typeof topLevelNav,
    sectionLabel: string | undefined,
    sectionGate: { requiresModule?: 'service_management' } | undefined,
  ) => {
    for (const item of items) {
      // Settings hubs are covered by the settings catalogue; ticket-type
      // filters depend on org config the palette does not load.
      if (item.hubGroup || item.ticketType || item.requiresAiOperatorTasks) continue;
      if (item.lockedWhenWispOff && ctx.wispEnabled !== true) continue;
      if (sectionGate && !isNavGateVisible(sectionGate, ctx)) continue;
      if (!isNavGateVisible(item, ctx) || seen.has(item.href)) continue;
      const title = translate(item.labelKey ?? '', item.name);
      const href = navItemHref(item, ctx.flowsEnabled);
      // The one Automations entry answers to both the Jobs and the Flows
      // synonyms (Flows' only while Flows is on).
      const keywords = [
        ...(NAV_KEYWORDS[item.href] ?? []),
        ...(href === item.hrefWhenFlows ? NAV_KEYWORDS[href] ?? [] : []),
      ];
      if (matches(needle, title, item.name, sectionLabel, keywords)) {
        seen.add(item.href);
        hits.push({ id: href, title, description: sectionLabel ?? '', href });
      }
    }
  };

  consider(topLevelNav, undefined, undefined);
  for (const section of navSections) {
    const label = translate(section.labelKey ?? '', section.label);
    // A section name ("Security", "Backup") lists the section's pages.
    consider(section.items, label, section);
  }
  return hits;
}

const PARTNER_ENTRY = SETTINGS_CATALOG.find((e) => e.id === 'partner')!;
// Capability-gated sections (their rail visibility is fetched by the page) are
// not offered: the palette cannot know whether they are available.
const CAPABILITY_GATED = new Set(['sendingDomains', 'callerVerification']);

/** Partner Settings sections as `/settings/partner#<hash>` results (#12216). */
export function searchPartnerSettingsTabs(
  query: string,
  ctx: NavGateContext,
  translate: SettingsTranslate,
): PaletteIndexHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle || !isNavGateVisible(PARTNER_ENTRY, ctx)) return [];

  const hits: PaletteIndexHit[] = [];
  for (const tab of ALL_TABS) {
    if (CAPABILITY_GATED.has(tab.key)) continue;
    const title = translate(`settings:${tab.label}`, tab.key);
    const description = translate(`settings:${tab.description}`, '');
    const href = tab.kind === 'link' && tab.href ? tab.href : `/settings/partner#${tab.hash}`;
    if (matches(needle, title, description, PARTNER_SETTINGS_KEYWORDS[tab.hash])) {
      hits.push({ id: `partner-${tab.hash}`, title, description, href });
    }
  }
  return hits;
}
