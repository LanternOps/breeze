import { describe, expect, it } from 'vitest';
import type {
  InheritableAiBudgetSettings,
  InheritableBrandingSettings,
  InheritableDefaultSettings,
  InheritableEventLogSettings,
  InheritableNotificationSettings,
  InheritableRemoteAccessSettings,
  InheritableSecuritySettings,
  PartnerNetworkProxySettings,
  PartnerSettings,
} from '../types';
import type { AiApprovalSettings } from '../validators/aiApprovalSettings';
import { AI_BUDGET_DEFAULTS } from '../constants/aiBudgetDefaults';
import {
  CATALOG_BY_ID,
  CATALOG_TAB_KEYS,
  COUNT_TERMS,
  PARTNER_SETTINGS_CATALOG,
  catalogForTab,
} from './partnerSettingsCatalog';

/**
 * Every leaf of the partner settings types the catalog covers. A leaf is a
 * scalar, an array, or an open-ended dictionary (`preferences`,
 * `policyDefaults`, `businessHours.custom`); optional nested objects recurse.
 *
 * `satisfies LeafMap<T>` makes a new field on any of these types a type error
 * here until it is listed, and the test below then fails until the catalog has
 * an entry for it.
 */
type LeafMap<T> = { [K in keyof Required<T>]-?: true | LeafMap<NonNullable<Required<T>[K]>> };

type RegionalSettings = Pick<PartnerSettings, 'timezone' | 'dateFormat' | 'timeFormat' | 'language'> & {
  businessHours?: { preset: unknown; custom?: unknown };
};

const LEAVES = {
  security: {
    minLength: true,
    complexity: true,
    expirationDays: true,
    requireMfa: true,
    allowedMethods: { totp: true, sms: true },
    sessionTimeout: true,
    maxSessions: true,
    ipAllowlist: true,
  } satisfies LeafMap<InheritableSecuritySettings>,
  notifications: {
    fromAddress: true,
    replyTo: true,
    useCustomSmtp: true,
    smtpHost: true,
    smtpPort: true,
    smtpUsername: true,
    smtpEncryption: true,
    slackWebhookUrl: true,
    slackChannel: true,
    webhooks: true,
    preferences: true,
    pushoverAppToken: true,
    pushoverDefaultUser: true,
    pushoverDefaultSound: true,
    pushoverDefaultPriority: true,
    pushoverTicketAssignmentFallback: true,
  } satisfies LeafMap<InheritableNotificationSettings>,
  eventLogs: {
    enabled: true,
    elasticsearchUrl: true,
    elasticsearchApiKey: true,
    elasticsearchUsername: true,
    elasticsearchPassword: true,
    indexPrefix: true,
  } satisfies LeafMap<InheritableEventLogSettings>,
  defaults: {
    policyDefaults: true,
    autoEnrollment: { enabled: true, requireApproval: true },
    agentUpdatePolicy: true,
    maintenanceWindow: true,
    agentVersionPins: { agent: true, watchdog: true },
    defaultEnrollmentTtlMinutes: true,
    defaultEnrollmentDeviceCount: true,
    maxEnrollmentLinkTtlMinutes: true,
  // `deviceGroup` is org-level only (#9617): the partner tab has no control and the
  // resolver ignores a partner value, so it has no catalog entry.
  } satisfies LeafMap<Omit<InheritableDefaultSettings, 'deviceGroup'>>,
  branding: {
    logoUrl: true,
    primaryColor: true,
    secondaryColor: true,
    theme: true,
    customCss: true,
  } satisfies LeafMap<InheritableBrandingSettings>,
  aiBudgets: {
    enabled: true,
    monthlyBudgetCents: true,
    dailyBudgetCents: true,
    maxTurnsPerSession: true,
    messagesPerMinutePerUser: true,
    messagesPerHourPerOrg: true,
    approvalMode: true,
    alertThresholdPercents: true,
    toolRateLimitMultiplier: true,
  } satisfies LeafMap<InheritableAiBudgetSettings>,
  aiApprovals: {
    interactiveTimeoutMinutes: true,
  } satisfies LeafMap<AiApprovalSettings>,
  remoteAccessProviders: {
    providers: true,
    defaultProviderId: true,
  } satisfies LeafMap<InheritableRemoteAccessSettings>,
  networkProxy: {
    dedicatedTunnelOrigin: true,
  } satisfies LeafMap<PartnerNetworkProxySettings>,
  // Regional fields sit on PartnerSettings itself, so their paths have no prefix.
  regional: {
    timezone: true,
    dateFormat: true,
    timeFormat: true,
    language: true,
    businessHours: { preset: true, custom: true },
  } satisfies LeafMap<RegionalSettings>,
};

function flatten(map: Record<string, unknown>, prefix: string): string[] {
  return Object.entries(map).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value === true ? [path] : flatten(value as Record<string, unknown>, path);
  });
}

const ALL_LEAF_PATHS = Object.entries(LEAVES).flatMap(([category, map]) =>
  flatten(map, category === 'regional' ? '' : category),
);

describe('partner settings catalog', () => {
  it('every leaf of the settings types has an entry', () => {
    const covered = PARTNER_SETTINGS_CATALOG.flatMap((e) => e.paths);
    for (const leaf of ALL_LEAF_PATHS) {
      expect(covered.filter((p) => p === leaf), leaf).toHaveLength(1);
    }
    // ...and no entry names a path the types do not have.
    expect([...covered].sort()).toEqual([...ALL_LEAF_PATHS].sort());
  });

  it('ids are unique and stable', () => {
    const ids = PARTNER_SETTINGS_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toMatchInlineSnapshot(`
      [
        "regional.timezone",
        "regional.dateFormat",
        "regional.timeFormat",
        "regional.language",
        "regional.businessHours",
        "security.minLength",
        "security.complexity",
        "security.expirationDays",
        "security.requireMfa",
        "security.allowedMethods",
        "security.sessionTimeout",
        "security.maxSessions",
        "security.ipAllowlist",
        "notifications.fromAddress",
        "notifications.replyTo",
        "notifications.useCustomSmtp",
        "notifications.smtpHost",
        "notifications.smtpPort",
        "notifications.smtpUsername",
        "notifications.smtpEncryption",
        "notifications.slackWebhookUrl",
        "notifications.slackChannel",
        "notifications.webhooks",
        "notifications.preferences",
        "notifications.pushoverAppToken",
        "notifications.pushoverDefaultUser",
        "notifications.pushoverDefaultSound",
        "notifications.pushoverDefaultPriority",
        "notifications.pushoverTicketAssignmentFallback",
        "eventLogs",
        "defaults.policyDefaults",
        "defaults.autoEnrollment",
        "defaults.agentUpdatePolicy",
        "defaults.maintenanceWindow",
        "defaults.agentVersionPins.agent",
        "defaults.agentVersionPins.watchdog",
        "defaults.defaultEnrollmentTtlMinutes",
        "defaults.defaultEnrollmentDeviceCount",
        "defaults.maxEnrollmentLinkTtlMinutes",
        "branding.logoUrl",
        "branding.primaryColor",
        "branding.secondaryColor",
        "branding.theme",
        "branding.customCss",
        "aiBudgets.enabled",
        "aiBudgets.monthlyBudgetCents",
        "aiBudgets.dailyBudgetCents",
        "aiBudgets.maxTurnsPerSession",
        "aiBudgets.messagesPerMinutePerUser",
        "aiBudgets.messagesPerHourPerOrg",
        "aiBudgets.approvalMode",
        "aiBudgets.alertThresholdPercents",
        "aiBudgets.toolRateLimitMultiplier",
        "aiApprovals.interactiveTimeoutMinutes",
        "remoteAccessProviders.providers",
        "remoteAccessProviders.defaultProviderId",
        "networkProxy.dedicatedTunnelOrigin",
      ]
    `);
  });

  it('every id and path segment is a safe identifier', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      expect(entry.id).toMatch(/^[A-Za-z0-9_.]+$/);
      for (const path of entry.paths) {
        for (const segment of path.split('.')) expect(segment, entry.id).toMatch(/^[A-Za-z0-9_]+$/);
      }
    }
  });

  it('secret ⇒ presence', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => e.secret)) {
      expect(entry.projection.kind, entry.id).toBe('presence');
    }
  });

  it('cap has a cap field', () => {
    const capped = PARTNER_SETTINGS_CATALOG.filter((e) => e.qualifier === 'cap');
    expect(capped.length).toBeGreaterThan(0);
    for (const entry of capped) {
      expect(entry.capFieldId, entry.id).toBeDefined();
      expect(CATALOG_BY_ID[entry.capFieldId!], entry.id).toBeDefined();
    }
    // capFieldId only ever accompanies the cap qualifier.
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => e.qualifier !== 'cap')) {
      expect(entry.capFieldId, entry.id).toBeUndefined();
    }
  });

  it('unclassified has no qualifier and no consumers', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG.filter((e) => e.kind === 'unclassified')) {
      expect(entry.qualifier, entry.id).toBeUndefined();
      expect(entry.consumers, entry.id).toBeUndefined();
    }
  });

  it('every entry belongs to a known tab and catalogForTab partitions the catalog', () => {
    const byTab = CATALOG_TAB_KEYS.flatMap((tab) => catalogForTab(tab));
    expect(byTab).toHaveLength(PARTNER_SETTINGS_CATALOG.length);
    for (const tab of CATALOG_TAB_KEYS) {
      for (const entry of catalogForTab(tab)) expect(entry.tab).toBe(tab);
    }
  });

  it('CATALOG_BY_ID indexes every entry', () => {
    expect(Object.keys(CATALOG_BY_ID)).toHaveLength(PARTNER_SETTINGS_CATALOG.length);
    for (const entry of PARTNER_SETTINGS_CATALOG) expect(CATALOG_BY_ID[entry.id]).toBe(entry);
  });

  it('platform defaults come from their owners, not copies', () => {
    for (const [field, value] of Object.entries(AI_BUDGET_DEFAULTS)) {
      expect(CATALOG_BY_ID[`aiBudgets.${field}`]?.platformDefault, field).toBe(value);
    }
  });

  it('orgSettingsHash is a kebab-case hash or null', () => {
    for (const entry of PARTNER_SETTINGS_CATALOG) {
      if (entry.orgSettingsHash !== null) expect(entry.orgSettingsHash, entry.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('COUNT_TERMS defines every count word', () => {
    expect(Object.keys(COUNT_TERMS).sort()).toEqual(['inEffect', 'overrides', 'ownValue', 'shadowed']);
    for (const text of Object.values(COUNT_TERMS)) expect(text.length).toBeGreaterThan(10);
  });

  it('the catalog is frozen', () => {
    expect(Object.isFrozen(PARTNER_SETTINGS_CATALOG)).toBe(true);
    expect(Object.isFrozen(CATALOG_BY_ID)).toBe(true);
  });
});
