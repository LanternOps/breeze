import {
  Activity,
  AtSign,
  Bell,
  Blocks,
  Building2,
  Globe,
  Hourglass,
  KeyRound,
  LogIn,
  Mail,
  MonitorSmartphone,
  Palette,
  PhoneCall,
  ScrollText,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Ticket,
  Wallet,
  Wifi,
  type LucideIcon,
} from 'lucide-react';

export type TabKey =
  | 'company' | 'regional' | 'modules'
  | 'defaults' | 'eventLogs' | 'remoteAccess' | 'knownGuests'
  | 'security' | 'callerVerification'
  | 'notifications' | 'emailTemplates' | 'sendingDomains' | 'ticketing'
  | 'aiProvider' | 'aiFeatures' | 'aiBudgets' | 'aiApprovals'
  | 'branding' | 'loginBranding' | 'trustCenter';

export type TabDef = {
  key: TabKey;
  /** Canonical URL fragment (kebab-case). Legacy camelCase keys still resolve. */
  hash: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** `link` tabs navigate to `href` instead of rendering a panel in the page. */
  kind: 'panel' | 'link';
  href?: string;
  /** Values set here are enforced across all organizations (inheritance banner). */
  enforced?: boolean;
};

export type TabGroupId = 'company' | 'devices' | 'security' | 'communications' | 'ai' | 'branding';
export type TabGroup = { id: TabGroupId; label: string; tabs: readonly TabDef[] };

const copy = (key: TabKey) => ({
  label: `partnerSettingsPage.tabs.${key}.label`,
  description: `partnerSettingsPage.tabs.${key}.description`,
});

export const TAB_GROUPS: readonly TabGroup[] = [
  {
    id: 'company',
    label: 'partnerSettingsPage.groups.company',
    tabs: [
      { key: 'company', hash: 'company', ...copy('company'), icon: Building2, kind: 'panel' },
      { key: 'regional', hash: 'regional', ...copy('regional'), icon: Globe, kind: 'panel' },
      { key: 'modules', hash: 'modules', ...copy('modules'), icon: Blocks, kind: 'panel' },
    ],
  },
  {
    id: 'devices',
    label: 'partnerSettingsPage.groups.devices',
    tabs: [
      { key: 'defaults', hash: 'defaults', ...copy('defaults'), icon: SlidersHorizontal, kind: 'panel', enforced: true },
      { key: 'eventLogs', hash: 'event-logs', ...copy('eventLogs'), icon: ScrollText, kind: 'panel', enforced: true },
      { key: 'remoteAccess', hash: 'remote-access', ...copy('remoteAccess'), icon: MonitorSmartphone, kind: 'panel', enforced: true },
      { key: 'knownGuests', hash: 'known-guests', ...copy('knownGuests'), icon: Wifi, kind: 'panel' },
    ],
  },
  {
    id: 'security',
    label: 'partnerSettingsPage.groups.security',
    tabs: [
      { key: 'security', hash: 'security', ...copy('security'), icon: Shield, kind: 'panel', enforced: true },
      // Caller verification (#6354): partner baseline, saved by the header Save.
      { key: 'callerVerification', hash: 'caller-verification', ...copy('callerVerification'), icon: PhoneCall, kind: 'panel' },
    ],
  },
  {
    id: 'communications',
    label: 'partnerSettingsPage.groups.communications',
    tabs: [
      { key: 'notifications', hash: 'notifications', ...copy('notifications'), icon: Bell, kind: 'panel', enforced: true },
      { key: 'emailTemplates', hash: 'email-templates', ...copy('emailTemplates'), icon: Mail, kind: 'panel' },
      { key: 'sendingDomains', hash: 'sending-domains', ...copy('sendingDomains'), icon: AtSign, kind: 'panel' },
      // Ticketing configuration lives on its own page (M0, #6233). The rail
      // shows a link; `#ticketing` still resolves to a static link-out panel
      // and never redirects (browsers that cached the old 301 would loop, #7985).
      { key: 'ticketing', hash: 'ticketing', ...copy('ticketing'), icon: Ticket, kind: 'link', href: '/settings/ticketing' },
    ],
  },
  {
    id: 'ai',
    label: 'partnerSettingsPage.groups.ai',
    tabs: [
      { key: 'aiProvider', hash: 'ai-provider', ...copy('aiProvider'), icon: KeyRound, kind: 'panel' },
      { key: 'aiFeatures', hash: 'ai-features', ...copy('aiFeatures'), icon: Activity, kind: 'panel' },
      { key: 'aiBudgets', hash: 'ai-budgets', ...copy('aiBudgets'), icon: Wallet, kind: 'panel', enforced: true },
      // NOT enforced: inherit-with-override (org wins when set), unlike the
      // aiBudgets tab's partner-locks model — see aiApprovalSettings.ts.
      { key: 'aiApprovals', hash: 'ai-approvals', ...copy('aiApprovals'), icon: Hourglass, kind: 'panel' },
    ],
  },
  {
    id: 'branding',
    label: 'partnerSettingsPage.groups.branding',
    tabs: [
      { key: 'branding', hash: 'branding', ...copy('branding'), icon: Palette, kind: 'panel', enforced: true },
      { key: 'loginBranding', hash: 'login-branding', ...copy('loginBranding'), icon: LogIn, kind: 'panel' },
      // Trust Center W2 (#8770 W02g): partner-wide default for customer trust pages (own load/save, MFA).
      { key: 'trustCenter', hash: 'trust-center', ...copy('trustCenter'), icon: ShieldCheck, kind: 'panel' },
    ],
  },
];

export const ALL_TABS: readonly TabDef[] = TAB_GROUPS.flatMap(g => g.tabs);
export const TAB_BY_KEY = Object.fromEntries(ALL_TABS.map(t => [t.key, t])) as Record<TabKey, TabDef>;

// Canonical kebab-case fragments plus the legacy camelCase keys this page used
// to write (`#eventLogs`, `#remoteAccess`, ...) so old bookmarks keep working.
const HASH_TO_TAB: Record<string, TabKey> = {};
for (const t of ALL_TABS) {
  HASH_TO_TAB[t.hash] = t.key;
  HASH_TO_TAB[t.key] = t.key;
}
HASH_TO_TAB['ai-models'] = 'aiProvider'; // AI Providers & Models (W04 #7602) — canonical stays #ai-provider

/** Map a URL hash (leading `#` optional) to a tab key, or null when unknown. */
export function tabFromHash(hash: string): TabKey | null {
  return HASH_TO_TAB[hash.replace(/^#/, '')] ?? null;
}

/**
 * Rail groups with capability-gated tabs removed. Hash resolution is
 * unaffected: `#sending-domains` and `#caller-verification` still resolve so a
 * bookmark can wait for its capability to settle before falling back.
 */
export function visibleTabGroups(v: { sendingDomains: boolean; callerVerification: boolean }): readonly TabGroup[] {
  return TAB_GROUPS.map(group => ({
    ...group,
    tabs: group.tabs.filter(tab =>
      (tab.key !== 'sendingDomains' || v.sendingDomains) &&
      (tab.key !== 'callerVerification' || v.callerVerification)),
  }));
}
