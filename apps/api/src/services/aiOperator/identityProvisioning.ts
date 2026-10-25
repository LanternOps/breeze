/**
 * `identity_onboarding` discovery — the collision pre-reads, the live seat
 * read and the model-after read (W07 Task 7; Amendment B6, B.0 items 12, 15
 * and 16, B.9 item 7; D-R2-4, D-R2-5 as amended, D-R2-9).
 *
 * Coordinator-issued deterministic reads (spec §6.2 sentence 3). Nothing here
 * consults a model, and nothing here writes — not even an audit row: the M365
 * reads go through `executeM365ReadActionByOrg`, which does its own auditing.
 * The result is the part of snapshot 1's `facts` discovery owns
 * (`collisions`, `seats`, `groups`, `modelAfter`, `flags`, `truncated`); the
 * `discover` advancer adds `stage`, `targets`, `degradedTools` and
 * `capabilityReadiness` and seals it. It is the mirror of R1's
 * `identityDiscovery.ts` and reuses its limits, its read helpers and its
 * transient-fault rule rather than declaring new ones.
 *
 * THE FAILURE RULE (R1's, B.0 item 16). A read that decides the plan has three
 * outcomes, never two:
 *  - a definitive answer (found / not found) is recorded as such;
 *  - a NON-transient refusal (permissions, no connection, a malformed answer)
 *    is recorded as "could not check" — `null` / `unknown` / not described —
 *    plus a flag. "We could not check" never reads as "the name is free" or
 *    "a seat is free": `buildPlan` treats every non-`false` collision, every
 *    non-`available` seat and every undescribed group as blocking;
 *  - a TRANSIENT fault (throttling, an executor or network outage, a Breeze
 *    db error) THROWS `DiscoveryTransientError`, so the wake retries.
 *    `discover` runs once and freezes what it saw; a 503 must not be frozen.
 * The one exception is the connection's per-minute read budget running out in
 * the middle of a per-group loop: what was found is KEPT and the list is
 * recorded as truncated (R1's rule), because a retry would spend the same
 * budget the same way.
 *
 * WHAT DECIDES THE PLAN, AND WHAT DOES NOT. Collisions, seats and the
 * requested groups (`groups.*`, including the model-after person's Google
 * role in each) decide it. The model-after person's own access (`modelAfter`)
 * is informational — the INPUT is the list the recipe plans from — so its
 * failures are flags, never rethrows, except the Google user read that
 * establishes whose role is being checked.
 *
 * SEATS ARE THE LIVE READ (B6). `m365.org.skus.list`, under the org context,
 * frozen per requested SKU. The sync table is deliberately not read: its
 * `is_stale` is not a freshness signal and it coerces malformed counts for
 * reporting. A SKU absent from a COMPLETE collection is `not_subscribed`; one
 * absent from a TRUNCATED collection (the executor caps `/subscribedSkus` at
 * 60 items) is `unknown`. A missing or malformed count is `unknown`, never 0.
 * Dispatch stays authoritative: the licence-assign executor re-reads
 * `/subscribedSkus` before writing.
 *
 * GOOGLE IS NOT SEAT-CHECKED. Workspace licences are billed per assignment and
 * `licenseAssignments.insert` has no seat ceiling to read. Do not add one.
 *
 * ROLE-ASSIGNABLE M365 GROUPS CANNOT BE DETECTED (B.0 item 15). No read
 * projection carries `isAssignableToRole`, so every M365 group is reported
 * `roleAssignable: null` — unknown, never `false`, which would claim the
 * group is safe to edit. The recipe plans unknown-role groups and the write
 * executor's `unsupported_group_type` gate is the backstop. Dynamic membership
 * IS detected (`groupTypes`, or a `membershipRule`), and reported, not hidden:
 * the recipe excludes it.
 *
 * TENANT ISOLATION. Every provider read resolves its connection inside a db
 * context scoped to exactly this org (`inOrgContext`). The Breeze reads run in
 * system scope, so each carries an explicit `org_id` predicate — that
 * predicate IS the isolation. A model-after contact, manager or site that is
 * not this org's is flagged, and a foreign model-after contact's provider
 * accounts are never read.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { licensing_v1 } from '@googleapis/licensing';
import type { IdentityOnboardingInput } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contactExternalLinks, contacts } from '../../db/schema/contacts';
import { sites } from '../../db/schema/orgs';
import { canonicalizeUserEmail, resolveContextByOrg } from '../aiToolsGoogle';
import { getDirectoryClient, getLicensingClient, normalizeGoogleError } from '../googleClient';
import {
  clip,
  Collector,
  DISCOVERY_FACTS_MAX_BYTES,
  DISCOVERY_LIMITS,
  DiscoveryTransientError,
  errorMessage,
  GOOGLE_LICENSE_MAX_PAGES,
  GOOGLE_LICENSE_PRODUCT_IDS,
  googleFailureFlag,
  inOrgContext,
  isTransientGoogle,
  M365ReadFailed,
  m365FailureFlag,
  m365Read,
  rethrowIfTransientM365,
  type DiscoveryFlagRow,
} from './identityDiscovery';
import type { IdentityOnboardingCreateFacts, OnboardingSeatFact } from './recipes/identityOnboarding';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** Exactly the fields of snapshot 1 that discovery owns (`identityOnboardingCreateFactsSchema`). */
export type OnboardingDiscoveryFacts = Pick<
  IdentityOnboardingCreateFacts,
  'collisions' | 'seats' | 'groups' | 'modelAfter' | 'flags' | 'truncated'
>;

export interface DiscoverOnboardingFactsInput {
  orgId: string;
  /** The frozen, parsed recipe input (the task checkpoint's `recipeInput`). */
  input: IdentityOnboardingInput;
  now?: Date;
}

/** The facts schema's bounds (`recipes/identityOnboarding.ts`), enforced at collection. */
const FLAGS_MAX = 64;
const SKU_ID_MAX = 64;
const SKU_PART_MAX = 128;
const GOOGLE_LICENSE_FIELD_MAX = 128;
const MODEL_AFTER_SKUS_MAX = 60;
const MODEL_AFTER_GOOGLE_LICENSES_MAX = 20;

/** `subscribedSku.capabilityStatus` values under which a seat can be assigned. */
const ASSIGNABLE_CAPABILITY_STATUSES: ReadonlySet<string> = new Set(['Enabled', 'Warning']);

type M365Group = OnboardingDiscoveryFacts['groups']['m365'][number];
type GoogleGroup = OnboardingDiscoveryFacts['groups']['google'][number];
type GoogleRole = GoogleGroup['modelAfterRole'];
type ModelAfter = NonNullable<OnboardingDiscoveryFacts['modelAfter']>;

/** R1's collector, with the facts schema's 64-flag ceiling applied at collection. */
class OnboardingCollector extends Collector {
  override flag(code: string, subject: string, detail: string): void {
    if (this.flags.length >= FLAGS_MAX) { this.truncate('flags'); return; }
    super.flag(code, subject, detail);
  }
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// ---------------------------------------------------------------------------
// Breeze reads (system scope, explicit org predicate on every one)
// ---------------------------------------------------------------------------

interface BreezeFacts {
  /** Null when no model-after was named or it is not this org's contact. */
  modelAfter: { contactId: string; label: string | null; m365Id: string | null; googleId: string | null } | null;
  modelAfterForeign: boolean;
  managerForeign: boolean;
  siteForeign: boolean;
}

async function readBreeze(orgId: string, input: IdentityOnboardingInput): Promise<BreezeFacts> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const out: BreezeFacts = { modelAfter: null, modelAfterForeign: false, managerForeign: false, siteForeign: false };
    if (input.modelAfterContactId) {
      const [row] = await db
        .select({ id: contacts.id, name: contacts.name, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.id, input.modelAfterContactId)))
        .limit(1);
      if (!row) {
        out.modelAfterForeign = true;
      } else {
        // Read, never resolved: onboarding creates no link for a third party.
        const links = await db
          .select({ system: contactExternalLinks.system, externalId: contactExternalLinks.externalId })
          .from(contactExternalLinks)
          .where(and(
            eq(contactExternalLinks.orgId, orgId),
            eq(contactExternalLinks.contactId, row.id),
            inArray(contactExternalLinks.system, ['m365', 'google']),
          ))
          .limit(10);
        const linked = (system: 'm365' | 'google') => links.find((l) => l.system === system)?.externalId ?? null;
        out.modelAfter = {
          contactId: row.id,
          label: clip(row.name) ?? clip(row.email),
          m365Id: linked('m365'),
          googleId: linked('google'),
        };
      }
    }
    if (input.managerContactId) {
      const [row] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.orgId, orgId), eq(contacts.id, input.managerContactId)))
        .limit(1);
      out.managerForeign = !row;
    }
    if (input.siteId) {
      const [row] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.orgId, orgId), eq(sites.id, input.siteId)))
        .limit(1);
      out.siteForeign = !row;
    }
    return out;
  }));
}

// ---------------------------------------------------------------------------
// Microsoft 365
// ---------------------------------------------------------------------------

type M365Collision = NonNullable<OnboardingDiscoveryFacts['collisions']['m365']>;

const COULD_NOT_CHECK_M365: M365Collision = Object.freeze({ upnTaken: null, existingObjectId: null });

async function m365Collision(orgId: string, rawUpn: string, c: Collector): Promise<M365Collision> {
  const upn = canonicalizeUserEmail(rawUpn);
  if (!upn) {
    c.flag('m365_collision_check_failed', rawUpn,
      'The sign-in name is not a single plain address, so Breeze did not look it up and cannot say whether it is free.');
    return { ...COULD_NOT_CHECK_M365 };
  }
  try {
    const r = await m365Read(orgId, { type: 'm365.user.get', userIdOrUpn: upn });
    if (r.kind === 'resource' && typeof r.resource.id === 'string' && r.resource.id.length > 0) {
      return { upnTaken: true, existingObjectId: clip(r.resource.id) };
    }
    c.flag('m365_collision_check_failed', upn, 'Microsoft 365 answered the sign-in name lookup without a user id.');
    return { ...COULD_NOT_CHECK_M365 };
  } catch (err) {
    if (err instanceof M365ReadFailed && err.code === 'graph_not_found') return { upnTaken: false, existingObjectId: null };
    rethrowIfTransientM365(err);
    const code = err instanceof M365ReadFailed ? err.code : 'error';
    c.flag('m365_collision_check_failed', upn,
      `Breeze could not check whether ${upn} is free in Microsoft 365 (${code}): ${errorMessage(err)}`);
    return { ...COULD_NOT_CHECK_M365 };
  }
}

/** B6: one requested SKU's state from the live list. Pure. */
function seatFromItem(skuId: string, item: Record<string, unknown>, observedAt: string): OnboardingSeatFact {
  const skuPartNumber = clip(item.skuPartNumber)?.slice(0, SKU_PART_MAX) ?? null;
  const consumed = item.consumedUnits;
  const prepaid = item.prepaidUnits as Record<string, unknown> | null | undefined;
  const enabled = prepaid && typeof prepaid === 'object' ? prepaid.enabled : undefined;
  if (!isCount(consumed) || !isCount(enabled)) {
    return { skuId, skuPartNumber, state: 'unknown', available: null, observedAt,
      reason: 'Microsoft 365 returned missing or malformed seat counts for this licence.' };
  }
  const available = Math.max(0, enabled - consumed);
  const status = typeof item.capabilityStatus === 'string' ? item.capabilityStatus : null;
  if (status !== null && !ASSIGNABLE_CAPABILITY_STATUSES.has(status)) {
    return { skuId, skuPartNumber, state: 'unavailable', available, observedAt,
      reason: `The subscription for this licence is ${status.slice(0, 32)}, so it cannot be assigned.` };
  }
  return available > 0
    ? { skuId, skuPartNumber, state: 'available', available, observedAt, reason: null }
    : { skuId, skuPartNumber, state: 'unavailable', available, observedAt,
      reason: `No free seat: ${consumed} of ${enabled} assigned.` };
}

async function m365Seats(
  orgId: string, skuIds: readonly string[], subject: string, observedAt: string, c: Collector,
): Promise<OnboardingSeatFact[]> {
  if (skuIds.length === 0) return [];
  const unknownAll = (reason: string): OnboardingSeatFact[] => skuIds.map((skuId) => ({
    skuId, skuPartNumber: null, state: 'unknown', available: null, observedAt, reason,
  }));
  let list: Awaited<ReturnType<typeof m365Read>>;
  try {
    list = await m365Read(orgId, { type: 'm365.org.skus.list' });
  } catch (err) {
    rethrowIfTransientM365(err);
    m365FailureFlag(c, subject, err, 'seats');
    const code = err instanceof M365ReadFailed ? err.code : 'error';
    return unknownAll(`Breeze could not read the organization's licences (${code}).`);
  }
  if (list.kind !== 'collection') {
    c.flag('m365_seats_read_failed', subject, 'Microsoft 365 answered the licence list with a single object.');
    return unknownAll('Microsoft 365 returned an unexpected answer to the licence list.');
  }
  const byId = new Map<string, Record<string, unknown>>();
  // An item whose skuId cannot be read could be any requested SKU, so it
  // spoils "absent" exactly as truncation does.
  let unreadable = false;
  for (const item of list.items) {
    const id = typeof item.skuId === 'string' && item.skuId.length > 0 ? item.skuId.toLowerCase() : null;
    if (id === null) { unreadable = true; continue; }
    if (!byId.has(id)) byId.set(id, item);
  }
  return skuIds.map((raw): OnboardingSeatFact => {
    const skuId = raw.slice(0, SKU_ID_MAX);
    const item = byId.get(skuId.toLowerCase());
    if (item) return seatFromItem(skuId, item, observedAt);
    if (list.truncated || unreadable) {
      return { skuId, skuPartNumber: null, state: 'unknown', available: null, observedAt,
        reason: list.truncated
          ? 'Microsoft 365 returned only the first licences of a longer list, and this one was not among them.'
          : 'Microsoft 365 returned a licence entry Breeze could not read, which may be this one.' };
    }
    return { skuId, skuPartNumber: null, state: 'not_subscribed', available: null, observedAt,
      reason: 'The organization is not subscribed to this licence.' };
  });
}

function m365GroupFrom(id: string, g: Record<string, unknown>): M365Group {
  const rule = typeof g.membershipRule === 'string' && g.membershipRule.trim().length > 0;
  const dynamic = Array.isArray(g.groupTypes)
    ? g.groupTypes.includes('DynamicMembership') || rule
    : (rule ? true : null);
  // roleAssignable: UNKNOWN (B.0 item 15) — never false.
  return { id, name: clip(g.displayName), dynamic, roleAssignable: null };
}

interface M365GroupList { items: Record<string, unknown>[]; truncated: boolean }

/**
 * The org's group list, read once and shared by the requested-group lookup and
 * the model-after membership scan. Null when it could not be read (flagged).
 */
async function m365GroupList(orgId: string, subject: string, c: Collector): Promise<M365GroupList | null> {
  try {
    const r = await m365Read(orgId, { type: 'm365.group.list', pageSize: 50 });
    if (r.kind !== 'collection') {
      c.flag('m365_groups_read_failed', subject, 'Microsoft 365 answered the group list with a single object.');
      return null;
    }
    return { items: r.items, truncated: r.truncated };
  } catch (err) {
    rethrowIfTransientM365(err);
    m365FailureFlag(c, subject, err, 'groups');
    return null;
  }
}

/**
 * Describe each REQUESTED group. A group the facts do not describe is never
 * planned (`not_described`), so every failure here fails closed. A group
 * missing from a complete list does not exist; one missing from a truncated
 * list is read by id.
 */
async function m365RequestedGroups(
  orgId: string, groupIds: readonly string[], list: M365GroupList | null, c: Collector,
): Promise<M365Group[]> {
  if (groupIds.length === 0 || list === null) return [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const g of list.items) if (typeof g.id === 'string') byId.set(g.id.toLowerCase(), g);
  const out: M365Group[] = [];
  let budgetSpent = false;
  for (const id of groupIds) {
    if (out.length >= DISCOVERY_LIMITS.groups) { c.truncate('m365.requestedGroups'); break; }
    const listed = byId.get(id.toLowerCase());
    if (listed) { out.push(m365GroupFrom(id, listed)); continue; }
    if (!list.truncated) {
      c.flag('m365_group_not_found', id, 'This Microsoft 365 group is not in the organization\'s group list.');
      continue;
    }
    if (budgetSpent) continue;
    try {
      const r = await m365Read(orgId, { type: 'm365.group.get', groupId: id });
      if (r.kind === 'resource' && typeof r.resource.id === 'string' && r.resource.id.toLowerCase() === id.toLowerCase()) {
        out.push(m365GroupFrom(id, r.resource));
      } else {
        c.flag('m365_group_read_failed', id, 'Microsoft 365 returned a different object for this group id.');
      }
    } catch (err) {
      if (err instanceof M365ReadFailed && err.code === 'read_rate_limited') {
        // The rest stay undescribed — never planned — and say so.
        budgetSpent = true;
        c.truncate('m365.requestedGroups');
        continue;
      }
      if (err instanceof M365ReadFailed && err.code === 'graph_not_found') {
        c.flag('m365_group_not_found', id, 'This Microsoft 365 group does not exist.');
        continue;
      }
      rethrowIfTransientM365(err);
      m365FailureFlag(c, id, err, 'group');
    }
  }
  return out;
}

/** The model-after person's M365 licences and groups. Informational: failures flag, never throw. */
async function m365ModelAfter(
  orgId: string, externalId: string, label: string, list: M365GroupList | null, c: Collector,
): Promise<ModelAfter['m365']> {
  let user: Record<string, unknown>;
  try {
    const r = await m365Read(orgId, { type: 'm365.user.get', userIdOrUpn: externalId });
    if (r.kind !== 'resource') throw new M365ReadFailed('graph_response_invalid', 'user read returned a collection');
    user = r.resource;
  } catch (err) {
    m365FailureFlag(c, label, err, 'user');
    return null;
  }
  if (user.id !== externalId) {
    c.flag('m365_account_mismatch', label, 'Microsoft 365 returned a different user for the model-after person\'s linked account.');
    return null;
  }
  const skuIds: string[] = [];
  for (const a of Array.isArray(user.assignedLicenses) ? user.assignedLicenses : []) {
    const skuId = clip((a as Record<string, unknown> | null)?.skuId);
    if (!skuId || skuId.length > SKU_ID_MAX || skuIds.includes(skuId)) continue;
    if (skuIds.length >= Math.min(DISCOVERY_LIMITS.licenses, MODEL_AFTER_SKUS_MAX)) { c.truncate('modelAfter.m365.licenses'); break; }
    skuIds.push(skuId);
  }

  // No "groups for a user" read exists: test membership per group (R1's scan).
  const groupIds: string[] = [];
  if (list === null) {
    c.truncate('modelAfter.m365.groups');
  } else {
    if (list.truncated) c.truncate('modelAfter.m365.groups');
    for (const g of list.items) {
      const id = clip(g.id);
      if (!id) continue;
      if (groupIds.length >= DISCOVERY_LIMITS.groups) { c.truncate('modelAfter.m365.groups'); break; }
      let member: Awaited<ReturnType<typeof m365Read>>;
      try {
        member = await m365Read(orgId, { type: 'm365.group.member.get', groupId: id, userId: externalId });
      } catch (err) {
        if (!(err instanceof M365ReadFailed && err.code === 'read_rate_limited')) {
          m365FailureFlag(c, label, err, 'model_after_groups');
        }
        // Keep what was found; the rest is "review by hand".
        c.truncate('modelAfter.m365.groups');
        break;
      }
      if (member.kind === 'collection' && member.items.some((i) => i.id === externalId)) groupIds.push(id);
    }
  }
  return { groupIds, skuIds };
}

async function readM365(
  orgId: string, input: IdentityOnboardingInput, modelAfter: BreezeFacts['modelAfter'], observedAt: string, c: Collector,
): Promise<{
  collision: OnboardingDiscoveryFacts['collisions']['m365'];
  seats: OnboardingSeatFact[];
  groups: M365Group[];
  modelAfter: ModelAfter['m365'];
}> {
  const m = input.m365;
  if (m === null) return { collision: null, seats: [], groups: [], modelAfter: null };
  const subject = canonicalizeUserEmail(m.userPrincipalName) ?? m.userPrincipalName;
  // Sequential, in this order, ON PURPOSE: the connection's read budget is
  // per minute, so the reads that decide the plan go first and the
  // informational model-after scan spends whatever is left.
  const collision = await m365Collision(orgId, m.userPrincipalName, c);
  const seats = await m365Seats(orgId, m.skuIds, subject, observedAt, c);
  const maId = modelAfter?.m365Id ?? null;
  const list = m.groupIds.length > 0 || maId !== null ? await m365GroupList(orgId, subject, c) : null;
  const groups = await m365RequestedGroups(orgId, m.groupIds, list, c);
  let ma: ModelAfter['m365'] = null;
  if (modelAfter && maId) {
    ma = await m365ModelAfter(orgId, maId, modelAfter.label ?? modelAfter.contactId, list, c);
  } else if (modelAfter) {
    c.flag('model_after_no_m365_account', modelAfter.label ?? modelAfter.contactId,
      'The model-after person has no linked Microsoft 365 account, so their Microsoft 365 access was not read.');
  }
  return { collision, seats, groups, modelAfter: ma };
}

// ---------------------------------------------------------------------------
// Google Workspace
// ---------------------------------------------------------------------------

type GoogleCollision = NonNullable<OnboardingDiscoveryFacts['collisions']['google']>;
type DirectoryClient = ReturnType<typeof getDirectoryClient>;

const COULD_NOT_CHECK_GOOGLE: GoogleCollision = Object.freeze({ emailTaken: null, existingUserId: null });

function googleTransient(err: unknown): DiscoveryTransientError {
  return new DiscoveryTransientError('google', normalizeGoogleError(err).code, errorMessage(err));
}

async function googleCollision(dir: DirectoryClient, rawEmail: string, c: Collector): Promise<GoogleCollision> {
  const email = canonicalizeUserEmail(rawEmail);
  if (!email) {
    c.flag('google_collision_check_failed', rawEmail,
      'The primary address is not a single plain address, so Breeze did not look it up and cannot say whether it is free.');
    return { ...COULD_NOT_CHECK_GOOGLE };
  }
  try {
    const res = await dir.users.get({ userKey: email });
    const id = clip(res.data.id);
    if (id) return { emailTaken: true, existingUserId: id };
    c.flag('google_collision_check_failed', email, 'Google Workspace answered the address lookup without a user id.');
    return { ...COULD_NOT_CHECK_GOOGLE };
  } catch (err) {
    if (normalizeGoogleError(err).code === 'google_not_found') return { emailTaken: false, existingUserId: null };
    if (isTransientGoogle(err)) throw googleTransient(err);
    googleFailureFlag(c, 'google_collision_check_failed', email, err, 'address lookup');
    return { ...COULD_NOT_CHECK_GOOGLE };
  }
}

/**
 * The model-after person's Google identity, verified by its immutable id. A
 * transient fault rethrows: whose role is checked in each requested group
 * decides the plan. A definitive failure is a flag and an unknown identity.
 */
async function googleModelAfterIdentity(
  dir: DirectoryClient, externalId: string, label: string, c: Collector,
): Promise<{ id: string; primaryEmail: string } | null> {
  try {
    const res = await dir.users.get({ userKey: externalId });
    const pe = typeof res.data.primaryEmail === 'string' ? canonicalizeUserEmail(res.data.primaryEmail) : null;
    if (res.data.id !== externalId || !pe) {
      c.flag('google_account_mismatch', label,
        'Google Workspace returned a different (or address-less) user for the model-after person\'s linked account.');
      return null;
    }
    return { id: externalId, primaryEmail: pe };
  } catch (err) {
    if (isTransientGoogle(err)) throw googleTransient(err);
    googleFailureFlag(c, 'google_read_failed', label, err, 'model-after user');
    return null;
  }
}

/**
 * Describe each REQUESTED Google group, with the model-after person's role in
 * it. Fails closed: a group that cannot be read, or whose role for an
 * IDENTIFIED model-after person cannot be read, is not described and so is
 * never planned. With no identified model-after person the role is `null`.
 */
async function googleRequestedGroups(
  dir: DirectoryClient, groupEmails: readonly string[], ma: { id: string } | null, c: Collector,
): Promise<GoogleGroup[]> {
  const out: GoogleGroup[] = [];
  for (const raw of groupEmails) {
    if (out.length >= DISCOVERY_LIMITS.groups) { c.truncate('google.requestedGroups'); break; }
    const email = canonicalizeUserEmail(raw);
    if (!email) {
      c.flag('google_group_address_invalid', raw, 'The group address is not a single plain address, so Breeze did not read it.');
      continue;
    }
    let name: string | null;
    try {
      const res = await dir.groups.get({ groupKey: email });
      name = clip(res.data.name);
    } catch (err) {
      if (normalizeGoogleError(err).code === 'google_not_found') {
        c.flag('google_group_not_found', email, 'This Google group does not exist.');
        continue;
      }
      if (isTransientGoogle(err)) throw googleTransient(err);
      googleFailureFlag(c, 'google_group_read_failed', email, err, 'group');
      continue;
    }
    let modelAfterRole: GoogleRole = null;
    if (ma) {
      try {
        const res = await dir.members.get({ groupKey: email, memberKey: ma.id });
        const role = res.data.role;
        if (role === 'MEMBER' || role === 'MANAGER' || role === 'OWNER') {
          modelAfterRole = role;
        } else {
          c.flag('google_group_role_read_failed', email, 'Google Workspace returned no recognisable role for the model-after person.');
          continue;
        }
      } catch (err) {
        // 404: the model-after person is not a direct member — no role to copy.
        if (normalizeGoogleError(err).code !== 'google_not_found') {
          if (isTransientGoogle(err)) throw googleTransient(err);
          googleFailureFlag(c, 'google_group_role_read_failed', email, err, 'group role');
          continue;
        }
      }
    }
    out.push({ email, name, modelAfterRole });
  }
  return out;
}

/** The model-after person's Google groups and licences. Informational: failures flag, never throw. */
async function googleModelAfterAccess(
  ctx: { keyJson: string; adminEmail: string }, dir: DirectoryClient, ma: { id: string; primaryEmail: string },
  label: string, c: Collector,
): Promise<NonNullable<ModelAfter['google']>> {
  const groupEmails: string[] = [];
  try {
    const res = await dir.groups.list({ userKey: ma.id, maxResults: 200 });
    const groups = res.data.groups ?? [];
    if (res.data.nextPageToken) c.truncate('modelAfter.google.groups');
    for (const g of groups) {
      const email = typeof g.email === 'string' ? canonicalizeUserEmail(g.email) : null;
      if (!email || groupEmails.includes(email)) continue;
      if (groupEmails.length >= DISCOVERY_LIMITS.groups) { c.truncate('modelAfter.google.groups'); break; }
      groupEmails.push(email);
    }
  } catch (err) {
    googleFailureFlag(c, 'google_groups_read_failed', label, err, 'model-after groups');
    c.truncate('modelAfter.google.groups');
  }

  const licenses: Array<{ productId: string; skuId: string }> = [];
  const cap = Math.min(DISCOVERY_LIMITS.licenses, MODEL_AFTER_GOOGLE_LICENSES_MAX);
  try {
    const lic = getLicensingClient(ctx.keyJson, ctx.adminEmail);
    outer: for (const productId of GOOGLE_LICENSE_PRODUCT_IDS) {
      let pageToken: string | undefined;
      for (let page = 0; page < GOOGLE_LICENSE_MAX_PAGES; page += 1) {
        let res: { data: licensing_v1.Schema$LicenseAssignmentList };
        try {
          res = await lic.licenseAssignments.listForProduct({
            productId, customerId: 'my_customer', maxResults: 1000, ...(pageToken ? { pageToken } : {}),
          });
        } catch (err) {
          // A product this customer does not subscribe to answers 400/404: no assignments.
          if (normalizeGoogleError(err).code === 'google_not_found' || (err as { code?: unknown })?.code === 400) break;
          throw err;
        }
        for (const a of res.data.items ?? []) {
          const user = typeof a.userId === 'string' ? canonicalizeUserEmail(a.userId) : null;
          if (user !== ma.primaryEmail) continue;
          const skuId = clip(a.skuId);
          if (!skuId || skuId.length > GOOGLE_LICENSE_FIELD_MAX) continue;
          if (licenses.length >= cap) { c.truncate('modelAfter.google.licenses'); break outer; }
          licenses.push({ productId: (clip(a.productId) ?? productId).slice(0, GOOGLE_LICENSE_FIELD_MAX), skuId });
        }
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
        if (page === GOOGLE_LICENSE_MAX_PAGES - 1) c.truncate('modelAfter.google.licenses');
      }
    }
  } catch (err) {
    googleFailureFlag(c, 'google_licenses_read_failed', label, err, 'model-after licences');
    c.truncate('modelAfter.google.licenses');
  }
  return { groupEmails, licenses };
}

async function readGoogle(
  orgId: string, input: IdentityOnboardingInput, modelAfter: BreezeFacts['modelAfter'], c: Collector,
): Promise<{
  collision: OnboardingDiscoveryFacts['collisions']['google'];
  groups: GoogleGroup[];
  modelAfter: ModelAfter['google'];
}> {
  const g = input.google;
  if (g === null) return { collision: null, groups: [], modelAfter: null };
  const subject = canonicalizeUserEmail(g.primaryEmail) ?? g.primaryEmail;

  let ctx: Awaited<ReturnType<typeof resolveContextByOrg>>;
  try {
    ctx = await inOrgContext(orgId, () => resolveContextByOrg(orgId));
  } catch (err) {
    // A throw here is Breeze I/O (the connection row, its key), not a fact.
    throw new DiscoveryTransientError('google', 'connection', errorMessage(err));
  }
  const unavailable = (err?: unknown) => {
    if (err === undefined) {
      c.flag('google_connection_unavailable', subject, 'No usable Google Workspace connection for this organization.');
    } else {
      googleFailureFlag(c, 'google_connection_unavailable', subject, err, 'connection');
    }
    return { collision: { ...COULD_NOT_CHECK_GOOGLE }, groups: [], modelAfter: null };
  };
  if ('error' in ctx) return unavailable();
  let dir: DirectoryClient;
  try {
    dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
  } catch (err) {
    // A key that will not build a client is a fact about the connection, not a blip.
    return unavailable(err);
  }

  const collision = await googleCollision(dir, g.primaryEmail, c);
  let ma: { id: string; primaryEmail: string } | null = null;
  const maLabel = modelAfter ? modelAfter.label ?? modelAfter.contactId : '';
  if (modelAfter && modelAfter.googleId) {
    ma = await googleModelAfterIdentity(dir, modelAfter.googleId, maLabel, c);
  } else if (modelAfter) {
    c.flag('model_after_no_google_account', maLabel,
      'The model-after person has no linked Google Workspace account, so their Google access and group roles were not read.');
  }
  const groups = await googleRequestedGroups(dir, g.groupEmails, ma, c);
  const maAccess = ma ? await googleModelAfterAccess({ keyJson: ctx.keyJson, adminEmail: ctx.conn.adminEmail }, dir, ma, maLabel, c) : null;
  return { collision, groups, modelAfter: maAccess };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Discover what onboarding needs before it plans. Read-only and model-free.
 *
 * THROWS `DiscoveryTransientError` on a transient fault of any read that
 * decides the plan, and rethrows a Breeze db error: both are retried by the
 * wake, never frozen. Every other provider failure is a recorded fact.
 */
export async function discoverOnboardingFacts(args: DiscoverOnboardingFactsInput): Promise<OnboardingDiscoveryFacts> {
  const { orgId, input } = args;
  const observedAt = (args.now ?? new Date()).toISOString();
  const c = new OnboardingCollector();

  const breeze = await readBreeze(orgId, input);
  if (breeze.modelAfterForeign && input.modelAfterContactId) {
    c.flag('model_after_not_in_org', input.modelAfterContactId,
      'The model-after contact is not a contact of this organization, so nobody\'s access was read or copied.');
  }
  if (breeze.managerForeign && input.managerContactId) {
    c.flag('manager_not_in_org', input.managerContactId, 'The manager is not a contact of this organization.');
  }
  if (breeze.siteForeign && input.siteId) {
    c.flag('site_not_in_org', input.siteId, 'The site is not a site of this organization.');
  }

  const [m365, google] = await Promise.all([
    readM365(orgId, input, breeze.modelAfter, observedAt, c),
    readGoogle(orgId, input, breeze.modelAfter, c),
  ]);

  const facts: OnboardingDiscoveryFacts = {
    collisions: { m365: m365.collision, google: google.collision },
    seats: { m365: m365.seats },
    groups: { m365: m365.groups, google: google.groups },
    modelAfter: breeze.modelAfter
      ? { contactId: breeze.modelAfter.contactId, label: breeze.modelAfter.label, m365: m365.modelAfter, google: google.modelAfter }
      : null,
    flags: c.flags as DiscoveryFlagRow[],
    truncated: c.truncated,
  };
  enforceByteBudget(facts);
  return facts;
}

/**
 * The facts are sealed into the `discover` step row's checkpoint (64 KiB
 * `pg_column_size` CHECK); `DISCOVERY_FACTS_MAX_BYTES` is R1's backstop for
 * pathological provider data. Shedding order is the order of harm: the
 * informational model-after lists first, then flags, and the requested-group
 * descriptions last — a requested group that is dropped becomes undescribed,
 * which the recipe turns into a manual item rather than planning it.
 * Collisions and seats are never shed (bounded, and they decide the plan).
 */
function enforceByteBudget(facts: OnboardingDiscoveryFacts): void {
  const ma = facts.modelAfter;
  const tiers: Array<Array<[string, unknown[]]>> = [
    [
      ...(ma?.google ? [['modelAfter.google.groups', ma.google.groupEmails] as [string, unknown[]]] : []),
      ...(ma?.m365 ? [['modelAfter.m365.groups', ma.m365.groupIds] as [string, unknown[]]] : []),
      ...(ma?.google ? [['modelAfter.google.licenses', ma.google.licenses] as [string, unknown[]]] : []),
      ...(ma?.m365 ? [['modelAfter.m365.licenses', ma.m365.skuIds] as [string, unknown[]]] : []),
    ],
    [['flags', facts.flags]],
    [['google.requestedGroups', facts.groups.google], ['m365.requestedGroups', facts.groups.m365]],
  ];
  for (const tier of tiers) {
    while (Buffer.byteLength(JSON.stringify(facts)) > DISCOVERY_FACTS_MAX_BYTES) {
      const [name, longest] = tier.reduce((a, b) => (b[1].length > a[1].length ? b : a), ['', []] as [string, unknown[]]);
      if (longest.length === 0) break;
      longest.pop();
      if (!facts.truncated.includes(name)) facts.truncated.push(name);
    }
  }
}

// ---------------------------------------------------------------------------
// The draft's reads (W07 R2a Task 14, Amendment G7)
// ---------------------------------------------------------------------------

/** What `POST /task-drafts` may know before anything exists: the two collision checks and the seats. */
export interface OnboardingDraftReads {
  collisions: OnboardingDiscoveryFacts['collisions'];
  seats: OnboardingDiscoveryFacts['seats'];
  flags: DiscoveryFlagRow[];
}

/**
 * The read-only subset of discovery a DRAFT runs (G7): at most ONE audited
 * `m365.user.get` (the sign-in name), ONE `m365.org.skus.list` (B6's live
 * seat read) and ONE Google `users.get` (the primary email). No group, no
 * model-after and no Breeze read.
 *
 * NEVER THROWS FOR A PROVIDER. Discovery rethrows a transient fault so the
 * wake retries; a draft has no wake, and a provider outage must not reach the
 * technician as a 5xx. Each read is therefore wrapped: whatever escapes it is
 * "could not check" plus a flag (`m365_collision_check_failed`,
 * `google_collision_check_failed`, `m365_seats_read_failed`), which the
 * recipe treats exactly as it treats discovery's: blocking, never "free".
 * Nothing is retried.
 */
export async function readOnboardingDraftFacts(args: DiscoverOnboardingFactsInput): Promise<OnboardingDraftReads> {
  const { orgId, input } = args;
  const observedAt = (args.now ?? new Date()).toISOString();
  const c = new OnboardingCollector();

  const readM365Draft = async (): Promise<{ collision: OnboardingDiscoveryFacts['collisions']['m365']; seats: OnboardingSeatFact[] }> => {
    const m = input.m365;
    if (m === null) return { collision: null, seats: [] };
    const subject = canonicalizeUserEmail(m.userPrincipalName) ?? m.userPrincipalName;
    let collision: M365Collision;
    try {
      collision = await m365Collision(orgId, m.userPrincipalName, c);
    } catch (err) {
      c.flag('m365_collision_check_failed', subject,
        `Breeze could not check whether ${subject} is free in Microsoft 365: ${errorMessage(err)}`);
      collision = { ...COULD_NOT_CHECK_M365 };
    }
    let seats: OnboardingSeatFact[];
    try {
      seats = await m365Seats(orgId, m.skuIds, subject, observedAt, c);
    } catch (err) {
      c.flag('m365_seats_read_failed', subject, `Breeze could not read the organization's licences: ${errorMessage(err)}`);
      seats = m.skuIds.map((skuId): OnboardingSeatFact => ({
        skuId: skuId.slice(0, SKU_ID_MAX), skuPartNumber: null, state: 'unknown', available: null, observedAt,
        reason: 'Breeze could not read the organization\'s licences.',
      }));
    }
    return { collision, seats };
  };

  const readGoogleDraft = async (): Promise<OnboardingDiscoveryFacts['collisions']['google']> => {
    const g = input.google;
    if (g === null) return null;
    const subject = canonicalizeUserEmail(g.primaryEmail) ?? g.primaryEmail;
    try {
      const ctx = await inOrgContext(orgId, () => resolveContextByOrg(orgId));
      if ('error' in ctx) {
        c.flag('google_connection_unavailable', subject, 'No usable Google Workspace connection for this organization.');
        return { ...COULD_NOT_CHECK_GOOGLE };
      }
      return await googleCollision(getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail), g.primaryEmail, c);
    } catch (err) {
      c.flag('google_collision_check_failed', subject,
        `Breeze could not check whether ${subject} is free in Google Workspace: ${errorMessage(err)}`);
      return { ...COULD_NOT_CHECK_GOOGLE };
    }
  };

  const [m365, google] = await Promise.all([readM365Draft(), readGoogleDraft()]);
  return {
    collisions: { m365: m365.collision, google },
    seats: { m365: m365.seats },
    flags: c.flags as DiscoveryFlagRow[],
  };
}
