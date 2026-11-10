import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  hasDbAccessContext,
  withDbTransaction,
  withSystemDbAccessContext,
} from '../../db';
import {
  auditLogs,
  clientAiTenantMappings,
  customerEmailDomains,
  googleWorkspaceConnections,
  organizations,
  partners,
} from '../../db/schema';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { markRequestAuditWritten } from '../auditRequestTracking';
import { getEmailService } from '../email';
import { generateOwnershipToken } from '../emailDomains/dnsOwnershipProof';
import { listActivePartnerAdmins } from '../partnerAdminRecipients';
import { captureException } from '../sentry';
import { dnsTxtChecker, portalDomainTxtRecord } from './checkers/dnsTxt';
import { googleConnectionBinding } from './checkers/googleBinding';
import {
  STRUCTURAL_FAIL_REASONS,
  type CustomerDomainView,
  type DomainCheckResult,
  type DomainCheckTarget,
  type DomainCheckUnavailableReason,
  type DomainVerificationCheckers,
  type DomainVerificationClearedReason,
  type DomainVerificationErrorCode,
  type DomainVerificationEvidence,
  type DomainVerificationMethod,
  type VerifyCustomerDomainOutcome,
} from './types';

/**
 * Customer domain verification (portal registration W5 #11382; spec §5.4,
 * plan D5/D6/D10/D11).
 *
 * State lives on `customer_email_domains` (plan D1). Only a live checker `pass`
 * writes `verified_at` (inv. 2). A domain is verified for at most one org
 * platform-wide (`customer_email_domains_verified_domain_uq`, D4); a challenger
 * displaces an incumbent only when the incumbent's own evidence fails live (D5).
 *
 * Network I/O (DNS, Graph, Google) never runs inside a DB transaction: checks
 * run first, then one short system-scope write transaction re-reads the rows
 * under a per-domain advisory lock and refuses if anything moved.
 */

export const PORTAL_DOMAIN_STALE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Definitive non-structural failures in a row that clear a verified row (D10). */
const CLEAR_AFTER_CONSECUTIVE_FAILURES = 2;

const RESOURCE_TYPE = 'customer_email_domain';
const AUDIT_VERIFIED = 'organization.portal_identity_proof.domain_verified';
const AUDIT_DISPLACED = 'organization.portal_identity_proof.domain_displaced';
const AUDIT_CLEARED = 'organization.portal_identity_proof.domain_cleared';
const AUDIT_REMOVED = 'organization.portal_identity_proof.domain_removed';
const AUDIT_CHECK_FAILED = 'organization.portal_identity_proof.domain_check_failed';

/** Every resource type / action this module audits (web labels, W05b). */
export const PORTAL_DOMAIN_AUDIT_ACTIONS = [
  AUDIT_VERIFIED,
  AUDIT_DISPLACED,
  AUDIT_CLEARED,
  AUDIT_REMOVED,
  AUDIT_CHECK_FAILED,
] as const;
export const PORTAL_DOMAIN_AUDIT_RESOURCE_TYPE = RESOURCE_TYPE;

const VERIFIED_ELSEWHERE_MESSAGE =
  'This domain is verified for another organization. Its owner must remove the other verification '
  + '(DNS record or directory connection) first.';

export class DomainVerificationError extends Error {
  constructor(
    readonly code: DomainVerificationErrorCode,
    readonly httpStatus: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'DomainVerificationError';
  }
}

const notFound = () => new DomainVerificationError('CUSTOMER_DOMAIN_NOT_FOUND', 404, 'Customer domain not found');
const verifiedElsewhere = () => new DomainVerificationError('DOMAIN_VERIFIED_ELSEWHERE', 409, VERIFIED_ELSEWHERE_MESSAGE);
const conflictRetry = () =>
  new DomainVerificationError(
    'DOMAIN_VERIFICATION_CONFLICT_RETRY',
    409,
    'The domain changed while it was being checked. Run the check again.',
  );

/**
 * The live checkers. The Entra and Google ones load on first use: they pull in
 * the M365 control plane (and through it middleware/auth) and googleapis, which
 * the worker boot closure and the read API must not import
 * (workerEntrypointClosure.contract.test.ts).
 */
export async function defaultDomainVerificationCheckers(): Promise<DomainVerificationCheckers> {
  const [{ entraTenantChecker }, { googleDirectoryChecker }] = await Promise.all([
    import('./checkers/entraTenant'),
    import('./checkers/googleDirectory'),
  ]);
  return { dns_txt: dnsTxtChecker, entra_tenant: entraTenantChecker, google_directory: googleDirectoryChecker };
}

// ---------------------------------------------------------------------------
// Row shape, view, evidence currency (D6)
// ---------------------------------------------------------------------------

/** Built on call, not at import: tests that partially mock the schema import this module. */
const rowColumns = () => ({
  id: customerEmailDomains.id,
  partnerId: customerEmailDomains.partnerId,
  orgId: customerEmailDomains.orgId,
  domain: customerEmailDomains.domain,
  isActive: customerEmailDomains.isActive,
  autoCreateContact: customerEmailDomains.autoCreateContact,
  verificationToken: customerEmailDomains.verificationToken,
  verifiedAt: customerEmailDomains.verifiedAt,
  verifiedMethod: customerEmailDomains.verifiedMethod,
  verifiedEvidence: customerEmailDomains.verifiedEvidence,
  lastCheckedAt: customerEmailDomains.lastCheckedAt,
  lastPassedAt: customerEmailDomains.lastPassedAt,
  lastCheckStatus: customerEmailDomains.lastCheckStatus,
  checkFailures: customerEmailDomains.checkFailures,
  clearedAt: customerEmailDomains.clearedAt,
  clearedReason: customerEmailDomains.clearedReason,
  createdAt: customerEmailDomains.createdAt,
  updatedAt: customerEmailDomains.updatedAt,
});

/** The internal row: never returned by an API as-is (it carries the token and evidence). */
export type CustomerDomainRow = {
  id: string;
  partnerId: string;
  orgId: string;
  domain: string;
  isActive: boolean;
  autoCreateContact: boolean;
  verificationToken: string | null;
  verifiedAt: Date | null;
  verifiedMethod: DomainVerificationMethod | null;
  verifiedEvidence: DomainVerificationEvidence | null;
  lastCheckedAt: Date | null;
  lastPassedAt: Date | null;
  lastCheckStatus: 'pass' | 'fail' | 'unavailable' | null;
  checkFailures: number;
  clearedAt: Date | null;
  clearedReason: DomainVerificationClearedReason | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The projection every CRUD surface selects / returns, so no surface can leak the token or evidence. */
export const customerDomainRowColumns = rowColumns;

/** Per-org evidence sources the method checks at use read (D6). */
export interface DomainEvidenceFacts {
  provenTenantId: string | null;
  /** The org's Google connection: id + googleConnectionBinding (admin + service account). */
  googleConnection: { id: string; binding: string } | null;
}

/**
 * Loads D6 facts for many orgs at once, under the CURRENT context (a request
 * context reads what RLS lets it see; it never escalates).
 */
async function loadEvidenceFactsInContext(orgIds: readonly string[]): Promise<Map<string, DomainEvidenceFacts>> {
  const unique = [...new Set(orgIds)];
  const facts = new Map<string, DomainEvidenceFacts>(
    unique.map((id) => [id, { provenTenantId: null, googleConnection: null }]),
  );
  if (unique.length === 0) return facts;
  const proven = await db
    .select({ orgId: clientAiTenantMappings.orgId, tenantId: clientAiTenantMappings.entraTenantId })
    .from(clientAiTenantMappings)
    .where(and(inArray(clientAiTenantMappings.orgId, unique), isNotNull(clientAiTenantMappings.provenAt)));
  for (const row of proven) facts.get(row.orgId)!.provenTenantId = row.tenantId.toLowerCase();
  const google = await db
    .select({
      orgId: googleWorkspaceConnections.orgId,
      id: googleWorkspaceConnections.id,
      adminEmail: googleWorkspaceConnections.adminEmail,
      serviceAccountEmail: googleWorkspaceConnections.serviceAccountEmail,
    })
    .from(googleWorkspaceConnections)
    .where(inArray(googleWorkspaceConnections.orgId, unique));
  for (const row of google) facts.get(row.orgId)!.googleConnection = { id: row.id, binding: googleConnectionBinding(row) };
  return facts;
}

/**
 * The method's structural evidence check (D6). `dns_txt` has none (DNS cannot
 * be resolved per request; the worker owns it).
 */
function evidenceStructurallyCurrent(
  evidence: DomainVerificationEvidence | null,
  facts: DomainEvidenceFacts | undefined,
): boolean {
  if (!evidence) return false;
  switch (evidence.via) {
    case 'dns_txt':
      return true;
    case 'entra_tenant':
      return !!facts?.provenTenantId && facts.provenTenantId === evidence.tenantId.toLowerCase();
    case 'google_directory':
      // Same row AND same Workspace: the connection upsert replaces the admin
      // and service account in place, keeping the id.
      return !!facts?.googleConnection
        && facts.googleConnection.id === evidence.connectionId
        && facts.googleConnection.binding === evidence.binding;
    default:
      return false;
  }
}

/**
 * Verified, active (OD5), the method's evidence is still current (D6) and it
 * passed a live check within the last PORTAL_DOMAIN_STALE_DAYS days, so a
 * stopped worker or an un-checkable source can never keep a domain trusted.
 */
export function isVerificationCurrent(
  row: CustomerDomainRow,
  facts: DomainEvidenceFacts | undefined,
  now: Date = new Date(),
): boolean {
  if (row.verifiedAt === null || !row.isActive) return false;
  const lastPassed = row.lastPassedAt ?? row.verifiedAt;
  if (now.getTime() - lastPassed.getTime() >= PORTAL_DOMAIN_STALE_DAYS * DAY_MS) return false;
  return evidenceStructurallyCurrent(row.verifiedEvidence, facts);
}

/**
 * The same verification as when it was checked: a write fences on this after
 * re-reading the row FOR UPDATE, so a check result is never applied to a row
 * that was re-verified, refreshed with new evidence, repointed or renamed
 * while the (unlocked) network check ran.
 */
function sameVerification(a: CustomerDomainRow, b: CustomerDomainRow): boolean {
  return a.id === b.id
    && a.orgId === b.orgId
    && a.partnerId === b.partnerId
    && normalizeDomain(a.domain) === normalizeDomain(b.domain)
    && a.verifiedMethod === b.verifiedMethod
    && (a.verifiedAt?.getTime() ?? null) === (b.verifiedAt?.getTime() ?? null)
    && stableJson(a.verifiedEvidence) === stableJson(b.verifiedEvidence);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

export function toCustomerDomainView(row: CustomerDomainRow, facts: DomainEvidenceFacts | undefined): CustomerDomainView {
  const state = row.verifiedAt ? 'verified' : row.verificationToken ? 'pending_dns' : 'declared';
  return {
    id: row.id,
    orgId: row.orgId,
    domain: row.domain,
    isActive: row.isActive,
    autoCreateContact: row.autoCreateContact,
    state,
    method: row.verifiedAt ? row.verifiedMethod : null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastPassedAt: row.lastPassedAt?.toISOString() ?? null,
    lastCheckStatus: row.lastCheckStatus,
    clearedAt: row.clearedAt?.toISOString() ?? null,
    clearedReason: row.clearedReason,
    dnsRecord: row.verificationToken ? portalDomainTxtRecord(row.domain.toLowerCase(), row.verificationToken) : null,
    usableForSignIn: isVerificationCurrent(row, facts),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Views for rows read under the caller's context; the D6 facts are read under it too. */
export async function buildCustomerDomainViews(rows: readonly CustomerDomainRow[]): Promise<CustomerDomainView[]> {
  const facts = await loadEvidenceFactsInContext(rows.filter((r) => r.verifiedAt).map((r) => r.orgId));
  return rows.map((row) => toCustomerDomainView(row, facts.get(row.orgId)));
}

// ---------------------------------------------------------------------------
// Context guards
// ---------------------------------------------------------------------------

function assertNoHeldContext(operation: string): void {
  if (hasDbAccessContext()) {
    throw new Error(
      `${operation} opens its own system-scope transaction and must not run inside a held DB context — `
      + 'call it through runOutsideDbContext',
    );
  }
}

/** Cross-org reads: under a held SYSTEM context, else a fresh one; refuses a request context. */
async function inSystemContext<T>(operation: string, read: () => Promise<T>): Promise<T> {
  if (hasDbAccessContext()) {
    if (getCurrentDbAccessContext()?.scope !== 'system') {
      throw new Error(
        `${operation} must not run inside a request transaction — call it with no DB context `
        + '(runOutsideDbContext) or under a system context',
      );
    }
    return read();
  }
  return withSystemDbAccessContext(read, `portalDomainVerification.${operation}`);
}

/** A short system-scope read/write that closes before the caller's next network call. */
function systemRead<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return withSystemDbAccessContext(fn, `portalDomainVerification.${label}`);
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

function targetOf(row: CustomerDomainRow): DomainCheckTarget {
  return {
    rowId: row.id,
    orgId: row.orgId,
    partnerId: row.partnerId,
    domain: normalizeDomain(row.domain),
    verificationToken: row.verificationToken,
  };
}

const UNEXPECTED_REASON: Record<DomainVerificationMethod, DomainCheckUnavailableReason> = {
  dns_txt: 'dns_error',
  entra_tenant: 'graph_unavailable',
  google_directory: 'google_unavailable',
};

/** Checkers never throw by contract; a bug in one is transient, never a verdict. */
async function runChecker(
  checkers: DomainVerificationCheckers,
  method: DomainVerificationMethod,
  target: DomainCheckTarget,
): Promise<DomainCheckResult> {
  try {
    return await checkers[method].check(target);
  } catch (err) {
    console.error(`[portalDomainVerification] ${method} checker threw for domain row ${target.rowId}:`, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { status: 'unavailable', reason: UNEXPECTED_REASON[method] };
  }
}

/**
 * Re-check a VERIFIED row with its own method: first the D6 structural check
 * (the evidence source must still be the one that proved it), then the live
 * checker. Used by the worker (D10) and for an incumbent during transfer (D5).
 * Runs with NO context held: its reads are short system scopes and the checker
 * opens its own, so no transaction spans the network call.
 */
async function liveRecheckVerifiedRow(row: CustomerDomainRow, checkers: DomainVerificationCheckers): Promise<DomainCheckResult> {
  const method = row.verifiedMethod!;
  const facts = (await systemRead('evidenceFacts', () => loadEvidenceFactsInContext([row.orgId]))).get(row.orgId);
  if (!evidenceStructurallyCurrent(row.verifiedEvidence, facts)) {
    return { status: 'fail', reason: method === 'entra_tenant' ? 'tenant_not_proven' : 'connection_missing' };
  }
  return runChecker(checkers, method, targetOf(row));
}

/** Inside a write transaction: refuse (retry) if the evidence's source changed since the check. */
async function assertEvidenceStillCurrent(orgId: string, evidence: DomainVerificationEvidence): Promise<void> {
  const facts = (await loadEvidenceFactsInContext([orgId])).get(orgId);
  if (!evidenceStructurallyCurrent(evidence, facts)) throw conflictRetry();
}

async function lockDomain(domain: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`portal-domain:${normalizeDomain(domain)}`}))`);
}

async function selectRowById(id: string, forUpdate = false): Promise<CustomerDomainRow | null> {
  const q = db.select(rowColumns()).from(customerEmailDomains).where(eq(customerEmailDomains.id, id)).limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  return (row as CustomerDomainRow | undefined) ?? null;
}

async function selectVerifiedIncumbent(domain: string, excludeId: string, forUpdate = false): Promise<CustomerDomainRow | null> {
  const q = db
    .select(rowColumns())
    .from(customerEmailDomains)
    .where(and(
      sql`lower(${customerEmailDomains.domain}) = ${normalizeDomain(domain)}`,
      isNotNull(customerEmailDomains.verifiedAt),
      ne(customerEmailDomains.id, excludeId),
    ))
    .limit(1);
  const [row] = forUpdate ? await q.for('update') : await q;
  return (row as CustomerDomainRow | undefined) ?? null;
}

const clearedColumns = (now: Date, reason: DomainVerificationClearedReason) => ({
  verifiedAt: null,
  verifiedMethod: null,
  verifiedEvidence: null,
  verifiedByUserId: null,
  lastPassedAt: null,
  checkFailures: 0,
  clearedAt: now,
  clearedReason: reason,
  updatedAt: now,
});

async function audit(
  row: Pick<CustomerDomainRow, 'id' | 'orgId' | 'domain'>,
  action: string,
  actorUserId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await db.insert(auditLogs).values({
    orgId: row.orgId,
    ...(actorUserId
      ? { actorType: 'user' as const, actorId: actorUserId }
      : { actorType: 'system' as const, actorId: ANONYMOUS_ACTOR_ID }),
    action,
    resourceType: 'customer_email_domain', // literal: auditResourceTypeLabels.test.ts reads it
    resourceId: row.id,
    resourceName: row.domain,
    details,
    result: 'success',
  });
  markRequestAuditWritten();
}

interface LossNotice {
  orgId: string;
  partnerId: string;
  domain: string;
  reason: Exclude<DomainVerificationClearedReason, 'repointed' | 'msp_removed'>;
}

/** After commit: the affected partner's active admins. Best effort; never throws (D11). */
async function notifyVerificationLost(notice: LossNotice): Promise<void> {
  try {
    const email = getEmailService();
    if (!email) {
      console.warn(`[portalDomainVerification] email not configured: no loss notice for ${notice.domain} (org ${notice.orgId}, ${notice.reason})`);
      return;
    }
    const [names] = await withSystemDbAccessContext(() => db
      .select({ orgName: organizations.name, partnerName: partners.name })
      .from(organizations)
      .innerJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(organizations.id, notice.orgId))
      .limit(1), 'portalDomainVerification.lossNames');
    if (!names) {
      console.warn(`[portalDomainVerification] org ${notice.orgId} not found: no loss notice for ${notice.domain}`);
      return;
    }
    const admins = await listActivePartnerAdmins(notice.partnerId);
    if (admins.length === 0) {
      console.warn(`[portalDomainVerification] partner ${notice.partnerId} has no active admins: no loss notice for ${notice.domain}`);
      return;
    }
    await email.sendPortalDomainVerificationLost({
      to: admins.map((a) => a.email),
      partnerName: names.partnerName,
      orgName: names.orgName,
      domain: notice.domain,
      reason: notice.reason,
    });
  } catch (err) {
    console.error('[portalDomainVerification] verification-lost email failed:', err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }
}

// ---------------------------------------------------------------------------
// Request-context operations (partner-axis RLS)
// ---------------------------------------------------------------------------

/** This org's domains with verification state. Reads under the caller's context. */
export async function listOrgCustomerDomains(orgId: string): Promise<CustomerDomainView[]> {
  const rows = await db
    .select(rowColumns())
    .from(customerEmailDomains)
    .where(eq(customerEmailDomains.orgId, orgId))
    .orderBy(asc(customerEmailDomains.domain));
  return buildCustomerDomainViews(rows as CustomerDomainRow[]);
}

/**
 * Issues the DNS token if the row has none (idempotent: a second call returns
 * the same record). Runs under the caller's context.
 */
export async function startDnsVerification(orgId: string, domainId: string): Promise<{ recordName: string; recordValue: string }> {
  const [row] = await db
    .update(customerEmailDomains)
    .set({ verificationToken: sql`COALESCE(${customerEmailDomains.verificationToken}, ${generateOwnershipToken()})` })
    .where(and(eq(customerEmailDomains.id, domainId), eq(customerEmailDomains.orgId, orgId)))
    .returning({ domain: customerEmailDomains.domain, verificationToken: customerEmailDomains.verificationToken });
  if (!row?.verificationToken) throw notFound();
  return portalDomainTxtRecord(normalizeDomain(row.domain), row.verificationToken);
}

/**
 * MSP action: clears this org's verification (`msp_removed`), keeps the DNS
 * token (re-verifying with the same record needs no DNS change), audits
 * `domain_removed`. Runs under the caller's context.
 */
export async function removeCustomerDomainVerification(
  orgId: string,
  domainId: string,
  actorUserId: string,
): Promise<{ removed: boolean }> {
  const now = new Date();
  const run = async () => {
    const [existing] = await db
      .select({ id: customerEmailDomains.id, orgId: customerEmailDomains.orgId, domain: customerEmailDomains.domain, verifiedMethod: customerEmailDomains.verifiedMethod })
      .from(customerEmailDomains)
      .where(and(eq(customerEmailDomains.id, domainId), eq(customerEmailDomains.orgId, orgId)))
      .limit(1)
      .for('update');
    if (!existing) throw notFound();
    const [cleared] = await db
      .update(customerEmailDomains)
      .set({ ...clearedColumns(now, 'msp_removed'), lastCheckStatus: null })
      .where(and(eq(customerEmailDomains.id, domainId), isNotNull(customerEmailDomains.verifiedAt)))
      .returning({ id: customerEmailDomains.id });
    if (!cleared) return { removed: false };
    await audit(existing, AUDIT_REMOVED, actorUserId, { domain: existing.domain, method: existing.verifiedMethod });
    return { removed: true };
  };
  return hasDbAccessContext() ? withDbTransaction(run) : systemRead('remove', run);
}

// ---------------------------------------------------------------------------
// Verify (D5) — system scope, outside any request transaction
// ---------------------------------------------------------------------------

export interface VerifyCustomerDomainInput {
  orgId: string;
  partnerId: string;
  domainId: string;
  method: DomainVerificationMethod;
  actorUserId: string;
}

export interface VerifyCustomerDomainDeps {
  checkers?: DomainVerificationCheckers;
  now?: Date;
}

/**
 * Runs the chosen method's check outside any transaction, then writes under a
 * system context (the incumbent row may belong to another partner; the write
 * is backed by live evidence, not MSP input). Call from a route through
 * `runOutsideDbContext`, after the request-context read that proves the row
 * belongs to the caller's org.
 */
export async function verifyCustomerDomain(
  input: VerifyCustomerDomainInput,
  deps: VerifyCustomerDomainDeps = {},
): Promise<VerifyCustomerDomainOutcome> {
  assertNoHeldContext('verifyCustomerDomain');
  const checkers = deps.checkers ?? await defaultDomainVerificationCheckers();

  const row = await systemRead('verify.load', () => selectRowById(input.domainId));
  if (!row || row.orgId !== input.orgId || row.partnerId !== input.partnerId) throw notFound();
  if (!row.isActive) {
    throw new DomainVerificationError('DOMAIN_INACTIVE', 409, 'Turn the domain on before verifying it.');
  }
  if (row.verifiedAt && row.verifiedMethod !== input.method) {
    throw new DomainVerificationError(
      'DOMAIN_ALREADY_VERIFIED',
      409,
      'The domain is already verified by another method. Remove that verification first.',
    );
  }
  if (input.method === 'dns_txt' && !row.verificationToken) {
    throw new DomainVerificationError('DOMAIN_DNS_NOT_STARTED', 409, 'Start DNS verification to get the record to publish.');
  }

  // Network I/O with no context (and so no transaction) held.
  const result = await runChecker(checkers, input.method, targetOf(row));
  const now = deps.now ?? new Date();

  if (row.verifiedAt) return refreshVerifiedRow(row, input, result, now);
  if (result.status !== 'pass') {
    await recordFailedCheck(row, input, result, now, { requireUnverified: true });
    return result.status === 'fail'
      ? { result: 'failed', reason: result.reason }
      : { result: 'unavailable', reason: result.reason };
  }

  // pass on an unverified row: is the domain verified elsewhere? (D5)
  const incumbent = await systemRead('verify.incumbent', () => selectVerifiedIncumbent(row.domain, row.id));
  const incumbentResult = incumbent ? await liveRecheckVerifiedRow(incumbent, checkers) : null;

  let displaced: LossNotice | null;
  try {
    // Its own system transaction: a caught 23505 rolls it back and poisons nothing.
    displaced = await systemRead('verify.commit', () =>
      commitVerification(row, input, result.evidence, incumbent, incumbentResult, now));
  } catch (err) {
    // A concurrent challenger whose own live check just passed won the race.
    if (isPgUniqueViolation(err, 'customer_email_domains_verified_domain_uq')) throw verifiedElsewhere();
    throw err;
  }
  if (displaced) await notifyVerificationLost(displaced);
  return { result: 'verified', method: input.method, displacedOrgId: displaced?.orgId ?? null };
}

/** "Check now" on an already-verified row (D10): a pass refreshes; a miss is reported and changes no state. */
async function refreshVerifiedRow(
  row: CustomerDomainRow,
  input: VerifyCustomerDomainInput,
  result: DomainCheckResult,
  now: Date,
): Promise<VerifyCustomerDomainOutcome> {
  if (result.status !== 'pass') {
    await recordFailedCheck(row, input, result, now, { requireUnverified: false });
    return result.status === 'fail'
      ? { result: 'failed', reason: result.reason }
      : { result: 'unavailable', reason: result.reason };
  }
  const updated = await systemRead('verify.refresh', async () => {
    await lockDomain(row.domain);
    const current = await selectRowById(row.id, true);
    if (!current || !sameVerification(current, row)) return undefined;
    await assertEvidenceStillCurrent(row.orgId, result.evidence);
    const [r] = await db
      .update(customerEmailDomains)
      .set({
        // The live pass is fresh evidence by the same method (e.g. a recreated
        // Google connection's id), so it replaces the stored evidence.
        verifiedEvidence: result.evidence,
        lastCheckedAt: now,
        lastPassedAt: now,
        lastCheckStatus: 'pass',
        checkFailures: 0,
        updatedAt: now,
      })
      .where(and(
        eq(customerEmailDomains.id, row.id),
        eq(customerEmailDomains.orgId, row.orgId),
        eq(customerEmailDomains.verifiedMethod, input.method),
        isNotNull(customerEmailDomains.verifiedAt),
      ))
      .returning({ id: customerEmailDomains.id });
    return r;
  });
  if (!updated) throw conflictRetry();
  return { result: 'verified', method: input.method, displacedOrgId: null };
}

/** A manual check that did not pass: stamp it, audit it, never touch check_failures or verified state (D10). */
async function recordFailedCheck(
  row: CustomerDomainRow,
  input: VerifyCustomerDomainInput,
  result: Exclude<DomainCheckResult, { status: 'pass' }>,
  now: Date,
  opts: { requireUnverified: boolean },
): Promise<void> {
  await systemRead('verify.recordFailedCheck', async () => {
    await db
      .update(customerEmailDomains)
      .set({ lastCheckedAt: now, lastCheckStatus: result.status, updatedAt: now })
      .where(and(
        eq(customerEmailDomains.id, row.id),
        eq(customerEmailDomains.orgId, row.orgId),
        opts.requireUnverified
          ? sql`${customerEmailDomains.verifiedAt} IS NULL`
          : eq(customerEmailDomains.verifiedMethod, input.method),
      ));
    await audit(row, AUDIT_CHECK_FAILED, input.actorUserId, {
      domain: row.domain,
      method: input.method,
      status: result.status,
      reason: result.reason,
    });
  });
}

/**
 * The D5 write. Inside one transaction under a system context: per-domain
 * advisory lock, re-read both rows FOR UPDATE, refuse if anything moved since
 * the checks ran, displace a failed incumbent, verify this row.
 */
async function commitVerification(
  row: CustomerDomainRow,
  input: VerifyCustomerDomainInput,
  evidence: DomainVerificationEvidence,
  incumbentAtCheck: CustomerDomainRow | null,
  incumbentResult: DomainCheckResult | null,
  now: Date,
): Promise<LossNotice | null> {
  await lockDomain(row.domain);

  const current = await selectRowById(row.id, true);
  if (
    !current
    || current.orgId !== row.orgId
    || current.partnerId !== row.partnerId
    || !current.isActive
    || current.verifiedAt !== null
    || current.verificationToken !== row.verificationToken
    || normalizeDomain(current.domain) !== normalizeDomain(row.domain)
  ) {
    throw conflictRetry();
  }

  const incumbentNow = await selectVerifiedIncumbent(row.domain, row.id, true);
  if (!incumbentAtCheck && incumbentNow) throw conflictRetry();
  if (incumbentAtCheck) {
    if (!incumbentNow || !sameVerification(incumbentNow, incumbentAtCheck)) {
      throw conflictRetry();
    }
    if (incumbentResult?.status !== 'fail') throw verifiedElsewhere();
  }
  // The proof source must still be the one the check used (an Entra tenant
  // proof or Google connection revoked/replaced during the check).
  await assertEvidenceStillCurrent(row.orgId, evidence);

  let displaced: LossNotice | null = null;
  if (incumbentNow) {
    await db
      .update(customerEmailDomains)
      .set({ ...clearedColumns(now, 'displaced'), lastCheckedAt: now, lastCheckStatus: 'fail' })
      .where(eq(customerEmailDomains.id, incumbentNow.id));
    await audit(incumbentNow, AUDIT_DISPLACED, null, {
      domain: incumbentNow.domain,
      method: incumbentNow.verifiedMethod,
      displacedByOrgId: row.orgId,
      incumbentCheckReason: incumbentResult?.status === 'fail' ? incumbentResult.reason : null,
    });
    displaced = { orgId: incumbentNow.orgId, partnerId: incumbentNow.partnerId, domain: incumbentNow.domain, reason: 'displaced' };
  }

  await db
    .update(customerEmailDomains)
    .set({
      verifiedAt: now,
      verifiedMethod: input.method,
      verifiedEvidence: evidence,
      verifiedByUserId: input.actorUserId,
      lastCheckedAt: now,
      lastPassedAt: now,
      lastCheckStatus: 'pass',
      checkFailures: 0,
      clearedAt: null,
      clearedReason: null,
      updatedAt: now,
    })
    .where(eq(customerEmailDomains.id, row.id));
  await audit(row, AUDIT_VERIFIED, input.actorUserId, {
    domain: row.domain,
    method: input.method,
    ...(displaced ? { displacedOrgId: displaced.orgId } : {}),
  });
  return displaced;
}

// ---------------------------------------------------------------------------
// Re-check (D10) — worker entry, system scope
// ---------------------------------------------------------------------------

export type RecheckOutcome =
  | { status: 'pass' | 'fail' | 'unavailable'; cleared: DomainVerificationClearedReason | null }
  | { status: 'skipped'; cleared: null };

/**
 * Re-checks one verified row and applies D10: pass resets; a structural fail
 * clears at once; another fail counts and clears at the second in a row;
 * unavailable never counts; no pass for 7 days clears `stale`. Each clear audits
 * `domain_cleared` and emails the partner's admins after commit. A row that is
 * no longer verified (or changed while it was checked) is skipped.
 */
export async function recheckCustomerDomain(
  rowId: string,
  deps: VerifyCustomerDomainDeps = {},
): Promise<RecheckOutcome> {
  assertNoHeldContext('recheckCustomerDomain');
  const checkers = deps.checkers ?? await defaultDomainVerificationCheckers();
  const row = await systemRead('recheck.load', () => selectRowById(rowId));
  if (!row?.verifiedAt || !row.verifiedMethod) return { status: 'skipped', cleared: null };

  // Network I/O with no context (and so no transaction) held.
  const result = await liveRecheckVerifiedRow(row, checkers);
  const now = deps.now ?? new Date();

  const outcome = await systemRead('recheck.write', async (): Promise<{ out: RecheckOutcome; notice: LossNotice | null }> => {
    await lockDomain(row.domain);
    const current = await selectRowById(row.id, true);
    if (!current?.verifiedAt || !sameVerification(current, row)) {
      return { out: { status: 'skipped', cleared: null }, notice: null };
    }

    if (result.status === 'pass') {
      await db
        .update(customerEmailDomains)
        .set({ lastCheckedAt: now, lastPassedAt: now, lastCheckStatus: 'pass', checkFailures: 0, updatedAt: now })
        .where(eq(customerEmailDomains.id, current.id));
      return { out: { status: 'pass', cleared: null }, notice: null };
    }

    let clearReason: DomainVerificationClearedReason | null = null;
    let failures = current.checkFailures;
    if (result.status === 'fail') {
      failures += 1;
      if (STRUCTURAL_FAIL_REASONS.has(result.reason) || failures >= CLEAR_AFTER_CONSECUTIVE_FAILURES) {
        clearReason = result.reason;
      }
    }
    const lastPassed = current.lastPassedAt ?? current.verifiedAt;
    if (!clearReason && now.getTime() - lastPassed.getTime() >= PORTAL_DOMAIN_STALE_DAYS * DAY_MS) {
      clearReason = 'stale';
    }

    if (!clearReason) {
      await db
        .update(customerEmailDomains)
        .set({ lastCheckedAt: now, lastCheckStatus: result.status, checkFailures: failures, updatedAt: now })
        .where(eq(customerEmailDomains.id, current.id));
      return { out: { status: result.status, cleared: null }, notice: null };
    }

    await db
      .update(customerEmailDomains)
      .set({ ...clearedColumns(now, clearReason), lastCheckedAt: now, lastCheckStatus: result.status })
      .where(eq(customerEmailDomains.id, current.id));
    await audit(current, AUDIT_CLEARED, null, {
      domain: current.domain,
      method: current.verifiedMethod,
      reason: clearReason,
      checkStatus: result.status,
      checkReason: result.reason,
    });
    return {
      out: { status: result.status, cleared: clearReason },
      notice: { orgId: current.orgId, partnerId: current.partnerId, domain: current.domain, reason: clearReason as LossNotice['reason'] },
    };
  });

  if (outcome.notice) await notifyVerificationLost(outcome.notice);
  return outcome.out;
}

/**
 * Worker selection: verified rows last checked before `olderThan`, plus rows
 * with no pass since `staleBefore` (a manual "Check now" that keeps failing
 * advances last_checked_at and must not postpone the D10 stale clear), oldest
 * first.
 */
export async function listCustomerDomainsDueForRecheck(
  olderThan: Date,
  limit: number,
  staleBefore: Date = new Date(Date.now() - PORTAL_DOMAIN_STALE_DAYS * DAY_MS),
): Promise<string[]> {
  return inSystemContext('listDueForRecheck', async () => {
    const rows = await db
      .select({ id: customerEmailDomains.id })
      .from(customerEmailDomains)
      .where(and(
        isNotNull(customerEmailDomains.verifiedAt),
        sql`(COALESCE(${customerEmailDomains.lastCheckedAt}, ${customerEmailDomains.verifiedAt}) < ${olderThan.toISOString()}::timestamptz
             OR COALESCE(${customerEmailDomains.lastPassedAt}, ${customerEmailDomains.verifiedAt}) < ${staleBefore.toISOString()}::timestamptz)`,
      ))
      .orderBy(sql`COALESCE(${customerEmailDomains.lastCheckedAt}, ${customerEmailDomains.verifiedAt}) ASC`, asc(customerEmailDomains.id))
      .limit(limit);
    return rows.map((r) => r.id);
  });
}

// ---------------------------------------------------------------------------
// Read API for W6/W7 — system scope; re-checks evidence at use (D6)
// ---------------------------------------------------------------------------

export interface VerifiedDomainFact {
  domain: string;
  orgId: string;
  partnerId: string;
  method: DomainVerificationMethod;
  verifiedAt: Date;
}

function toFact(row: CustomerDomainRow): VerifiedDomainFact {
  return {
    domain: normalizeDomain(row.domain),
    orgId: row.orgId,
    partnerId: row.partnerId,
    method: row.verifiedMethod!,
    verifiedAt: row.verifiedAt!,
  };
}

async function currentOnly(rows: CustomerDomainRow[]): Promise<CustomerDomainRow[]> {
  const facts = await loadEvidenceFactsInContext(rows.map((r) => r.orgId));
  return rows.filter((row) => isVerificationCurrent(row, facts.get(row.orgId)));
}

/** The org a domain is CURRENTLY verified for, or null. Exact, case-insensitive; never a subdomain match. */
export async function findOrgByVerifiedDomain(domain: string): Promise<VerifiedDomainFact | null> {
  const d = normalizeDomain(domain);
  if (!d) return null;
  return inSystemContext('findOrgByVerifiedDomain', async () => {
    const rows = await db
      .select(rowColumns())
      .from(customerEmailDomains)
      .where(and(
        sql`lower(${customerEmailDomains.domain}) = ${d}`,
        isNotNull(customerEmailDomains.verifiedAt),
        eq(customerEmailDomains.isActive, true),
      ))
      .limit(1);
    const [row] = await currentOnly(rows as CustomerDomainRow[]);
    return row ? toFact(row) : null;
  });
}

export async function isDomainVerifiedForOrg(domain: string, orgId: string): Promise<boolean> {
  const fact = await findOrgByVerifiedDomain(domain);
  return fact?.orgId === orgId;
}

export async function listVerifiedDomainsForOrg(orgId: string): Promise<VerifiedDomainFact[]> {
  return inSystemContext('listVerifiedDomainsForOrg', async () => {
    const rows = await db
      .select(rowColumns())
      .from(customerEmailDomains)
      .where(and(
        eq(customerEmailDomains.orgId, orgId),
        isNotNull(customerEmailDomains.verifiedAt),
        eq(customerEmailDomains.isActive, true),
      ))
      .orderBy(asc(customerEmailDomains.domain));
    return (await currentOnly(rows as CustomerDomainRow[])).map(toFact);
  });
}
