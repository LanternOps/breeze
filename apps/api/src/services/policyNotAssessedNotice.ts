/**
 * `policy.not_assessed` → a notice to the rule's owner (Strix, PR #12184).
 *
 * The per-org probe cap (policyStateProbes.ts) splits 256 registry and 256
 * config probes between the org's own policies and its partner's partner-wide
 * policies. A rule past its share is not collected, so the evaluator records it
 * as not assessed (`passed: null`, `reason: 'probe_cap'`). That is deliberate
 * (#12130): an uncollected value is no evidence of a violation, so it raises no
 * violation, no alert and no remediation. But it must never be silent, or a
 * rule nobody evaluates looks the same as one not evaluated yet. The evaluator
 * publishes `policy.not_assessed` whenever such a rule is in the result, and
 * this subscriber tells the people who own the rule:
 *
 *   - a partner-wide rule (its policy has org_id NULL): the partner's staff with
 *     full org access who can manage devices, the audience of
 *     canManagePartnerWidePolicies. The org cannot dismiss it for them.
 *   - an org rule: the users holding devices:write for that org.
 *
 * The notice is an in-app notification (userNotifications.createNotification),
 * not an alert: nothing on the device is wrong, nothing should open a ticket or
 * start an automation, and an alert would belong to the org, not the partner.
 *
 * Dedupe: one notice per (rule, device org) per NOT_ASSESSED_NOTICE_PERIOD_MS,
 * however many devices and scans report it. A Redis marker skips repeat events
 * cheaply; the notification's dedupe key (same text) bounds it when Redis is
 * down. While the rule stays uncollected, its owners are reminded once a period.
 *
 * Tenancy: the event's orgId is the DEVICE's org. Like the alert bridges, the
 * policy must be owned by that org, or be partner-wide and owned by that org's
 * partner; anything else is dropped with a warning.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { automationPolicies, automationPolicyCompliance, organizations } from '../db/schema';
import type { BreezeEvent } from './eventBus';
import {
  configComplianceRuleReachesOrg,
  isConfigCompliancePayload,
  loadConfigComplianceEventRule,
  persistedConfigCompliance,
  type ConfigCompliancePayload,
} from './configComplianceAlertBridge';
import { PERMISSIONS } from './permissions';
import { MAX_POLICY_STATE_PROBES_PER_ORG } from './policyStateProbes';
import { getRedis } from './redis';
import { createNotification } from './userNotifications';
import { resolvePartnerUsersWithPermission, resolveUsersWithPermissionForOrg } from './usersWithPermission';

const { db } = dbModule;

/** How often the owners of a rule that stays uncollected are told again. */
export const NOT_ASSESSED_NOTICE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const MARKER_SLACK_SECONDS = 24 * 60 * 60;
const PROBE_CAP_REASON = 'probe_cap';

type NotAssessedPayload = {
  policyId?: string;
  deviceId?: string;
  reason?: string;
  notAssessedRules?: number;
};

/** What the notice is about, and who owns it. */
type Subject = {
  /** Stable across saves and devices: the dedupe key's subject part. */
  ref: string;
  name: string;
  policyName: string;
  ownerScope: 'partner' | 'organization';
  partnerId: string | null;
  /** The device org's name, for the notice text. */
  orgName: string;
  link: string;
  metadata: Record<string, unknown>;
  /** Whether the persisted state still shows a rule left out by the cap. */
  stillNotAssessed: () => Promise<boolean>;
};

function hasProbeCapRule(details: unknown): boolean {
  const ruleResults = (details as { ruleResults?: unknown } | null)?.ruleResults;
  return Array.isArray(ruleResults) && ruleResults.some((r) =>
    typeof r === 'object' && r !== null
    && (r as { passed?: unknown }).passed === null
    && (r as { data?: { reason?: unknown } }).data?.reason === PROBE_CAP_REASON);
}

type OrgRow = { name: string; partnerId: string | null };

async function loadOrg(orgId: string): Promise<OrgRow | null> {
  const [org] = await db
    .select({ name: organizations.name, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return org ?? null;
}

async function automationPolicySubject(orgId: string, deviceId: string, policyId: string): Promise<Subject | null> {
  const [policy] = await db
    .select({ id: automationPolicies.id, name: automationPolicies.name, orgId: automationPolicies.orgId, partnerId: automationPolicies.partnerId })
    .from(automationPolicies)
    .where(eq(automationPolicies.id, policyId))
    .limit(1);
  if (!policy) return null;

  const org = await loadOrg(orgId);
  const reaches = policy.orgId !== null
    ? policy.orgId === orgId
    : !!org && !!policy.partnerId && org.partnerId === policy.partnerId;
  if (!reaches) {
    console.warn(
      `[policyNotAssessedNotice] dropping policy.not_assessed for policy ${policyId}: `
      + `it does not reach event org ${orgId}`,
    );
    return null;
  }

  return {
    ref: `policy:${policy.id}`,
    name: policy.name,
    policyName: policy.name,
    ownerScope: policy.orgId === null ? 'partner' : 'organization',
    partnerId: policy.partnerId,
    orgName: org?.name ?? 'an organization',
    link: `/policies/${policy.id}`,
    metadata: { policyId: policy.id },
    stillNotAssessed: async () => {
      const [row] = await db
        .select({ details: automationPolicyCompliance.details })
        .from(automationPolicyCompliance)
        .where(and(
          eq(automationPolicyCompliance.policyId, policy.id),
          eq(automationPolicyCompliance.deviceId, deviceId),
        ))
        .orderBy(desc(automationPolicyCompliance.updatedAt))
        .limit(1);
      return !!row && hasProbeCapRule(row.details);
    },
  };
}

async function configRuleSubject(orgId: string, deviceId: string, payload: ConfigCompliancePayload): Promise<Subject | null> {
  const rule = await loadConfigComplianceEventRule(payload.configPolicyComplianceRuleId!, payload);
  if (!rule) return null;
  if (!(await configComplianceRuleReachesOrg(rule, orgId))) return null;
  const org = await loadOrg(orgId);

  return {
    ref: configRuleRef(rule.featureLinkId, rule.name),
    name: rule.name,
    policyName: rule.policyName,
    // The link's policy is the one that AUTHORED the rule set, so a rule a
    // partner-wide parent passes down to an org's child is the partner's.
    ownerScope: rule.policyOrgId === null ? 'partner' : 'organization',
    partnerId: rule.policyPartnerId,
    orgName: org?.name ?? 'an organization',
    link: `/configuration-policies/${rule.policyId}`,
    metadata: { configPolicyId: rule.policyId, featureLinkId: rule.featureLinkId, ruleSetName: rule.name },
    stillNotAssessed: async () => {
      const row = await persistedConfigCompliance({ featureLinkId: rule.featureLinkId, ruleName: rule.name }, deviceId);
      return !!row && hasProbeCapRule(row.details);
    },
  };
}

/**
 * A rule set is identified by (feature link, name) across saves; the name is
 * hashed to keep the key short (same scheme as the alert bridge's rule name).
 */
function configRuleRef(featureLinkId: string, ruleName: string): string {
  return `rule:${featureLinkId}:${createHash('sha256').update(ruleName).digest('hex').slice(0, 32)}`;
}

/** The subject ref an event names, before any lookup (for the cheap repeat check). */
function refFromPayload(payload: NotAssessedPayload & ConfigCompliancePayload): string | null {
  if (typeof payload.configPolicyComplianceRuleId === 'string') {
    return payload.configPolicyId && payload.configPolicyComplianceRuleName
      ? configRuleRef(payload.configPolicyId, payload.configPolicyComplianceRuleName)
      : null;
  }
  return typeof payload.policyId === 'string' ? `policy:${payload.policyId}` : null;
}

function noticeKey(ref: string, orgId: string, period: number): string {
  return `policy-not-assessed:${ref}:${orgId}:${period}`;
}

/** Whether this period's notice is already out. Any Redis failure reads as "not yet". */
async function alreadyNoticed(key: string): Promise<boolean> {
  try {
    return ((await getRedis()?.exists(key)) ?? 0) > 0;
  } catch {
    return false;
  }
}

/** true = this event owns the period's notice, false = already sent, null = Redis unavailable. */
async function claimMarker(key: string, ttlSeconds: number): Promise<boolean | null> {
  const redis = getRedis();
  if (!redis) {
    console.warn('[policyNotAssessedNotice] Redis unavailable: relying on the notification dedupe key only', key);
    return null;
  }
  return (await redis.set(key, '1', 'EX', ttlSeconds, 'NX')) === 'OK';
}

async function releaseMarker(key: string): Promise<void> {
  try {
    await getRedis()?.del(key);
  } catch (err) {
    console.error('[policyNotAssessedNotice] failed to release marker', key, err instanceof Error ? err.message : err);
  }
}

function oneLine(text: string, max: number): string {
  return Array.from(text.replace(/[\r\n]+/g, ' ')).slice(0, max).join('');
}

async function notifyOwners(
  orgId: string,
  payload: NotAssessedPayload,
  now: number,
  claimedKeys: string[],
): Promise<void> {
  const deviceId = payload.deviceId!;
  // Checked on an unknown so the false branch keeps the automation payload's type.
  const raw: unknown = payload;
  const subject = isConfigCompliancePayload(raw)
    ? await configRuleSubject(orgId, deviceId, raw)
    : payload.policyId ? await automationPolicySubject(orgId, deviceId, payload.policyId) : null;
  if (!subject) return;

  // The event is a wake-up, not the truth: the evaluation that published it
  // committed its row first, and a newer one may have moved on since.
  if (!(await subject.stillNotAssessed())) return;
  if (subject.ownerScope === 'partner' && !subject.partnerId) return;

  const period = Math.floor(now / NOT_ASSESSED_NOTICE_PERIOD_MS);
  const dedupeKey = noticeKey(subject.ref, orgId, period);
  const periodEndSeconds = Math.ceil(((period + 1) * NOT_ASSESSED_NOTICE_PERIOD_MS - now) / 1000);
  const claimed = await claimMarker(dedupeKey, periodEndSeconds + MARKER_SLACK_SECONDS);
  if (claimed === false) return;
  if (claimed) claimedKeys.push(dedupeKey);

  const recipients = subject.ownerScope === 'partner'
    ? await resolvePartnerUsersWithPermission(subject.partnerId!, PERMISSIONS.DEVICES_WRITE)
    : await resolveUsersWithPermissionForOrg(orgId, PERMISSIONS.DEVICES_WRITE);
  if (recipients.length === 0) {
    // Kept marker: with nobody to tell, re-resolving on every scan buys nothing.
    console.warn(
      `[policyNotAssessedNotice] ${subject.ref} is not assessed in org ${orgId} but its `
      + `${subject.ownerScope} owner has nobody to notify`,
    );
    return;
  }

  const orgName = oneLine(subject.orgName, 120);
  const count = typeof payload.notAssessedRules === 'number' && payload.notAssessedRules > 0
    ? payload.notAssessedRules
    : 1;
  const checks = count === 1 ? '1 check' : `${count} checks`;
  const title = oneLine(`Compliance not assessed: ${subject.name} (${orgName})`, 255);
  const inPolicy = subject.name === subject.policyName ? '' : ` (policy "${subject.policyName}")`;
  const message =
    `${checks} in "${subject.name}"${inPolicy} cannot be assessed on ${orgName}'s devices: `
    + `the organization's compliance probe list is full (${MAX_POLICY_STATE_PROBES_PER_ORG} registry and `
    + `${MAX_POLICY_STATE_PROBES_PER_ORG} config values, half reserved for the organization's own policies `
    + 'and half for partner-wide policies). These checks are not evaluated, alerted on or remediated until '
    + 'there is room. Remove registry or config checks this organization does not need.';

  for (const userId of recipients) {
    await createNotification({
      userId,
      orgId,
      type: 'system',
      priority: 'high',
      title,
      message,
      link: subject.link,
      metadata: {
        event: 'policy.not_assessed',
        reason: PROBE_CAP_REASON,
        ownerScope: subject.ownerScope,
        orgId,
        deviceId,
        notAssessedRules: count,
        ...subject.metadata,
      },
      dedupeKey,
    });
  }
}

/**
 * Handle a `policy.not_assessed` event. Registered under subscriber id
 * `policy-not-assessed-notice` (eventSubscribers.ts). Throws on failure so
 * queue-mode dispatch retries. A marker this event set is released on any
 * failure, including the notice transaction failing to commit, so the retry or
 * the next scan can notify.
 */
export async function handlePolicyNotAssessedEvent(event: BreezeEvent): Promise<void> {
  const payload = (event.payload ?? {}) as NotAssessedPayload & ConfigCompliancePayload;
  if (payload.reason !== PROBE_CAP_REASON || typeof payload.deviceId !== 'string') return;

  // Fires per device per scan: once the period's notice is out, a repeat costs
  // one Redis read and no database work.
  const now = Date.now();
  const ref = refFromPayload(payload);
  if (ref && await alreadyNoticed(noticeKey(ref, event.orgId, Math.floor(now / NOT_ASSESSED_NOTICE_PERIOD_MS)))) return;

  const claimedKeys: string[] = [];
  try {
    await dbModule.withSystemDbAccessContext(() => notifyOwners(event.orgId, payload, now, claimedKeys));
  } catch (err) {
    for (const key of claimedKeys) await releaseMarker(key);
    throw err;
  }
}
