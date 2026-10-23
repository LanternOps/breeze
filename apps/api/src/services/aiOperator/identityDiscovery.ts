/**
 * `identity_offboarding` discovery — coordinator-issued deterministic reads
 * (Recipe Library spec §6.2 sentence 3: "Discovery reads are
 * coordinator-issued tool calls, not model-chosen"; W06 R1a Task 6).
 *
 * Nothing here consults a model, and the model never selects what is read.
 * The result is the `facts` the `discover` step freezes into the planning
 * snapshot, which `buildPlan` reads and E4 seals into an approval. So it is:
 *
 *  - BOUNDED. Every array is capped at the point of COLLECTION, with the cap
 *    recorded in `truncated` — never sliced at the end, which would still pay
 *    the provider round trips the cap exists to avoid. Strings are clipped,
 *    so the capped worst case stays well under the 64 KiB checkpoint bound.
 *  - TOTAL, BUT NOT FORGETFUL. A provider's definitive answer (not found,
 *    a different user, a refusal for permissions) yields `present: false` or
 *    an empty sub-list plus a deterministic flag: a missing provider degrades
 *    the recipe, it does not fail the task (spec §4.1). A TRANSIENT failure of
 *    an account read (throttling, an executor or network outage, a Breeze db
 *    error) throws `DiscoveryTransientError` instead, so the wake retries —
 *    `discover` runs once and freezes what it saw, and a 503 must not be
 *    frozen as "this person has no Microsoft 365 account".
 *  - IN AN ORG-SCOPED DB CONTEXT. The operator task worker calls advancers
 *    with no db context, and both connection tables have forced RLS: a
 *    contextless connection lookup is denied and reads as "not connected".
 *    Every provider read resolves its connection inside a context scoped to
 *    exactly this org (the M365 effect probe's pattern).
 *  - READ-ONLY. No write of any kind. The M365 reads go through
 *    `executeM365ReadActionByOrg`, which does its own auditing.
 *  - TENANT-SCOPED. The two Breeze reads (device suggestions, the inheritor's
 *    address) run in system scope, so each carries an explicit `org_id`
 *    predicate; that predicate IS the isolation.
 *
 * Provider asymmetries, recorded here because they shape the plan:
 *  - M365 group OWNERSHIP has no read action (D-R1-7). Every M365 group is
 *    `ownership: 'unknown'`; the recipe turns each into a manual
 *    "confirm another owner" item. Google exposes the member role, so Google
 *    groups get a real `sole | shared | none`.
 *  - M365 role-assignable groups cannot be detected: no read projection
 *    carries `isAssignableToRole` (the write executor reads it itself and
 *    refuses `unsupported_group_type`). `roleAssignable` is therefore always
 *    false here; dynamic membership IS detected from `groupTypes`.
 *  - There is no M365 "groups for a user" read, so membership is tested per
 *    group over `m365.group.list` (pages of 50, a few pages at most). That is
 *    one read per group against the connection's per-minute read budget, so a
 *    large tenant exhausts it mid-scan: the groups found so far are KEPT and
 *    the list is recorded as truncated (`m365.groups`), which becomes a
 *    "review the rest by hand" item — never silently emptied. A user-centric
 *    membership read is a follow-up.
 *  - Breeze devices are SUGGESTIONS from `devices.last_user`, an unvalidated
 *    OS username string (D-R1-8). They are never an effect target.
 */
import { and, eq, ilike } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema/devices';
import { contacts } from '../../db/schema/contacts';
import { executeM365ReadActionByOrg } from '../m365ControlPlane/readActionService';
import { canonicalizeUserEmail, resolveContextByOrg } from '../aiToolsGoogle';
import type { licensing_v1 } from '@googleapis/licensing';
import { getDirectoryClient, getLicensingClient, normalizeGoogleError } from '../googleClient';

export const DISCOVERY_LIMITS = Object.freeze({
  groups: 100,
  licenses: 25,
  mobileDevices: 25,
  intuneDevices: 25,
  suggestedDevices: 25,
} as const);

/** Clip every provider-sourced string; keeps the capped worst case bounded. */
const MAX_FIELD_CHARS = 160;

/** Google licence product ids discovery checks for an assignment. */
const GOOGLE_LICENSE_PRODUCT_IDS = Object.freeze(['Google-Apps', 'Google-Vault', '101031', '101033', '101034']);
/** Pages of 1000 assignments per product; past this the licence list is truncated. */
const GOOGLE_LICENSE_MAX_PAGES = 10;

export type GroupOwnership = 'sole' | 'shared' | 'none' | 'unknown';
export interface DiscoveredGroup {
  id: string;
  name: string;
  email: string | null;
  ownership: GroupOwnership;
  dynamic: boolean;
  roleAssignable: boolean;
}
export interface DiscoveredLicense { productId: string | null; skuId: string; name: string | null }
export interface DiscoveredMobileDevice { id: string; model: string | null; status: string | null }
export interface DiscoveredSuggestedDevice {
  deviceId: string;
  hostname: string | null;
  lastUser: string | null;
  matchBasis: 'last_user_ilike';
}
export interface GoogleIdentityFacts {
  present: boolean;
  externalId: string | null;
  primaryEmail: string | null;
  suspended: boolean | null;
  groups: DiscoveredGroup[];
  licenses: DiscoveredLicense[];
  mobileDevices: DiscoveredMobileDevice[];
}
export interface M365IdentityFacts {
  present: boolean;
  externalId: string | null;
  userPrincipalName: string | null;
  accountEnabled: boolean | null;
  groups: DiscoveredGroup[];
  licenses: DiscoveredLicense[];
  intuneDevices: DiscoveredMobileDevice[];
}
export interface DiscoveryFlagRow { code: string; subject: string; detail: string }
export interface IdentityDiscoveryFacts {
  version: 1;
  /** ISO-8601. */
  observedAt: string;
  google: GoogleIdentityFacts;
  m365: M365IdentityFacts;
  breeze: { suggestedDevices: DiscoveredSuggestedDevice[] };
  /** The inheritor contact's frozen address, when one was named. */
  inheritor: { contactId: string; email: string | null } | null;
  /** Deterministic flags — provider errors, mismatches. NOT the model's. */
  flags: DiscoveryFlagRow[];
  /** e.g. ['google.groups'] — lists that hit their cap. */
  truncated: string[];
}
export interface DiscoverIdentityFactsInput {
  orgId: string;
  accounts: ReadonlyArray<{ provider: 'm365' | 'google'; externalId: string; principalLabel: string }>;
  inheritorContactId?: string | null;
  now?: Date;
}

function clip(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, MAX_FIELD_CHARS) : null;
}

function emptyGoogle(): GoogleIdentityFacts {
  return { present: false, externalId: null, primaryEmail: null, suspended: null, groups: [], licenses: [], mobileDevices: [] };
}
function emptyM365(): M365IdentityFacts {
  return { present: false, externalId: null, userPrincipalName: null, accountEnabled: null, groups: [], licenses: [], intuneDevices: [] };
}

class Collector {
  readonly flags: DiscoveryFlagRow[] = [];
  readonly truncated: string[] = [];
  flag(code: string, subject: string, detail: string): void {
    this.flags.push({ code, subject: subject.slice(0, MAX_FIELD_CHARS), detail: detail.slice(0, 500) });
  }
  truncate(what: string): void {
    if (!this.truncated.includes(what)) this.truncated.push(what);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An account read failed for a reason that says nothing about the person —
 * throttling, an outage, a Breeze db error. Thrown so the wake retries rather
 * than freezing "no account" into the planning snapshot.
 */
export class DiscoveryTransientError extends Error {
  constructor(readonly provider: 'm365' | 'google', readonly code: string, message: string) {
    super(`identity discovery: transient ${provider} failure (${code}): ${message}`);
    this.name = 'DiscoveryTransientError';
  }
}

/** Resolve a provider connection in a db context scoped to exactly this org. */
function inOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId], label: 'aiOperator.identityDiscovery' },
    fn,
  ));
}

// ---------------------------------------------------------------------------
// Microsoft 365
// ---------------------------------------------------------------------------

type M365Action = Parameters<typeof executeM365ReadActionByOrg>[1];
type M365Result = Awaited<ReturnType<typeof executeM365ReadActionByOrg>>;

/** Read codes that mean "this tenant must re-consent", not "something is broken". */
const M365_CONSENT_CODES: ReadonlySet<string> = new Set(['graph_permission_missing', 'consent_upgrade_required']);

class M365ReadFailed extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Codes that describe the pipe, not the person: retry rather than conclude. */
const M365_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'executor_unavailable', 'read_rate_limited', 'graph_throttled', 'graph_transport_failed', 'graph_request_timeout',
]);

async function m365Read(orgId: string, action: M365Action): Promise<Exclude<M365Result, { ok: false }>> {
  const result = await inOrgContext(orgId, () => executeM365ReadActionByOrg(orgId, action));
  if (!result.ok) throw new M365ReadFailed(result.code, result.message);
  return result;
}

/** The account read's failure, classified: transient → throw; definitive → flag. */
function rethrowIfTransientM365(err: unknown): void {
  if (!(err instanceof M365ReadFailed)) {
    throw new DiscoveryTransientError('m365', 'error', errorMessage(err));
  }
  if (M365_TRANSIENT_CODES.has(err.code)) throw new DiscoveryTransientError('m365', err.code, err.message);
}

function m365FailureFlag(c: Collector, subject: string, err: unknown, what: string): void {
  if (err instanceof M365ReadFailed && M365_CONSENT_CODES.has(err.code)) {
    c.flag('m365_consent_upgrade_required', subject,
      `Microsoft 365 refused the ${what} read for missing permissions: re-consent Microsoft 365.`);
    return;
  }
  const code = err instanceof M365ReadFailed ? err.code : 'transport';
  c.flag(what === 'user' ? 'm365_read_failed' : `m365_${what}_read_failed`, subject,
    `The Microsoft 365 ${what} read failed (${code}): ${errorMessage(err)}`);
}

async function readM365(orgId: string, externalId: string, label: string, c: Collector): Promise<M365IdentityFacts> {
  let user: Record<string, unknown>;
  try {
    const r = await m365Read(orgId, { type: 'm365.user.get', userIdOrUpn: externalId });
    if (r.kind !== 'resource') throw new M365ReadFailed('graph_response_invalid', 'user read returned a collection');
    user = r.resource;
  } catch (err) {
    rethrowIfTransientM365(err);
    m365FailureFlag(c, label, err, 'user');
    return emptyM365();
  }
  // The frozen account is addressed by its immutable object id; a response
  // naming a different user is never planned against.
  if (user.id !== externalId) {
    c.flag('m365_account_mismatch', label, 'Microsoft 365 returned a different user for the frozen account id.');
    return emptyM365();
  }
  const facts: M365IdentityFacts = {
    present: true,
    externalId,
    userPrincipalName: clip(user.userPrincipalName),
    accountEnabled: typeof user.accountEnabled === 'boolean' ? user.accountEnabled : null,
    groups: [],
    licenses: [],
    intuneDevices: [],
  };

  // Licences: the sku ids from the user read; part numbers are a display nicety.
  const assigned = Array.isArray(user.assignedLicenses) ? user.assignedLicenses : [];
  const skuIds: string[] = [];
  for (const a of assigned) {
    const skuId = clip((a as Record<string, unknown> | null)?.skuId);
    if (!skuId || skuIds.includes(skuId)) continue;
    if (skuIds.length >= DISCOVERY_LIMITS.licenses) { c.truncate('m365.licenses'); break; }
    skuIds.push(skuId);
  }
  let partNumbers = new Map<string, string>();
  if (skuIds.length > 0) {
    try {
      const r = await m365Read(orgId, { type: 'm365.org.skus.list' });
      if (r.kind === 'collection') {
        partNumbers = new Map(r.items.flatMap((s) => {
          const id = clip(s.skuId); const part = clip(s.skuPartNumber);
          return id && part ? [[id, part] as const] : [];
        }));
      }
    } catch {
      // Display only; the plan uses the sku ids from Graph.
    }
  }
  facts.licenses = skuIds.map((skuId) => ({ productId: null, skuId, name: partNumbers.get(skuId) ?? null }));

  // Groups: enumerate the org's groups, test membership per group.
  try {
    const list = await m365Read(orgId, { type: 'm365.group.list', pageSize: 50 });
    if (list.kind === 'collection') {
      if (list.truncated) c.truncate('m365.groups');
      for (const g of list.items) {
        const id = clip(g.id);
        if (!id) continue;
        let member: Awaited<ReturnType<typeof m365Read>>;
        try {
          member = await m365Read(orgId, { type: 'm365.group.member.get', groupId: id, userId: externalId });
        } catch (err) {
          // The read budget ran out mid-scan: keep what was found, say so.
          if (err instanceof M365ReadFailed && err.code === 'read_rate_limited') {
            c.truncate('m365.groups');
            break;
          }
          throw err;
        }
        if (member.kind !== 'collection' || !member.items.some((i) => i.id === externalId)) continue;
        if (facts.groups.length >= DISCOVERY_LIMITS.groups) { c.truncate('m365.groups'); break; }
        const groupTypes = Array.isArray(g.groupTypes) ? g.groupTypes : [];
        facts.groups.push({
          id,
          name: clip(g.displayName) ?? id,
          email: clip(g.mail),
          ownership: 'unknown',
          dynamic: groupTypes.includes('DynamicMembership'),
          roleAssignable: false,
        });
      }
    }
  } catch (err) {
    facts.groups = [];
    m365FailureFlag(c, label, err, 'groups');
  }

  // Intune devices: no per-user filter exists; match the UPN locally.
  try {
    const list = await m365Read(orgId, { type: 'm365.intune.device.list', pageSize: 50 });
    if (list.kind === 'collection') {
      if (list.truncated) c.truncate('m365.intuneDevices');
      const upn = facts.userPrincipalName?.toLowerCase() ?? null;
      for (const d of list.items) {
        if (!upn || typeof d.userPrincipalName !== 'string' || d.userPrincipalName.toLowerCase() !== upn) continue;
        const id = clip(d.id);
        if (!id) continue;
        if (facts.intuneDevices.length >= DISCOVERY_LIMITS.intuneDevices) { c.truncate('m365.intuneDevices'); break; }
        facts.intuneDevices.push({ id, model: clip(d.deviceName), status: null });
      }
    }
  } catch (err) {
    facts.intuneDevices = [];
    m365FailureFlag(c, label, err, 'intune');
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Google Workspace
// ---------------------------------------------------------------------------

/** Throttling, a 5xx, or no HTTP response at all (network): retry, never conclude. */
function isTransientGoogle(err: unknown): boolean {
  if (normalizeGoogleError(err).code === 'google_rate_limited') return true;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const status = [e?.response?.status, e?.status, e?.code].find((v): v is number => typeof v === 'number');
  return status === undefined ? true : status >= 500;
}

function googleFailureFlag(c: Collector, code: string, subject: string, err: unknown, what: string): void {
  const norm = normalizeGoogleError(err);
  c.flag(code, subject, `The Google Workspace ${what} read failed (${norm.code}): ${norm.message}`);
}

async function readGoogle(orgId: string, externalId: string, label: string, c: Collector): Promise<GoogleIdentityFacts> {
  let ctx: Awaited<ReturnType<typeof resolveContextByOrg>>;
  try {
    ctx = await inOrgContext(orgId, () => resolveContextByOrg(orgId));
  } catch (err) {
    // A throw here is Breeze I/O (the connection row, its key), not a fact.
    throw new DiscoveryTransientError('google', 'connection', errorMessage(err));
  }
  if ('error' in ctx) {
    c.flag('google_connection_unavailable', label, 'No usable Google Workspace connection for this organization.');
    return emptyGoogle();
  }

  let dir: ReturnType<typeof getDirectoryClient>;
  try {
    dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
  } catch (err) {
    // A key that will not build a client is a fact about the connection, not a blip.
    googleFailureFlag(c, 'google_connection_unavailable', label, err, 'connection');
    return emptyGoogle();
  }
  let primaryEmail: string;
  let suspended: boolean | null;
  try {
    const res = await dir.users.get({ userKey: externalId });
    if (res.data.id !== externalId) {
      c.flag('google_account_mismatch', label, 'Google Workspace returned a different user for the frozen account id.');
      return emptyGoogle();
    }
    const pe = typeof res.data.primaryEmail === 'string' ? canonicalizeUserEmail(res.data.primaryEmail) : null;
    if (!pe) {
      c.flag('google_read_failed', label, 'The Google Workspace user has no canonical primary address.');
      return emptyGoogle();
    }
    primaryEmail = pe;
    suspended = typeof res.data.suspended === 'boolean' ? res.data.suspended : null;
  } catch (err) {
    if (isTransientGoogle(err)) throw new DiscoveryTransientError('google', normalizeGoogleError(err).code, errorMessage(err));
    googleFailureFlag(c, 'google_read_failed', label, err, 'user');
    return emptyGoogle();
  }
  const facts: GoogleIdentityFacts = {
    present: true, externalId, primaryEmail, suspended, groups: [], licenses: [], mobileDevices: [],
  };

  // Groups, with the person's role in each; owners re-read only where they own it.
  try {
    const res = await dir.groups.list({ userKey: externalId, maxResults: 200 });
    const groups = res.data.groups ?? [];
    if (groups.length > DISCOVERY_LIMITS.groups || res.data.nextPageToken) c.truncate('google.groups');
    for (const g of groups.slice(0, DISCOVERY_LIMITS.groups)) {
      const id = clip(g.id);
      const email = clip(g.email);
      if (!id) continue;
      let ownership: GroupOwnership = 'unknown';
      if (email) {
        const role = await dir.members.get({ groupKey: email, memberKey: primaryEmail });
        if (role.data.role === 'OWNER') {
          const owners = await dir.members.list({ groupKey: email, roles: 'OWNER', maxResults: 10 });
          const others = (owners.data.members ?? [])
            .filter((m) => typeof m.email === 'string' && m.email.toLowerCase() !== primaryEmail);
          ownership = others.length > 0 ? 'shared' : 'sole';
        } else {
          ownership = 'none';
        }
      }
      facts.groups.push({ id, name: clip(g.name) ?? id, email, ownership, dynamic: false, roleAssignable: false });
    }
  } catch (err) {
    facts.groups = [];
    googleFailureFlag(c, 'google_groups_read_failed', label, err, 'groups');
  }

  // Licences: assignments across the known products, bounded pages.
  try {
    const lic = getLicensingClient(ctx.keyJson, ctx.conn.adminEmail);
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
          const code = normalizeGoogleError(err).code;
          if (code === 'google_not_found' || (err as { code?: unknown })?.code === 400) break;
          throw err;
        }
        for (const a of res.data.items ?? []) {
          if (typeof a.userId !== 'string' || a.userId.toLowerCase() !== primaryEmail) continue;
          const skuId = clip(a.skuId);
          if (!skuId) continue;
          if (facts.licenses.length >= DISCOVERY_LIMITS.licenses) { c.truncate('google.licenses'); break outer; }
          facts.licenses.push({ productId: clip(a.productId) ?? productId, skuId, name: clip(a.skuName) });
        }
        pageToken = res.data.nextPageToken ?? undefined;
        if (!pageToken) break;
        if (page === GOOGLE_LICENSE_MAX_PAGES - 1) c.truncate('google.licenses');
      }
    }
  } catch (err) {
    facts.licenses = [];
    googleFailureFlag(c, 'google_licenses_read_failed', label, err, 'licences');
  }

  // Mobile devices: the server query is a prefilter; the EXACT local match on
  // the primary address is the gate (`resolveWipeTarget`'s rule). Without it a
  // plan could name a device that belongs to someone else.
  try {
    const res = await dir.mobiledevices.list({ customerId: 'my_customer', query: `email:${primaryEmail}` });
    for (const d of res.data.mobiledevices ?? []) {
      const id = clip(d.resourceId);
      if (!id) continue;
      const accounts = (d.email ?? []).map((e) => (e ?? '').toLowerCase());
      if (!accounts.includes(primaryEmail)) continue;
      if (facts.mobileDevices.length >= DISCOVERY_LIMITS.mobileDevices) { c.truncate('google.mobileDevices'); break; }
      facts.mobileDevices.push({ id, model: clip(d.model), status: clip(d.status) });
    }
  } catch (err) {
    facts.mobileDevices = [];
    googleFailureFlag(c, 'google_mobile_read_failed', label, err, 'mobile device');
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Breeze (system scope, explicit org predicate on every read)
// ---------------------------------------------------------------------------

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

async function suggestBreezeDevices(orgId: string, labels: readonly string[]): Promise<DiscoveredSuggestedDevice[]> {
  const localParts = [...new Set(labels
    .map((l) => l.split('@')[0]?.trim().toLowerCase() ?? '')
    .filter((l) => l.length >= 2))];
  const out: DiscoveredSuggestedDevice[] = [];
  for (const local of localParts) {
    if (out.length >= DISCOVERY_LIMITS.suggestedDevices) break;
    const rows = await db
      .select({ id: devices.id, hostname: devices.hostname, lastUser: devices.lastUser })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), ilike(devices.lastUser, `%${escapeLike(local)}%`)))
      .limit(DISCOVERY_LIMITS.suggestedDevices);
    for (const r of rows) {
      if (out.length >= DISCOVERY_LIMITS.suggestedDevices) break;
      if (out.some((d) => d.deviceId === r.id)) continue;
      out.push({ deviceId: r.id, hostname: clip(r.hostname), lastUser: clip(r.lastUser), matchBasis: 'last_user_ilike' });
    }
  }
  return out;
}

async function readInheritorEmail(orgId: string, contactId: string): Promise<string | null> {
  const [row] = await db
    .select({ email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.id, contactId)))
    .limit(1);
  return row?.email ? canonicalizeUserEmail(row.email) : null;
}

/**
 * Discover the frozen accounts' state across both providers.
 *
 * Provider errors never throw (see the header). A Breeze db error DOES throw:
 * that is transient I/O, and the `discover` advancer rethrows it so the wake
 * retries — it is not a fact about the person.
 */
export async function discoverIdentityFacts(input: DiscoverIdentityFactsInput): Promise<IdentityDiscoveryFacts> {
  const c = new Collector();
  const google = input.accounts.find((a) => a.provider === 'google') ?? null;
  const m365 = input.accounts.find((a) => a.provider === 'm365') ?? null;

  const [googleFacts, m365Facts] = await Promise.all([
    google ? readGoogle(input.orgId, google.externalId, google.principalLabel, c) : Promise.resolve(emptyGoogle()),
    m365 ? readM365(input.orgId, m365.externalId, m365.principalLabel, c) : Promise.resolve(emptyM365()),
  ]);

  const { suggestedDevices, inheritor } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => ({
    suggestedDevices: await suggestBreezeDevices(input.orgId, input.accounts.map((a) => a.principalLabel)),
    inheritor: input.inheritorContactId
      ? { contactId: input.inheritorContactId, email: await readInheritorEmail(input.orgId, input.inheritorContactId) }
      : null,
  })));

  const facts: IdentityDiscoveryFacts = {
    version: 1,
    observedAt: (input.now ?? new Date()).toISOString(),
    google: googleFacts,
    m365: m365Facts,
    breeze: { suggestedDevices },
    inheritor,
    flags: c.flags,
    truncated: c.truncated,
  };
  enforceByteBudget(facts);
  return facts;
}

/**
 * The facts are stored in the `discover` step row's checkpoint, which has a
 * 64 KiB `pg_column_size` CHECK (`ai_operator_task_steps_checkpoint_size_chk`)
 * — a 23514 there would abort the leased transaction that seals the snapshot.
 * The per-list caps keep any realistic tenant far below this; the budget is
 * the hard backstop for pathological provider data (very long names), and
 * every entry it drops is recorded as truncated so the recipe generates a
 * "review the rest by hand" item for it.
 */
export const DISCOVERY_FACTS_MAX_BYTES = 48 * 1024;

function enforceByteBudget(facts: IdentityDiscoveryFacts): void {
  const lists: Array<[string, unknown[]]> = [
    ['google.groups', facts.google.groups],
    ['m365.groups', facts.m365.groups],
    ['google.mobileDevices', facts.google.mobileDevices],
    ['m365.intuneDevices', facts.m365.intuneDevices],
    ['breeze.suggestedDevices', facts.breeze.suggestedDevices],
    ['google.licenses', facts.google.licenses],
    ['m365.licenses', facts.m365.licenses],
  ];
  while (Buffer.byteLength(JSON.stringify(facts)) > DISCOVERY_FACTS_MAX_BYTES) {
    const [name, longest] = lists.reduce((a, b) => (b[1].length > a[1].length ? b : a));
    if (longest.length === 0) break; // flags alone cannot exceed the budget: they are bounded per provider
    longest.pop();
    if (!facts.truncated.includes(name)) facts.truncated.push(name);
  }
}
