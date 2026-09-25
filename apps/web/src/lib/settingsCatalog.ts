import {
  Bell,
  Bot,
  Braces,
  Building,
  Building2,
  BrainCircuit,
  ClipboardList,
  CreditCard,
  FileCheck,
  FileCode,
  FileSpreadsheet,
  Filter,
  Fingerprint,
  Key,
  KeyRound,
  LayoutTemplate,
  ListChecks,
  Plug,
  Puzzle,
  Tags,
  Ticket,
  UserCircle,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { NavGate } from './navGates';

/**
 * The complete catalogue of settings screens (#6220). Single source of truth for
 * BOTH the /settings index page and the sidebar's Settings group: the sidebar
 * shows the `SIDEBAR_SETTINGS_IDS` subset, /settings shows everything. Gates
 * live here once and are evaluated by `isNavGateVisible` in both places, so the
 * two surfaces can never disagree (settings rule 8: every screen is in the nav,
 * at one URL). Navigation only — no setting changes home.
 *
 * `labelKey` is resolved with `t()` against the `common` namespace by default;
 * entries that have no `nav.*` label use an explicit `pages:` key.
 */
export const SETTINGS_GROUPS = [
  'account',
  'billing',
  'devices',
  'data',
  'ai',
  'integrations',
] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface SettingsCatalogEntry extends NavGate {
  id: string;
  /** English fallback label. */
  name: string;
  labelKey: string;
  /** Optional one-line description key (searched too). */
  descriptionKey?: string;
  href: string;
  icon: LucideIcon;
  group: SettingsGroup;
}

const card = (id: string, field: 'title' | 'description') => `pages:settingsIndex.cards.${id}.${field}`;

export const SETTINGS_CATALOG: SettingsCatalogEntry[] = [
  // Account & Access
  { id: 'partner', name: 'Partner', labelKey: 'nav.partner', descriptionKey: 'settings:partnerSettingsCard.description', href: '/settings/partner', icon: Building, group: 'account', partnerScopeOnly: true },
  { id: 'organizations', name: 'Organizations', labelKey: 'nav.organizations', descriptionKey: card('organizations', 'description'), href: '/organizations', icon: Building2, group: 'account', partnerScopeOnly: true, requiredPermission: { resource: 'organizations', action: 'read' } },
  // Users + Roles are both served by the users routes (users:read).
  { id: 'users', name: 'Users', labelKey: 'nav.users', descriptionKey: card('users', 'description'), href: '/settings/users', icon: Users, group: 'account', requiredPermission: { resource: 'users', action: 'read' } },
  { id: 'roles', name: 'Roles', labelKey: 'nav.roles', href: '/settings/roles', icon: KeyRound, group: 'account', requiredPermission: { resource: 'users', action: 'read' } },
  { id: 'sso', name: 'SSO', labelKey: 'nav.sso', descriptionKey: card('sso', 'description'), href: '/settings/sso', icon: Fingerprint, group: 'account', requiredPermission: { resource: 'sso', action: 'admin' } },
  { id: 'access-reviews', name: 'Access Reviews', labelKey: 'nav.accessReviews', descriptionKey: card('accessReviews', 'description'), href: '/settings/access-reviews', icon: FileCheck, group: 'account', requiredPermission: { resource: 'users', action: 'read' } },
  { id: 'profile', name: 'My profile', labelKey: card('profile', 'title'), href: '/settings/profile', icon: UserCircle, group: 'account' },
  { id: 'api-keys', name: 'API keys', labelKey: card('apiKeys', 'title'), href: '/settings/api-keys', icon: Key, group: 'account' },
  { id: 'partner-service-principals', name: 'Service principals', labelKey: card('partnerServicePrincipals', 'title'), href: '/settings/partner-service-principals', icon: KeyRound, group: 'account', partnerScopeOnly: true },

  // Billing & Service Desk
  { id: 'billing', name: 'Billing', labelKey: 'nav.billing', descriptionKey: card('billing', 'description'), href: '/settings/billing', icon: CreditCard, group: 'billing', partnerScopeOnly: true, requiredPermission: { resource: 'invoices', action: 'write' } },
  { id: 'ticketing', name: 'Ticketing', labelKey: 'nav.ticketing', descriptionKey: card('ticketing', 'description'), href: '/settings/ticketing', icon: Ticket, group: 'billing', partnerScopeOnly: true },
  { id: 'ticket-checklist-templates', name: 'Ticket checklist templates', labelKey: card('ticketChecklistTemplates', 'title'), descriptionKey: card('ticketChecklistTemplates', 'description'), href: '/settings/ticketing#templates', icon: ClipboardList, group: 'billing', partnerScopeOnly: true },
  { id: 'catalog', name: 'Product Catalog', labelKey: 'nav.productCatalog', descriptionKey: card('catalog', 'description'), href: '/settings/catalog', icon: Tags, group: 'billing', partnerScopeOnly: true, requiredPermission: { resource: 'catalog', action: 'read' } },
  { id: 'deliverable-templates', name: 'Deliverable Templates', labelKey: 'nav.deliverableTemplates', descriptionKey: card('deliverableTemplates', 'description'), href: '/settings/deliverable-templates', icon: LayoutTemplate, group: 'billing', partnerScopeOnly: true },

  // Devices & Enrollment
  { id: 'enrollment-keys', name: 'Enrollment Keys', labelKey: 'nav.enrollmentKeys', href: '/settings/enrollment-keys', icon: Key, group: 'devices', requiredPermission: { resource: 'devices', action: 'read' } },

  // Automation & Data
  { id: 'custom-fields', name: 'Custom Fields', labelKey: 'nav.customFields', href: '/settings/custom-fields', icon: ListChecks, group: 'data', requiredPermission: { resource: 'organizations', action: 'read' } },
  { id: 'variables', name: 'Variables', labelKey: 'nav.variables', href: '/settings/variables', icon: Braces, group: 'data', requiredPermission: { resource: 'variables', action: 'read' } },
  { id: 'filters', name: 'Saved Filters', labelKey: 'nav.savedFilters', href: '/settings/filters', icon: Filter, group: 'data' },
  { id: 'alert-templates', name: 'Alert templates', labelKey: card('alertTemplates', 'title'), href: '/settings/alert-templates', icon: Bell, group: 'data', requiredPermission: { resource: 'alerts', action: 'read' } },

  // AI
  { id: 'ai-agents', name: 'AI Agents', labelKey: 'nav.aiAgents', href: '/settings/ai-agents', icon: Bot, group: 'ai', requiredPermission: { resource: 'ai_agents', action: 'read' } },
  { id: 'ai-usage', name: 'AI Usage', labelKey: 'nav.aiUsage', href: '/settings/ai-usage', icon: BrainCircuit, group: 'ai', partnerScopeOnly: true },
  { id: 'ai-script-authoring', name: 'Script authoring', labelKey: 'nav.scriptAuthoring', href: '/settings/ai-script-authoring', icon: FileCode, group: 'ai', requiredPermission: { resource: 'ai_agents', action: 'read' } },
  { id: 'tool-sources', name: 'Tool Sources', labelKey: 'nav.toolSources', href: '/settings/tool-sources', icon: Plug, group: 'ai', requiresToolSources: true, requiredPermission: { resource: 'tool_sources', action: 'read' } },

  // Integrations
  { id: 'integrations', name: 'Integrations', labelKey: 'nav.integrations', href: '/integrations', icon: Plug, group: 'integrations' },
  { id: 'connected-apps', name: 'Connected Apps', labelKey: card('connectedApps', 'title'), descriptionKey: card('connectedApps', 'description'), href: '/settings/connected-apps', icon: Puzzle, group: 'integrations' },
  { id: 'office-addin-bindings', name: 'Outlook Add-in Bindings', labelKey: card('officeAddinBindings', 'title'), descriptionKey: card('officeAddinBindings', 'description'), href: '/settings/office-addin-bindings', icon: FileSpreadsheet, group: 'integrations' },
];

/**
 * The daily-use subset shown in the sidebar Settings group, in display order.
 * Everything else is reached through the "More settings" entry → /settings.
 */
export const SIDEBAR_SETTINGS_IDS = ['partner', 'billing', 'ticketing', 'users', 'integrations'] as const;

export function sidebarSettingsEntries(): SettingsCatalogEntry[] {
  return SIDEBAR_SETTINGS_IDS.map((id) => {
    const entry = SETTINGS_CATALOG.find((e) => e.id === id);
    if (!entry) throw new Error(`settingsCatalog: sidebar id "${id}" has no catalogue entry`);
    return entry;
  });
}
