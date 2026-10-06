/**
 * Administrator-approved, read-only diagnostic access grants.
 *
 * Request -> approval -> use:
 *   - `createDiagnosticAccessRequest` (tool `request_diagnostic_access`, chat or
 *     MCP) validates the scope, records a pending grant bound to the requesting
 *     principal, and fans it out as approval_requests rows to every eligible
 *     approver (same first-wins shape as PAM elevations). Nothing is readable
 *     yet: the tool cannot approve its own request, and no model-supplied field
 *     is authorization.
 *   - An eligible administrator decides it through the ordinary approvals
 *     surfaces (web inbox, mobile). `decideDiagnosticGrantInTx` activates or
 *     denies it inside the decision transaction.
 *   - `findCoveringGrant` is consulted by `diagnostic_list_directory` /
 *     `diagnostic_read_file`; the per-command signed authorization is minted at
 *     delivery (./delivery.ts) after the grant is checked again.
 *
 * Eligible approver = live `devices:execute` + `approvals:decide` for the
 * device's org, access to the device's site, active account.
 */
import { and, eq, gt, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  approvalRequests,
  devices,
  diagnosticAccessGrants,
  organizations,
  users,
} from '../../db/schema';
import type { DiagnosticAccessScope } from '../../db/schema/diagnosticAccess';
import type { AuthContext } from '../../middleware/auth';
import { canAccessOrg, canAccessSite, getUserPermissions, hasPermission, PERMISSIONS } from '../permissions';
import { resolveUsersWithPermissionForOrg } from '../usersWithPermission';
import { createAuditLog } from '../auditService';
import { dispatchApprovalPushToTokens, getUserPushTokens } from '../expoPush';
import {
  classifyDiagnosticPath,
  diagnosticPathDepth,
  diagnosticPathFormError,
  diagnosticPathKey,
  diagnosticPathWithin,
  MIN_DIAGNOSTIC_SCOPE_DEPTH,
  SENSITIVE_CLASS_LABELS,
  SENSITIVE_CLASSES,
  type SensitiveClass,
} from './classification';

export const DIAGNOSTIC_OPERATIONS = ['list', 'read'] as const;
export type DiagnosticOperation = (typeof DIAGNOSTIC_OPERATIONS)[number];

export const DEFAULT_GRANT_MINUTES = 240;
export const MAX_GRANT_MINUTES = 1440;
export const MIN_GRANT_MINUTES = 5;
/** How long a request waits for a decision before it lapses. */
export const REQUEST_TTL_MS = 60 * 60 * 1000;
/** Bound on outstanding (pending) requests per principal per device. */
export const MAX_PENDING_PER_BENEFICIARY = 5;

export type GrantRow = typeof diagnosticAccessGrants.$inferSelect;

export type Beneficiary = { kind: 'user' | 'api_key' | 'oauth_grant'; id: string };

export class DiagnosticAccessError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The exact principal a grant authorizes. Only a human's own session, an API
 * key or an MCP OAuth grant can hold a grant; AI operator agents, helpers,
 * device agents and system contexts cannot.
 */
export function beneficiaryOf(auth: AuthContext): Beneficiary | null {
  const p = auth.principal;
  if (p.kind === 'user_session' && auth.user?.id) return { kind: 'user', id: auth.user.id };
  // A partner service principal's apiKeyId is not an api_keys id; it holds no grant.
  if (p.kind === 'api_key' && p.partnerServicePrincipalId) return null;
  if (p.kind === 'api_key' && p.apiKeyId) return { kind: 'api_key', id: p.apiKeyId };
  if (p.kind === 'oauth_grant' && p.grantId) return { kind: 'oauth_grant', id: p.grantId };
  return null;
}

function sourceOf(b: Beneficiary): string {
  return b.kind === 'user' ? 'chat' : 'mcp';
}

type DeviceRow = Pick<typeof devices.$inferSelect, 'id' | 'orgId' | 'siteId' | 'hostname' | 'osType' | 'status'>;

function caseInsensitiveFor(osType: string | null | undefined): boolean {
  return osType !== 'linux';
}

function scopeKey(scopes: DiagnosticAccessScope[], ops: string[], classes: string[], ci: boolean): string {
  const s = scopes
    .map((x) => `${x.recursive ? 1 : 0}:${diagnosticPathKey(x.path, ci)}`)
    .sort()
    .join('|');
  return `${s}#${[...ops].sort().join(',')}#${[...classes].sort().join(',')}`;
}

export type DiagnosticRequestInput = {
  deviceId: string;
  paths: DiagnosticAccessScope[];
  operations: DiagnosticOperation[];
  purpose: string;
  durationMinutes?: number;
  sensitiveClasses?: SensitiveClass[];
};

/** Validates one requested scope; returns an error message or null. */
export function validateRequestedScope(
  scope: DiagnosticAccessScope,
  device: Pick<DeviceRow, 'osType'>,
  requestedClasses: ReadonlySet<string>,
): string | null {
  const formErr = diagnosticPathFormError(scope.path);
  if (formErr) return `${scope.path}: ${formErr}`;
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(scope.path);
  if (device.osType === 'windows' && !isWindowsPath) return `${scope.path}: this is a Windows device; use a full X:\\ path`;
  if (device.osType !== 'windows' && isWindowsPath) return `${scope.path}: this is not a Windows device`;
  const c = classifyDiagnosticPath(scope.path);
  if (c.hardDenied) return `${scope.path}: the Breeze agent's own configuration is never available through diagnostic access`;
  if (/^\/(proc|sys|dev)(\/|$)/.test(scope.path)) {
    return `${scope.path}: virtual and device filesystems are never available through diagnostic access`;
  }
  if (diagnosticPathDepth(scope.path) < MIN_DIAGNOSTIC_SCOPE_DEPTH) {
    return `${scope.path}: too broad; name a folder at least ${MIN_DIAGNOSTIC_SCOPE_DEPTH} levels below the drive or filesystem root (for example ${isWindowsPath ? 'C:\\ProgramData\\Vendor' : '/var/log'})`;
  }
  const missing = c.classes.filter((cls) => !requestedClasses.has(cls));
  if (missing.length > 0) {
    return `${scope.path}: this location holds ${missing.map((m) => SENSITIVE_CLASS_LABELS[m]).join('; ')}. Request it only by naming sensitiveClasses [${missing.join(', ')}] explicitly.`;
  }
  return null;
}

/** Everything the approver needs to see, in one structured value. */
export function describeRequest(input: {
  orgName: string;
  hostname: string;
  paths: DiagnosticAccessScope[];
  operations: string[];
  purpose: string;
  durationMinutes: number;
  sensitiveClasses: string[];
  requestedBy: string;
  principal: string;
}) {
  const ops = input.operations.includes('read') && input.operations.includes('list')
    ? 'list and read'
    : input.operations.join(' and ');
  const lines = [
    `Organization: ${input.orgName}`,
    `Device: ${input.hostname}`,
    `Access: READ-ONLY (${ops}); no writes, deletes, renames, scripts or registry changes`,
    `Duration: ${input.durationMinutes} minutes from approval`,
    `Requested by: ${input.requestedBy} (${input.principal})`,
    `Purpose: ${input.purpose}`,
    'Paths:',
    ...input.paths.map((p) => `  - ${p.path}${p.recursive ? '  [recursive: whole subtree]' : '  [this folder only]'}`),
  ];
  if (input.sensitiveClasses.length > 0) {
    lines.push('SENSITIVE — explicitly requested:');
    for (const c of input.sensitiveClasses) lines.push(`  ! ${SENSITIVE_CLASS_LABELS[c as SensitiveClass] ?? c}`);
  } else {
    lines.push(
      'Withheld even inside these paths: known locations of browser passwords/cookies, credential stores, private keys and stored tokens (a fixed list; anything else inside these paths is readable).',
    );
  }
  return lines.join('\n');
}

export async function resolveEligibleApprovers(
  device: Pick<DeviceRow, 'orgId' | 'siteId'>,
  partnerId: string | null,
): Promise<string[]> {
  const candidates = await resolveUsersWithPermissionForOrg(device.orgId, PERMISSIONS.APPROVALS_DECIDE);
  const out: string[] = [];
  for (const userId of candidates) {
    if (await isEligibleApprover(userId, device, partnerId)) out.push(userId);
  }
  return out;
}

/** Live check: may this user decide a diagnostic grant for this device? */
export async function isEligibleApprover(
  userId: string,
  device: Pick<DeviceRow, 'orgId' | 'siteId'>,
  partnerId: string | null,
): Promise<boolean> {
  const perms = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      getUserPermissions(userId, { partnerId: partnerId ?? undefined, orgId: device.orgId }, { bypassCache: true }),
    ),
  );
  if (!perms) return false;
  if (!canAccessOrg(perms, device.orgId)) return false;
  if (device.siteId && !canAccessSite(perms, device.siteId)) return false;
  return (
    hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)
    && hasPermission(perms, PERMISSIONS.APPROVALS_DECIDE.resource, PERMISSIONS.APPROVALS_DECIDE.action)
  );
}

export type CreateRequestResult = {
  grant: GrantRow;
  reused: boolean;
  approverCount: number;
  approvals: Array<{ id: string; userId: string }>;
};

/**
 * Records a pending request and fans it out for approval. The caller has
 * already passed the tool's RBAC and the device-access gate (deviceArgs).
 */
export async function createDiagnosticAccessRequest(
  auth: AuthContext,
  device: DeviceRow,
  input: DiagnosticRequestInput,
): Promise<CreateRequestResult> {
  const beneficiary = beneficiaryOf(auth);
  if (!beneficiary || !auth.user?.id) {
    throw new DiagnosticAccessError(
      'principal_not_supported',
      'Diagnostic access can be requested from an interactive Breeze session or an MCP API key / OAuth connection only.',
    );
  }
  const classes = [...new Set(input.sensitiveClasses ?? [])].filter((c): c is SensitiveClass =>
    (SENSITIVE_CLASSES as readonly string[]).includes(c),
  );
  const classSet = new Set<string>(classes);
  const ops = [...new Set(input.operations)];
  if (ops.length === 0) throw new DiagnosticAccessError('invalid_request', 'operations must include list and/or read');
  const duration = Math.round(input.durationMinutes ?? DEFAULT_GRANT_MINUTES);
  if (duration < MIN_GRANT_MINUTES || duration > MAX_GRANT_MINUTES) {
    throw new DiagnosticAccessError('invalid_request', `durationMinutes must be ${MIN_GRANT_MINUTES}-${MAX_GRANT_MINUTES}`);
  }
  const errors = input.paths.map((p) => validateRequestedScope(p, device, classSet)).filter((e): e is string => e !== null);
  if (errors.length > 0) throw new DiagnosticAccessError('invalid_scope', errors.join('\n'));

  // Every requested class must be reached by at least one requested path, so a
  // class is never granted "just in case" alongside unrelated paths.
  const reached = new Set<string>();
  for (const p of input.paths) for (const c of classifyDiagnosticPath(p.path).classes) reached.add(c);
  const unreached = classes.filter((c) => !reached.has(c) && !input.paths.some((p) => p.recursive));
  if (unreached.length > 0) {
    throw new DiagnosticAccessError(
      'invalid_scope',
      `sensitiveClasses [${unreached.join(', ')}] do not apply to any requested path; remove them`,
    );
  }

  const ci = caseInsensitiveFor(device.osType);
  const wantKey = scopeKey(input.paths, ops, classes, ci);
  const now = new Date();

  // Resolved before the write transaction: approver eligibility opens its own
  // system contexts and must not run while a transaction is held open.
  const [org] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({ name: organizations.name, partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, device.orgId)),
    ),
  );
  // The requester never approves their own request while anyone else can.
  // Same rule as action intents: when the requester is the ONLY eligible
  // approver (a sole operator), they get the single row, at `critical` so the
  // approvals ladder demands fresh re-authentication. The decide path
  // re-checks this live (decideApprovalRequest: self_approval_forbidden).
  const requesterId = auth.user.id;
  const eligible = await resolveEligibleApprovers(device, org?.partnerId ?? null);
  const others = eligible.filter((id) => id !== requesterId);
  const soleOperator = others.length === 0 && eligible.includes(requesterId);
  const approvers = soleOperator ? [requesterId] : others;

  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      // Serialize requests per (device, principal): the dedupe and the pending
      // cap below are read-then-insert, so concurrent calls would each see the
      // old count. Transaction-scoped; released at commit/rollback.
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`diag-request:${device.id}:${beneficiary.kind}:${beneficiary.id}`}))`,
      );
      const existing = await db
        .select()
        .from(diagnosticAccessGrants)
        .where(
          and(
            eq(diagnosticAccessGrants.deviceId, device.id),
            eq(diagnosticAccessGrants.orgId, device.orgId),
            eq(diagnosticAccessGrants.beneficiaryKind, beneficiary.kind),
            eq(diagnosticAccessGrants.beneficiaryId, beneficiary.id),
            inArray(diagnosticAccessGrants.status, ['pending_approval', 'active']),
          ),
        );
      const live = existing.filter((g) =>
        g.status === 'active' ? (g.expiresAt?.getTime() ?? 0) > now.getTime() : g.requestExpiresAt.getTime() > now.getTime(),
      );
      // Reuse only what the administrator already approved for THIS ask: same
      // scope and same purpose, and either an active grant that stays valid for
      // the whole requested duration or a pending request for the same
      // duration. Anything else is a new decision and goes to review.
      const purpose = input.purpose.trim();
      const same = live.find((g) => {
        if (scopeKey(g.scopes, g.operations, g.sensitiveClasses, ci) !== wantKey) return false;
        if (g.purpose !== purpose) return false;
        if (g.status === 'active') return (g.expiresAt?.getTime() ?? 0) >= now.getTime() + duration * 60_000;
        return g.durationMinutes === duration;
      });
      if (same) {
        return { grant: same, reused: true, approverCount: 0, approvals: [] };
      }
      if (live.filter((g) => g.status === 'pending_approval').length >= MAX_PENDING_PER_BENEFICIARY) {
        throw new DiagnosticAccessError(
          'too_many_pending',
          `There are already ${MAX_PENDING_PER_BENEFICIARY} pending diagnostic access requests for this device; wait for a decision or revoke one.`,
        );
      }

      const [requester] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, auth.user!.id));
      const requestExpiresAt = new Date(now.getTime() + REQUEST_TTL_MS);

      const [grant] = await db
        .insert(diagnosticAccessGrants)
        .values({
          orgId: device.orgId,
          deviceId: device.id,
          status: 'pending_approval',
          requestedByUserId: auth.user!.id,
          beneficiaryKind: beneficiary.kind,
          beneficiaryId: beneficiary.id,
          source: sourceOf(beneficiary),
          requestedAt: now,
          requestExpiresAt,
          purpose: input.purpose,
          operations: ops,
          scopes: input.paths.map((p) => ({ path: p.path, recursive: p.recursive })),
          sensitiveClasses: classes,
          durationMinutes: duration,
        })
        .returning();
      if (!grant) throw new Error('diagnostic access grant insert returned no row');

      const summary = describeRequest({
        orgName: org?.name ?? device.orgId,
        hostname: device.hostname,
        paths: grant.scopes,
        operations: grant.operations,
        purpose: grant.purpose,
        durationMinutes: grant.durationMinutes,
        sensitiveClasses: grant.sensitiveClasses,
        requestedBy: requester?.name || requester?.email || auth.user!.id,
        principal: beneficiary.kind === 'user' ? 'Breeze AI chat' : `MCP ${beneficiary.kind === 'api_key' ? 'API key' : 'OAuth connection'}`,
      });
      const approvals: Array<{ id: string; userId: string }> = [];
      for (const userId of approvers) {
        const [row] = await db
          .insert(approvalRequests)
          .values({
            userId,
            diagnosticAccessGrantId: grant.id,
            requestingClientLabel: beneficiary.kind === 'user' ? 'Breeze AI' : 'Breeze MCP',
            requestingMachineLabel: device.hostname,
            actionLabel: `Read-only diagnostic access on ${device.hostname}`,
            actionToolName: 'request_diagnostic_access',
            actionArguments: {
              grantId: grant.id,
              organization: org?.name ?? null,
              orgId: device.orgId,
              deviceId: device.id,
              hostname: device.hostname,
              operations: grant.operations,
              paths: grant.scopes,
              sensitiveClasses: grant.sensitiveClasses,
              purpose: grant.purpose,
              durationMinutes: grant.durationMinutes,
              requestedBy: requester?.email ?? null,
              principal: beneficiary.kind,
            },
            // Sensitive classes need the strongest ceremony the approvals
            // ladder has (critical = fresh re-authentication).
            // A sole operator approving their own request gets the same.
            riskTier: soleOperator || grant.sensitiveClasses.length > 0 ? 'critical' : 'high',
            riskSummary: summary,
            status: 'pending',
            isRecursive: false,
            expiresAt: requestExpiresAt,
          })
          .returning({ id: approvalRequests.id });
        if (row) approvals.push({ id: row.id, userId });
      }

      await createAuditLog({
        orgId: device.orgId,
        actorType: 'user',
        actorId: auth.user!.id,
        action: 'diagnostic_access.requested',
        resourceType: 'diagnostic_access_grant',
        resourceId: grant.id,
        details: {
          deviceId: device.id,
          hostname: device.hostname,
          paths: grant.scopes,
          operations: grant.operations,
          sensitiveClasses: grant.sensitiveClasses,
          durationMinutes: grant.durationMinutes,
          beneficiaryKind: beneficiary.kind,
          approverCount: approvals.length,
          soleOperator,
        },
        result: 'success',
      });
      return { grant, reused: false, approverCount: approvals.length, approvals };
    }),
  );
}

export type CoverageDenial =
  | 'no_grant'
  | 'grant_pending'
  | 'grant_expired'
  | 'grant_revoked'
  | 'operation_not_granted'
  | 'out_of_scope'
  | 'sensitive_not_granted'
  | 'hard_denied'
  | 'invalid_path';

export type CoverageResult =
  | { ok: true; grant: GrantRow }
  | { ok: false; reason: CoverageDenial; detail: string };

/** Whether `scopes` lexically cover `path` for `op` (mirrors the agent's rule). */
export function scopesCover(
  scopes: DiagnosticAccessScope[],
  path: string,
  op: DiagnosticOperation,
  caseInsensitive: boolean,
): boolean {
  const target = diagnosticPathKey(path, caseInsensitive);
  return scopes.some((s) => {
    const { within, directChild } = diagnosticPathWithin(diagnosticPathKey(s.path, caseInsensitive), target);
    if (!within) return false;
    if (s.recursive) return true;
    const isRoot = target === diagnosticPathKey(s.path, caseInsensitive);
    // Non-recursive: list the location itself; read files directly inside it.
    return op === 'list' ? isRoot : directChild;
  });
}

/** Grant-level decision for one path (no DB access). */
export function evaluateGrantCoverage(
  grant: GrantRow,
  device: Pick<DeviceRow, 'id' | 'orgId' | 'osType'>,
  path: string,
  op: DiagnosticOperation,
  now: Date,
): CoverageResult {
  if (grant.deviceId !== device.id || grant.orgId !== device.orgId) {
    return { ok: false, reason: 'no_grant', detail: 'grant is for a different device or organization' };
  }
  if (grant.status === 'pending_approval') return { ok: false, reason: 'grant_pending', detail: 'awaiting approval' };
  if (grant.status === 'revoked') return { ok: false, reason: 'grant_revoked', detail: 'grant was revoked' };
  if (grant.status !== 'active' || !grant.expiresAt || grant.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'grant_expired', detail: 'grant has expired' };
  }
  if (!grant.operations.includes(op)) {
    return { ok: false, reason: 'operation_not_granted', detail: `grant does not include ${op}` };
  }
  const formErr = diagnosticPathFormError(path);
  if (formErr) return { ok: false, reason: 'invalid_path', detail: formErr };
  const c = classifyDiagnosticPath(path);
  if (c.hardDenied || /^\/(proc|sys|dev)(\/|$)/.test(path)) {
    return { ok: false, reason: 'hard_denied', detail: 'never available through diagnostic access' };
  }
  if (!scopesCover(grant.scopes, path, op, caseInsensitiveFor(device.osType))) {
    return { ok: false, reason: 'out_of_scope', detail: 'path is outside the approved locations' };
  }
  const missing = c.classes.filter((cls) => !grant.sensitiveClasses.includes(cls));
  if (missing.length > 0) {
    return { ok: false, reason: 'sensitive_not_granted', detail: `path is a ${missing.join(', ')} location that was not approved` };
  }
  return { ok: true, grant };
}

/**
 * Finds the caller's active grant that covers (device, path, op). Grants are
 * per-principal: another technician's or another key's grant never covers.
 * Expired rows are flipped to 'expired' on the way.
 */
export async function findCoveringGrant(
  auth: AuthContext,
  device: Pick<DeviceRow, 'id' | 'orgId' | 'osType'>,
  path: string,
  op: DiagnosticOperation,
  now = new Date(),
): Promise<CoverageResult> {
  const beneficiary = beneficiaryOf(auth);
  if (!beneficiary) return { ok: false, reason: 'no_grant', detail: 'this caller cannot hold diagnostic grants' };
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select()
        .from(diagnosticAccessGrants)
        .where(
          and(
            eq(diagnosticAccessGrants.deviceId, device.id),
            eq(diagnosticAccessGrants.orgId, device.orgId),
            eq(diagnosticAccessGrants.beneficiaryKind, beneficiary.kind),
            eq(diagnosticAccessGrants.beneficiaryId, beneficiary.id),
          ),
        ),
    ),
  );
  await expireLapsed(rows, now);
  let best: CoverageResult | null = null;
  // Most informative denial wins when nothing covers.
  const rank: Record<CoverageDenial, number> = {
    no_grant: 0, invalid_path: 1, grant_pending: 2, grant_revoked: 3, grant_expired: 4,
    out_of_scope: 5, operation_not_granted: 6, sensitive_not_granted: 7, hard_denied: 8,
  };
  for (const g of rows) {
    const r = evaluateGrantCoverage(g, device, path, op, now);
    if (r.ok) return r;
    if (!best || (!best.ok && rank[r.reason] > rank[best.reason])) best = r;
  }
  return best ?? { ok: false, reason: 'no_grant', detail: 'no diagnostic access grant exists for this device' };
}

async function expireLapsed(rows: GrantRow[], now: Date): Promise<void> {
  const lapsed = rows.filter(
    (g) =>
      (g.status === 'active' && g.expiresAt && g.expiresAt.getTime() <= now.getTime())
      || (g.status === 'pending_approval' && g.requestExpiresAt.getTime() <= now.getTime()),
  );
  if (lapsed.length === 0) return;
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      for (const g of lapsed) {
        await db
          .update(diagnosticAccessGrants)
          .set({ status: 'expired', updatedAt: now })
          .where(and(eq(diagnosticAccessGrants.id, g.id), eq(diagnosticAccessGrants.status, g.status)));
        if (g.status === 'pending_approval') {
          await db
            .update(approvalRequests)
            .set({ status: 'expired', decidedAt: now })
            .where(and(eq(approvalRequests.diagnosticAccessGrantId, g.id), eq(approvalRequests.status, 'pending')));
        }
      }
    }),
  );
  for (const g of lapsed) g.status = 'expired';
}

/** Re-read a grant for delivery / decision (system context, no caller filter). */
export async function loadGrant(grantId: string): Promise<GrantRow | null> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select().from(diagnosticAccessGrants).where(eq(diagnosticAccessGrants.id, grantId)).limit(1),
    ),
  );
  return row ?? null;
}

/**
 * Who may revoke: the beneficiary (the requesting principal / its user) or any
 * eligible approver for the device. Revoking only ever removes access.
 */
export async function revokeDiagnosticGrant(
  auth: AuthContext,
  grantId: string,
  reason: string | null,
): Promise<{ ok: true; grant: GrantRow } | { ok: false; code: string; message: string }> {
  const grant = await loadGrant(grantId);
  if (!grant) return { ok: false, code: 'not_found', message: 'Diagnostic access grant not found' };
  // Tenancy: the caller must be able to see the grant's org at all.
  if (!auth.canAccessOrg(grant.orgId)) return { ok: false, code: 'not_found', message: 'Diagnostic access grant not found' };
  const beneficiary = beneficiaryOf(auth);
  const isBeneficiary =
    !!beneficiary && beneficiary.kind === grant.beneficiaryKind && beneficiary.id === grant.beneficiaryId;
  const isRequesterUser = !!auth.user?.id && auth.user.id === grant.requestedByUserId && auth.principal.kind === 'user_session';
  let allowed = isBeneficiary || isRequesterUser;
  if (!allowed && auth.user?.id && auth.principal.kind === 'user_session') {
    const [dev] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.select({ orgId: devices.orgId, siteId: devices.siteId }).from(devices).where(eq(devices.id, grant.deviceId)),
      ),
    );
    const [org] = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, grant.orgId)),
      ),
    );
    allowed = !!dev && (await isEligibleApprover(auth.user.id, { orgId: grant.orgId, siteId: dev.siteId }, org?.partnerId ?? null));
  }
  if (!allowed) return { ok: false, code: 'forbidden', message: 'Only the requester or an eligible approver can revoke this grant' };
  if (grant.status !== 'active' && grant.status !== 'pending_approval') {
    return { ok: false, code: 'not_active', message: `Grant is already ${grant.status}` };
  }
  const now = new Date();
  const updated = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .update(diagnosticAccessGrants)
        .set({
          status: 'revoked',
          revokedAt: now,
          revokedByUserId: auth.user?.id ?? null,
          revokeReason: reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(diagnosticAccessGrants.id, grantId),
            inArray(diagnosticAccessGrants.status, ['active', 'pending_approval']),
          ),
        )
        .returning();
      await db
        .update(approvalRequests)
        .set({ status: 'expired', decidedAt: now })
        .where(and(eq(approvalRequests.diagnosticAccessGrantId, grantId), eq(approvalRequests.status, 'pending')));
      return row ?? null;
    }),
  );
  if (!updated) return { ok: false, code: 'not_active', message: 'Grant changed state concurrently; nothing revoked' };
  await createAuditLog({
    orgId: grant.orgId,
    actorType: beneficiary?.kind === 'api_key' && !auth.user?.id ? 'api_key' : 'user',
    actorId: auth.user?.id ?? (beneficiary?.kind === 'api_key' ? beneficiary.id : grant.requestedByUserId),
    action: 'diagnostic_access.revoked',
    resourceType: 'diagnostic_access_grant',
    resourceId: grantId,
    details: { deviceId: grant.deviceId, previousStatus: grant.status, reason },
    result: 'success',
  });
  return { ok: true, grant: updated };
}

/** The caller's own requests and grants, for a device or all devices in reach. */
export async function listDiagnosticGrants(
  auth: AuthContext,
  filter: { deviceId?: string; includeInactive?: boolean; limit: number; scope?: Array<SQL | undefined> },
): Promise<GrantRow[]> {
  // A grant's scope and purpose belong to the principal that requested it;
  // approvers see requests in the approvals inbox, not here.
  const b = beneficiaryOf(auth);
  if (!b) return [];
  await expireLapsedForBeneficiary(b, auth);
  const conditions: SQL[] = [];
  const orgCond = auth.orgCondition(diagnosticAccessGrants.orgId);
  if (orgCond) conditions.push(orgCond);
  for (const c of filter.scope ?? []) if (c) conditions.push(c);
  conditions.push(eq(diagnosticAccessGrants.beneficiaryKind, b.kind), eq(diagnosticAccessGrants.beneficiaryId, b.id));
  if (filter.deviceId) conditions.push(eq(diagnosticAccessGrants.deviceId, filter.deviceId));
  if (!filter.includeInactive) conditions.push(inArray(diagnosticAccessGrants.status, ['pending_approval', 'active']));
  return db
    .select()
    .from(diagnosticAccessGrants)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(sql`${diagnosticAccessGrants.createdAt} DESC`)
    .limit(filter.limit);
}

/**
 * Marks the listing principal's own lapsed grants expired, within the
 * caller's organizations, and retires the approval cards of lapsed requests.
 */
async function expireLapsedForBeneficiary(
  b: NonNullable<ReturnType<typeof beneficiaryOf>>,
  auth: AuthContext,
): Promise<void> {
  const orgCond = auth.orgCondition(diagnosticAccessGrants.orgId);
  const now = new Date();
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      await db
        .update(diagnosticAccessGrants)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            ...(orgCond ? [orgCond] : []),
            eq(diagnosticAccessGrants.beneficiaryKind, b.kind),
            eq(diagnosticAccessGrants.beneficiaryId, b.id),
            eq(diagnosticAccessGrants.status, 'active'),
            lte(diagnosticAccessGrants.expiresAt, now),
          ),
        );
      const lapsedRequests = await db
        .update(diagnosticAccessGrants)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            ...(orgCond ? [orgCond] : []),
            eq(diagnosticAccessGrants.beneficiaryKind, b.kind),
            eq(diagnosticAccessGrants.beneficiaryId, b.id),
            eq(diagnosticAccessGrants.status, 'pending_approval'),
            lte(diagnosticAccessGrants.requestExpiresAt, now),
          ),
        )
        .returning({ id: diagnosticAccessGrants.id });
      if (lapsedRequests.length > 0) {
        await db
          .update(approvalRequests)
          .set({ status: 'expired', decidedAt: now })
          .where(and(
            inArray(approvalRequests.diagnosticAccessGrantId, lapsedRequests.map((r) => r.id)),
            eq(approvalRequests.status, 'pending'),
          ));
      }
    }),
  );
}

/**
 * Decision hook, called by decideApprovalRequest INSIDE its transaction after
 * it won the approval-row CAS. Returns the grant row after the transition, or
 * null when the grant was no longer pending (lost race / expired / revoked),
 * in which case nothing was activated.
 */
export async function decideDiagnosticGrantInTx(
  tx: typeof db,
  input: {
    grantId: string;
    approvalRequestId: string;
    deciderUserId: string;
    status: 'approved' | 'denied';
    reason: string | null;
    decidedAssuranceLevel: number | null;
    decidedVia: string | null;
    now: Date;
  },
): Promise<GrantRow | null> {
  const [current] = await tx
    .select()
    .from(diagnosticAccessGrants)
    .where(eq(diagnosticAccessGrants.id, input.grantId))
    .limit(1);
  if (!current || current.status !== 'pending_approval' || current.requestExpiresAt.getTime() <= input.now.getTime()) {
    return null;
  }
  const values =
    input.status === 'approved'
      ? {
          status: 'active' as const,
          approvedByUserId: input.deciderUserId,
          approvedAt: input.now,
          expiresAt: new Date(input.now.getTime() + current.durationMinutes * 60_000),
          decidedAssuranceLevel: input.decidedAssuranceLevel,
          decidedVia: input.decidedVia,
          updatedAt: input.now,
        }
      : {
          status: 'denied' as const,
          deniedByUserId: input.deciderUserId,
          deniedAt: input.now,
          denialReason: input.reason,
          decidedAssuranceLevel: input.decidedAssuranceLevel,
          decidedVia: input.decidedVia,
          updatedAt: input.now,
        };
  const [row] = await tx
    .update(diagnosticAccessGrants)
    .set(values)
    .where(
      and(
        eq(diagnosticAccessGrants.id, input.grantId),
        eq(diagnosticAccessGrants.status, 'pending_approval'),
        gt(diagnosticAccessGrants.requestExpiresAt, input.now),
      ),
    )
    .returning();
  if (!row) return null;
  await tx
    .update(approvalRequests)
    .set({ status: 'expired', decidedAt: input.now })
    .where(
      and(
        eq(approvalRequests.diagnosticAccessGrantId, input.grantId),
        eq(approvalRequests.status, 'pending'),
        ne(approvalRequests.id, input.approvalRequestId),
      ),
    );
  return row;
}

/** Audit a decision (called after the decision transaction commits). */
export async function auditDiagnosticDecision(grant: GrantRow, deciderUserId: string, approvalRequestId: string): Promise<void> {
  await createAuditLog({
    orgId: grant.orgId,
    actorType: 'user',
    actorId: deciderUserId,
    action: grant.status === 'active' ? 'diagnostic_access.approved' : 'diagnostic_access.denied',
    resourceType: 'diagnostic_access_grant',
    resourceId: grant.id,
    details: {
      deviceId: grant.deviceId,
      approvalRequestId,
      paths: grant.scopes,
      operations: grant.operations,
      sensitiveClasses: grant.sensitiveClasses,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      decidedAssuranceLevel: grant.decidedAssuranceLevel,
      decidedVia: grant.decidedVia,
      beneficiaryKind: grant.beneficiaryKind,
    },
    result: 'success',
  });
}

/** Records one use (outcome metadata only — never content). */
export async function recordDiagnosticAccess(
  grant: GrantRow,
  auth: AuthContext,
  event: {
    operation: DiagnosticOperation;
    path: string;
    resolvedPath: string | null;
    commandId: string | null;
    outcome: string;
    bytesRead?: number;
    entries?: number;
  },
): Promise<void> {
  const now = new Date();
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .update(diagnosticAccessGrants)
        .set({ lastUsedAt: now, useCount: sql`${diagnosticAccessGrants.useCount} + 1`, updatedAt: now })
        .where(eq(diagnosticAccessGrants.id, grant.id)),
    ),
  );
  const b = beneficiaryOf(auth);
  await createAuditLog({
    orgId: grant.orgId,
    actorType: b?.kind === 'api_key' ? 'api_key' : 'user',
    actorId: b?.kind === 'api_key' ? b.id : auth.user?.id ?? grant.requestedByUserId,
    action: event.operation === 'read' ? 'diagnostic_access.file_read' : 'diagnostic_access.directory_listed',
    resourceType: 'device',
    resourceId: grant.deviceId,
    details: {
      grantId: grant.id,
      approvedBy: grant.approvedByUserId,
      userId: auth.user?.id ?? null,
      path: event.path,
      resolvedPath: event.resolvedPath,
      commandId: event.commandId,
      outcome: event.outcome,
      bytesRead: event.bytesRead ?? null,
      entries: event.entries ?? null,
    },
    result: event.outcome === 'ok' ? 'success' : 'failure',
  });
}

/**
 * Best-effort phone push for freshly fanned-out approval rows. Runs after the
 * write transaction; a dead token or provider outage never fails the request.
 */
export async function pushDiagnosticApprovals(
  approvals: Array<{ id: string; userId: string }>,
  actionLabel: string,
): Promise<void> {
  for (const a of approvals) {
    try {
      const tokens = await runOutsideDbContext(() => withSystemDbAccessContext(() => getUserPushTokens(a.userId)));
      if (tokens.length === 0) continue;
      await dispatchApprovalPushToTokens(tokens, {
        approvalId: a.id,
        actionLabel,
        requestingClientLabel: 'Breeze diagnostic access',
      });
    } catch (err) {
      console.error(`[diagnosticAccess] approval push failed for approval=${a.id}:`, err);
    }
  }
}
