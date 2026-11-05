/**
 * Tool Catalog W06 (#5221) Task A7 — legacy automation rows and conversion
 * contexts for the converter tests: one fixture per conversion-map row.
 */
import type { automations } from '../../../../db/schema';

type AutomationRow = typeof automations.$inferSelect;
import type { ConversionContext } from '../convertAutomation';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const PARTNER = '22222222-2222-4222-8222-222222222222';
export const SCRIPT = '33333333-3333-4333-8333-333333333333';
export const SCRIPT_ELEVATED = '33333333-3333-4333-8333-3333333333ee';
export const GROUP = '44444444-4444-4444-8444-444444444444';
export const CHANNEL = '55555555-5555-4555-8555-555555555555';
export const CHANNEL_PD = '55555555-5555-4555-8555-5555555555bd';
export const AUTOMATION = '66666666-6666-4666-8666-666666666666';
export const CREATOR = '77777777-7777-4777-8777-777777777777';

export function row(over: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: AUTOMATION,
    orgId: ORG,
    partnerId: null,
    managedByAgentId: null,
    managedByMonitorId: null,
    retiredAt: null,
    retiredReason: null,
    convertedToMonitorId: null,
    convertedToFlowId: null,
    name: 'Nightly cleanup',
    description: null,
    enabled: true,
    trigger: { type: 'schedule', cronExpression: '0 2 * * *', timezone: 'UTC' },
    conditions: { type: 'groups', groupIds: [GROUP] },
    actions: [{ type: 'run_script', scriptId: SCRIPT, whenOffline: 'queue' }],
    onFailure: 'stop',
    notificationTargets: null,
    lastRunAt: null,
    runCount: 0,
    createdBy: CREATOR,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as AutomationRow;
}

export function ctx(over: Partial<ConversionContext> = {}): ConversionContext {
  return {
    owner: { orgId: ORG, partnerId: PARTNER },
    flowsEnabled: true,
    eventDispatchDurable: true,
    legacySecretHeaderAllowed: false,
    currentTargets: { count: 30, osTypes: new Set(['windows']) },
    channels: new Map([
      [CHANNEL, { type: 'email', ownedByOwner: true }],
      [CHANNEL_PD, { type: 'pagerduty', ownedByOwner: true }],
    ]),
    scripts: new Map([
      [SCRIPT, { ownedByOwner: true, effectiveRunAs: 'system', preApprovable: true }],
      [SCRIPT_ELEVATED, { ownedByOwner: true, effectiveRunAs: 'elevated', preApprovable: false }],
    ]),
    isRemediationTarget: false,
    liveMonitorConversion: false,
    creatorHasSiteCeiling: false,
    partnerOrgs: null,
    limits: { monthlyRunsPerFlow: 10_000, monthlyRunsPerOwner: 100_000, ownerRunsThisMonth: 0 },
    observedMonthlyRuns: null,
    ...over,
  };
}
