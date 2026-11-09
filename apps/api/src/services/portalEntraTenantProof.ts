import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  assertInTransaction,
  db,
  getCurrentDbAccessContext,
  hasDbAccessContext,
  withDbTransaction,
  withSystemDbAccessContext,
} from '../db';
import {
  auditLogs,
  clientAiTenantMappings,
  m365Connections,
  organizations,
  partners,
  portalUsers,
} from '../db/schema';
import type { PortalEntraProofEvidence, PortalEntraProofVia } from '../db/schema/clientAi';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { ANONYMOUS_ACTOR_ID } from './auditEvents';
import { markRequestAuditWritten } from './auditRequestTracking';
import { getEmailService } from './email';
import { listActivePartnerAdmins } from './partnerAdminRecipients';
import { captureException } from './sentry';
import { PROTECTED_ORG_ERROR } from './unassignedPool/orgType';
import { isHoldingOrg } from './unassignedPool/protectedOrg';

/**
 * Entra tenant proof (portal registration W4 #11381; spec §5.4, plan D1/D7).
 *
 * The proof lives on the org's AI for Office tenant mapping
 * (`client_ai_tenant_mappings`: 1:1 per org, globally unique per tenant) in the
 * four `proven_*` columns. Nothing typed by an MSP is ever proof (inv. 2): a
 * mapping becomes proven only through
 *   - a proof run: a tenant admin signed in to the portal Entra app and passed
 *     a live Graph role check (routes/portal/oidc.ts, Task 8), or
 *   - the org's identity-first M365 connection, whose tenant only the consent
 *     flow's finalization binds (`applyConsentFinalizationResult`).
 * Only a proven row ever resolves a sign-in to an org
 * ({@link findOrgByProvenEntraTenant}). A trigger clears the proof whenever the
 * mapped tenant changes (inv. 3, migration 2027-01-22-233400).
 *
 * Writes run in ONE system-scope transaction: the evidence is verified, not MSP
 * input, and a displacement crosses partners. Request callers reach the writers
 * through `runOutsideDbContext`; they refuse to run inside a held context.
 */

export interface PortalEntraTenantStatus {
  /** The org's mapped tenant, if any. */
  tenantId: string | null;
  state: 'none' | 'unproven' | 'proven';
  provenAt: string | null;
  provenVia: PortalEntraProofVia | null;
  /** Tenant bound on the org's identity-first m365_connections row (F13), if any. */
  connectionTenantId: string | null;
}

export type RecordEntraProofInput =
  | { orgId: string; tenantId: string; via: 'proof_run'; evidence: { adminOid: string; runId: string }; provenByUserId: string | null }
  | { orgId: string; tenantId: string; via: 'm365_connection'; evidence: { connectionId: string; profile: string }; provenByUserId: string };

export interface RecordEntraProofOutcome {
  displaced: { orgId: string; partnerId: string; wasProven: boolean; epochsBumped: number } | null;
}

export type PortalEntraProofErrorCode =
  | 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE'
  | 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT'
  | 'PORTAL_ENTRA_NO_VERIFIED_CONNECTION'
  | 'PORTAL_ENTRA_PROTECTED_ORG';

/**
 * A refused proof. `PROTECTED_ORG` → 409 with the existing PROTECTED_ORG_ERROR
 * body (routes/clientAi/admin.ts), `NO_VERIFIED_CONNECTION` → 422, the rest → 409.
 * Messages never name the other org.
 */
export class PortalEntraProofError extends Error {
  constructor(
    readonly code: PortalEntraProofErrorCode,
    readonly httpStatus: 409 | 422,
    message: string,
  ) {
    super(message);
    this.name = 'PortalEntraProofError';
  }
}

const TENANT_PROVEN_ELSEWHERE_MESSAGE = 'This Microsoft tenant is already proven for another organization.';
const ORG_HAS_OTHER_TENANT_MESSAGE =
  'This organization is linked to a different Microsoft tenant. Remove that link before proving a new one.';
const NO_VERIFIED_CONNECTION_MESSAGE =
  'This organization has no Microsoft 365 connection whose tenant was verified by an administrator sign-in.';

const tenantProvenElsewhere = () =>
  new PortalEntraProofError('PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE', 409, TENANT_PROVEN_ELSEWHERE_MESSAGE);
const protectedOrg = () =>
  new PortalEntraProofError('PORTAL_ENTRA_PROTECTED_ORG', 409, PROTECTED_ORG_ERROR.error);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The connection profiles whose tenant only the identity-first consent flow binds (spec F13). */
const IDENTITY_FIRST_PROFILES = ['customer-graph-read', 'customer-graph-actions'] as const;

const AUDIT_PROVEN = 'organization.portal_identity_proof.proven';
const AUDIT_DISPLACED = 'organization.portal_identity_proof.displaced';

/** Tenant GUIDs are stored lowercased (the AI for Office PUT and Entra `tid` both are). */
function normalizeTenantId(tenantId: string): string | null {
  const tid = tenantId.trim().toLowerCase();
  return UUID_RE.test(tid) ? tid : null;
}

function assertNoHeldContext(operation: string): void {
  if (hasDbAccessContext()) {
    throw new Error(
      `${operation} opens its own system-scope transaction and must not run inside a held DB context — `
      + 'call it through runOutsideDbContext',
    );
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Under the held context when there is one (it never escalates), else a fresh system context. */
async function inHeldOrSystemContext<T>(label: string, read: () => Promise<T>): Promise<T> {
  return hasDbAccessContext() ? read() : withSystemDbAccessContext(read, label);
}

async function findVerifiedConnection(orgId: string): Promise<{ id: string; tenantId: string; profile: string } | null> {
  const [row] = await db
    .select({ id: m365Connections.id, tenantId: m365Connections.tenantId, profile: m365Connections.profile })
    .from(m365Connections)
    .where(and(
      eq(m365Connections.orgId, orgId),
      isNull(m365Connections.userId),
      isNotNull(m365Connections.tenantId),
      inArray(m365Connections.profile, [...IDENTITY_FIRST_PROFILES]),
    ))
    // Deterministic when both Graph profiles are bound: read before actions.
    .orderBy(desc(m365Connections.profile))
    .limit(1);
  return row?.tenantId ? { id: row.id, tenantId: row.tenantId, profile: row.profile } : null;
}

/**
 * The org's mapped tenant, its proof state and the tenant its identity-first
 * M365 connection is bound to. Reads under the held context, else system.
 */
export async function getPortalEntraTenantStatus(orgId: string): Promise<PortalEntraTenantStatus> {
  const none: PortalEntraTenantStatus = { tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null };
  if (!UUID_RE.test(orgId)) return none;
  return inHeldOrSystemContext('portalEntraTenantProof.status', async (): Promise<PortalEntraTenantStatus> => {
    const [mapping] = await db
      .select({
        tenantId: clientAiTenantMappings.entraTenantId,
        provenAt: clientAiTenantMappings.provenAt,
        provenVia: clientAiTenantMappings.provenVia,
      })
      .from(clientAiTenantMappings)
      .where(eq(clientAiTenantMappings.orgId, orgId))
      .limit(1);
    const connection = await findVerifiedConnection(orgId);
    return {
      tenantId: mapping?.tenantId ?? null,
      state: !mapping ? 'none' : mapping.provenAt ? 'proven' : 'unproven',
      provenAt: mapping?.provenAt ? mapping.provenAt.toISOString() : null,
      provenVia: mapping?.provenAt ? mapping.provenVia ?? null : null,
      connectionTenantId: connection?.tenantId ?? null,
    };
  });
}

/**
 * The org's PROVEN tenant, or null (resolver and session gate). With no DB
 * context held it opens a system context; otherwise it reads under the held
 * one and never leaves it (pattern: resolvePortalAccessPolicy).
 */
export async function findProvenEntraTenantForOrg(orgId: string): Promise<{ tenantId: string; provenAt: Date } | null> {
  // A malformed id would raise 22P02 and poison a held transaction; it names no org.
  if (!UUID_RE.test(orgId)) return null;
  const [row] = await inHeldOrSystemContext('portalEntraTenantProof.findForOrg', () =>
    db
      .select({ tenantId: clientAiTenantMappings.entraTenantId, provenAt: clientAiTenantMappings.provenAt })
      .from(clientAiTenantMappings)
      .where(and(eq(clientAiTenantMappings.orgId, orgId), isNotNull(clientAiTenantMappings.provenAt)))
      .limit(1));
  return row?.provenAt ? { tenantId: row.tenantId, provenAt: row.provenAt } : null;
}

/**
 * Sign-in org resolution (spec §5.7): `tid` → org ONLY through a proven row
 * (inv. 2). Cross-tenant by nature, so system scope; never call it inside a
 * request transaction (it refuses a held non-system context).
 */
export async function findOrgByProvenEntraTenant(tid: string): Promise<{ orgId: string; partnerId: string } | null> {
  const held = getCurrentDbAccessContext();
  if (hasDbAccessContext() && held?.scope !== 'system') {
    throw new Error(
      'findOrgByProvenEntraTenant must not run inside a request transaction — call it with no DB context '
      + '(or through runOutsideDbContext)',
    );
  }
  const tenantId = normalizeTenantId(tid);
  if (!tenantId) return null;
  const [row] = await inHeldOrSystemContext('portalEntraTenantProof.findOrgByTenant', () =>
    db
      .select({ orgId: clientAiTenantMappings.orgId, partnerId: organizations.partnerId })
      .from(clientAiTenantMappings)
      .innerJoin(organizations, eq(organizations.id, clientAiTenantMappings.orgId))
      .where(and(eq(clientAiTenantMappings.entraTenantId, tenantId), isNotNull(clientAiTenantMappings.provenAt)))
      .limit(1));
  return row ? { orgId: row.orgId, partnerId: row.partnerId } : null;
}

// ---------------------------------------------------------------------------
// Per-org mapping lock (D8)
// ---------------------------------------------------------------------------

/**
 * Takes `pg_advisory_xact_lock(hashtext('portal-entra-org:' || org_id))` for
 * each org, held until the transaction ends (plan D8 / OD7).
 *
 * The org merge refuses `entra_tenant_conflict` when the loser's mapping is
 * proven and the survivor holds any mapping. Its `FOR UPDATE` on the mapping
 * rows cannot lock a row that does not exist yet. Without this lock, a writer
 * could create the survivor's mapping after the Phase-B recheck saw none. The
 * `keep-survivor` walk would then drop the loser's proven mapping. So every
 * writer that can CREATE an org's mapping takes this lock first, and the merge
 * holds it for both orgs for all of Phase B. The writers are
 * {@link recordEntraTenantProof} and the AI for Office
 * `PUT /client-ai/admin/orgs/:orgId/tenant-mapping`.
 *
 * Lock order: a proof takes its per-tenant lock, then this lock. The PUT and the
 * merge take only this lock, never a tenant lock. Several orgs (the merge) are
 * locked one statement at a time, ascending by id, so two callers cannot
 * invert the order. The key is the canonical uuid text, so a caller that spells
 * the id differently (upper case) still contends on the same key. Must run
 * inside a transaction: on the bare pool the lock would end with its statement.
 */
export async function lockPortalEntraOrgMappings(orgIds: readonly string[]): Promise<void> {
  assertInTransaction('lockPortalEntraOrgMappings');
  const ordered = [...new Set(orgIds.map((id) => id.toLowerCase()))].sort();
  for (const orgId of ordered) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('portal-entra-org:' || ${orgId}::uuid::text))`);
  }
}

// ---------------------------------------------------------------------------
// Record (D7)
// ---------------------------------------------------------------------------

interface DisplacedMapping {
  orgId: string;
  partnerId: string;
  orgName: string;
  partnerName: string;
  wasProven: boolean;
  epochsBumped: number;
}

/**
 * Records a verified proof that `input.orgId` owns `input.tenantId` (D7):
 *  1. a holding org is refused (PROTECTED_ORG) before any transaction opens;
 *  2. `pg_advisory_xact_lock(hashtext('portal-entra-tenant:' || tid))` FIRST —
 *     FOR UPDATE locks nothing while no row exists, so this is what serializes
 *     two orgs proving one fresh tenant — then this org's per-org lock
 *     ({@link lockPortalEntraOrgMappings}, which an org merge holds for both
 *     its orgs), then the rows of this org and of the tenant FOR UPDATE;
 *  3. this org mapping a different tenant → ORG_HAS_OTHER_TENANT;
 *  4. another org's mapping of the tenant: an `m365_connection` proof displaces
 *     only an UNPROVEN one (OD4), else TENANT_PROVEN_ELSEWHERE; a `proof_run`
 *     displaces any. Displacing deletes that row, bumps `auth_epoch` on that
 *     org's accounts with an Entra identity in the tenant (their browser and
 *     add-in sessions die durably) and audits it on that org;
 *  5. upserts this org's row with the proof and audits `proven`;
 *  6. after commit, mails the displaced partner's active admins. A send failure
 *     is logged and never undoes the proof.
 * A stray 23505 on the tenant index (a concurrent AI for Office PUT) maps to
 * TENANT_PROVEN_ELSEWHERE, never a 500.
 */
export async function recordEntraTenantProof(input: RecordEntraProofInput, now: Date = new Date()): Promise<RecordEntraProofOutcome> {
  assertNoHeldContext('recordEntraTenantProof');
  if (!UUID_RE.test(input.orgId)) throw new Error('recordEntraTenantProof: invalid org id');
  const tenantId = normalizeTenantId(input.tenantId);
  if (!tenantId) throw new Error('recordEntraTenantProof: invalid Entra tenant id');

  const displaced = await withSystemDbAccessContext(async () => {
    if (await isHoldingOrg(input.orgId)) throw protectedOrg();
    try {
      return await withDbTransaction(() => recordInTransaction(input, tenantId, now));
    } catch (err) {
      if (isPgUniqueViolation(err, 'client_ai_tenant_mappings_tenant_uniq')) throw tenantProvenElsewhere();
      throw err;
    }
  }, 'portalEntraTenantProof.record');

  if (displaced) await notifyDisplacedPartner(displaced, tenantId);
  return {
    displaced: displaced
      ? { orgId: displaced.orgId, partnerId: displaced.partnerId, wasProven: displaced.wasProven, epochsBumped: displaced.epochsBumped }
      : null,
  };
}

async function recordInTransaction(
  input: RecordEntraProofInput,
  tenantId: string,
  now: Date,
): Promise<DisplacedMapping | null> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`portal-entra-tenant:${tenantId}`}))`);
  // The per-org lock an org merge holds for both its orgs through Phase B: this
  // proof may CREATE this org's mapping, which the merge's FOR UPDATE cannot
  // lock in advance (D8). Lock order: tenant lock, org lock, then mapping rows
  // in id order, then the displaced org's portal_users. No cycle:
  //  - The merge and the AI for Office PUT take org locks only, never a tenant
  //    lock. The merge takes them first in Phase B, before any row lock. So a
  //    proof waiting here holds only its tenant lock, which neither of them
  //    ever waits for.
  //  - Displacement does NOT take the displaced org's org lock. Two proofs that
  //    displace each other's org would take X then Y and Y then X, a cycle. It
  //    needs none: it only DELETES that org's existing row, which FOR UPDATE
  //    locks (the merge's recheck locks the same row). Deleting a mapping can
  //    only turn a merge refusal into an adoption. While a proof holds that
  //    row, what it locks next is free of every lock the merge takes before
  //    the row: the displaced org's portal_users rows (the merge moves them
  //    later, in its walk) and the FK KEY SHARE on organizations (the merge's
  //    FOR NO KEY UPDATE on its org rows does not conflict with it).
  await lockPortalEntraOrgMappings([input.orgId]);

  const rows = await db
    .select({
      id: clientAiTenantMappings.id,
      orgId: clientAiTenantMappings.orgId,
      entraTenantId: clientAiTenantMappings.entraTenantId,
      provenAt: clientAiTenantMappings.provenAt,
      orgName: organizations.name,
      partnerId: organizations.partnerId,
      partnerName: partners.name,
    })
    .from(clientAiTenantMappings)
    .innerJoin(organizations, eq(organizations.id, clientAiTenantMappings.orgId))
    .innerJoin(partners, eq(partners.id, organizations.partnerId))
    .where(or(eq(clientAiTenantMappings.orgId, input.orgId), eq(clientAiTenantMappings.entraTenantId, tenantId)))
    .orderBy(clientAiTenantMappings.id)
    .for('update', { of: clientAiTenantMappings });

  const own = rows.find((r) => r.orgId === input.orgId);
  if (own && own.entraTenantId !== tenantId) {
    throw new PortalEntraProofError('PORTAL_ENTRA_ORG_HAS_OTHER_TENANT', 409, ORG_HAS_OTHER_TENANT_MESSAGE);
  }

  const actor = input.provenByUserId
    ? { actorType: 'user' as const, actorId: input.provenByUserId }
    : { actorType: 'system' as const, actorId: ANONYMOUS_ACTOR_ID };

  let displaced: DisplacedMapping | null = null;
  const other = rows.find((r) => r.orgId !== input.orgId && r.entraTenantId === tenantId);
  if (other) {
    const wasProven = other.provenAt !== null;
    // OD4: an old connection held by a former MSP must not take a proven tenant back.
    if (wasProven && input.via === 'm365_connection') throw tenantProvenElsewhere();

    await db.delete(clientAiTenantMappings).where(eq(clientAiTenantMappings.id, other.id));
    // "portal_users" is spelled as text in the EXISTS: drizzle renders a bare
    // column reference there (#9692), which would bind to the identity's own id.
    const bumped = await db
      .update(portalUsers)
      .set({ authEpoch: sql`${portalUsers.authEpoch} + 1`, updatedAt: now })
      .where(and(
        eq(portalUsers.orgId, other.orgId),
        sql`exists (select 1 from "portal_user_identities" "pui"
                     where "pui"."portal_user_id" = "portal_users"."id"
                       and "pui"."org_id" = "portal_users"."org_id"
                       and "pui"."provider" = 'entra'
                       and "pui"."entra_tenant_id" = ${tenantId})`,
      ))
      .returning({ id: portalUsers.id });
    await db.insert(auditLogs).values({
      orgId: other.orgId,
      ...actor,
      action: AUDIT_DISPLACED,
      resourceType: 'client_ai_tenant_mapping',
      resourceId: other.id,
      resourceName: tenantId,
      details: { tenantId, displacedByOrgId: input.orgId, wasProven },
      result: 'success',
    });
    displaced = {
      orgId: other.orgId,
      partnerId: other.partnerId,
      orgName: other.orgName,
      partnerName: other.partnerName,
      wasProven,
      epochsBumped: bumped.length,
    };
  }

  const evidence = { via: input.via, ...input.evidence } as PortalEntraProofEvidence;
  const proof = {
    entraTenantId: tenantId,
    provenAt: now,
    provenVia: input.via,
    provenByUserId: input.provenByUserId,
    provenEvidence: evidence,
    updatedAt: now,
  };
  // `setWhere`: the conflict update applies only to this org's row for THIS
  // tenant. Two proofs of different tenants for one unmapped org take different
  // advisory locks and can both read "no own row"; the later upsert then finds
  // the earlier one's row, updates nothing and is refused below instead of
  // silently repointing it.
  const [mapping] = await db
    .insert(clientAiTenantMappings)
    .values({ orgId: input.orgId, ...proof, createdBy: input.provenByUserId, createdAt: now })
    .onConflictDoUpdate({
      target: clientAiTenantMappings.orgId,
      set: proof,
      setWhere: eq(clientAiTenantMappings.entraTenantId, tenantId),
    })
    .returning({ id: clientAiTenantMappings.id });
  if (!mapping) {
    throw new PortalEntraProofError('PORTAL_ENTRA_ORG_HAS_OTHER_TENANT', 409, ORG_HAS_OTHER_TENANT_MESSAGE);
  }
  // Only past the last throw: a rolled-back displacement row must not suppress the fallback audit.
  if (displaced) markRequestAuditWritten();

  await db.insert(auditLogs).values({
    orgId: input.orgId,
    ...actor,
    action: AUDIT_PROVEN,
    resourceType: 'client_ai_tenant_mapping',
    resourceId: mapping.id,
    resourceName: tenantId,
    details: {
      tenantId,
      via: input.via,
      evidence: input.evidence,
      ...(displaced ? { displacedOrgId: displaced.orgId } : {}),
    },
    result: 'success',
  });
  markRequestAuditWritten();

  return displaced;
}

/** After commit: the displaced partner's active admins. Never throws (D7). */
async function notifyDisplacedPartner(displaced: DisplacedMapping, tenantId: string): Promise<void> {
  try {
    const email = getEmailService();
    if (!email) return;
    const admins = await listActivePartnerAdmins(displaced.partnerId);
    if (admins.length === 0) return;
    await email.sendPortalEntraTenantDisplaced({
      to: admins.map((a) => a.email),
      partnerName: displaced.partnerName,
      orgName: displaced.orgName,
      tenantId,
    });
  } catch (err) {
    console.error(
      '[portalEntraTenantProof] displacement email failed:',
      err instanceof Error ? err.message : err,
    );
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Proof from the org's identity-first M365 connection: the row with
 * `org_id = org`, `user_id IS NULL`, a bound `tenant_id` and a Graph profile.
 * Only the consent flow's finalization binds that tenant (F13). None → 422
 * NO_VERIFIED_CONNECTION. Request callers go through runOutsideDbContext.
 */
export async function proveEntraTenantFromM365Connection(
  orgId: string,
  actorUserId: string,
): Promise<RecordEntraProofOutcome & { tenantId: string }> {
  assertNoHeldContext('proveEntraTenantFromM365Connection');
  if (!UUID_RE.test(orgId)) throw new Error('proveEntraTenantFromM365Connection: invalid org id');
  const connection = await withSystemDbAccessContext(async () => {
    if (await isHoldingOrg(orgId)) throw protectedOrg();
    return findVerifiedConnection(orgId);
  }, 'portalEntraTenantProof.connection');
  if (!connection) {
    throw new PortalEntraProofError('PORTAL_ENTRA_NO_VERIFIED_CONNECTION', 422, NO_VERIFIED_CONNECTION_MESSAGE);
  }
  const outcome = await recordEntraTenantProof({
    orgId,
    tenantId: connection.tenantId,
    via: 'm365_connection',
    evidence: { connectionId: connection.id, profile: connection.profile },
    provenByUserId: actorUserId,
  });
  return { ...outcome, tenantId: connection.tenantId.toLowerCase() };
}

/**
 * Removes the org's tenant mapping, proof and all (OD3: this also removes the
 * AI for Office mapping, which shares the row). The route audits `.removed`.
 * Reads/writes under the held context when there is one, else system.
 */
export async function removePortalEntraTenant(orgId: string): Promise<{ removed: boolean; tenantId: string | null }> {
  if (!UUID_RE.test(orgId)) return { removed: false, tenantId: null };
  const [row] = await inHeldOrSystemContext('portalEntraTenantProof.remove', () =>
    db
      .delete(clientAiTenantMappings)
      .where(eq(clientAiTenantMappings.orgId, orgId))
      .returning({ tenantId: clientAiTenantMappings.entraTenantId }));
  return row ? { removed: true, tenantId: row.tenantId } : { removed: false, tenantId: null };
}
