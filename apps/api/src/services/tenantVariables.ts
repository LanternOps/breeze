import { randomUUID } from 'crypto';
import { and, asc, count, eq, isNull, sql, type SQL } from 'drizzle-orm';
import {
  MAX_TENANT_VARIABLES_PER_OWNER,
  MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH,
  type CreateTenantVariableInput,
  type TenantVariable,
  type TenantVariableOwnerScope,
  type UpdateTenantVariableInput
} from '@breeze/shared';
import { db } from '../db';
import { tenantVariables, type TenantVariableRow } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from './encryptedColumnRegistry';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { decryptSecret, encryptSecret, isEncryptedSecret } from './secretCrypto';

/**
 * Tenant variables (#3409) — a value an MSP defines once, org-scoped or
 * partner-wide, and references from scripts (PR 2 onward).
 *
 * This module owns three things no caller may reimplement:
 *   1. value encryption, bound to the row id (see below);
 *   2. the app-layer tenancy conditions, which must never be looser than RLS;
 *   3. the partner-wide write capability gate.
 */

/**
 * The registry entry is the single source of truth for the AAD binding —
 * looked up rather than re-declared so this module and the rotation walker can
 * never drift apart. Absence is a programming error (someone dropped the
 * registration), and failing at import is the point: a missing entry would
 * silently mean rotation skips the column.
 */
const VALUE_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find((s) => s.table === 'tenant_variables' && s.column === 'value');
  if (!spec) throw new Error('tenant_variables.value is missing from encryptedColumnRegistry');
  return spec;
})();

/** Carries its own HTTP status so routes can map it without a second switch. */
export class TenantVariableError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'TenantVariableError';
  }
}

/**
 * Seal a value for a specific row.
 *
 * The AAD binds the ciphertext to `tenant_variables.value:<row id>`, so a blob
 * lifted from another tenant's row fails to decrypt instead of yielding their
 * secret. That is why the row id is generated here and inserted explicitly
 * rather than left to the column default — the binding has to exist before the
 * row does.
 *
 * Deployments with no APP_ENCRYPTION_KEY_ID seal to `enc:v1:` under the global
 * key and ignore AAD entirely (secretCrypto.encryptSecret); v1 ciphertext also
 * ignores the AAD argument on the way back out, so both configurations
 * round-trip. The row binding materializes as soon as a key id is configured —
 * the same degrade path every other registered column takes.
 */
export function encryptTenantVariableValue(id: string, plaintext: string): string {
  // encryptSecret passes an `enc:vN:` prefixed string straight through as
  // "already encrypted". The Zod schema rejects such values at the ingress;
  // this is the belt-and-braces check for any non-route caller, because the
  // failure mode is storing caller-controlled text as if it were ciphertext.
  if (isEncryptedSecret(plaintext)) {
    throw new TenantVariableError('Value must not start with "enc:v<n>:"', 400);
  }
  return encryptSecret(plaintext, { aad: columnAad(VALUE_SPEC, id) }) ?? plaintext;
}

/** Inverse of {@link encryptTenantVariableValue}. Throws if the row binding does not match. */
export function decryptTenantVariableValue(row: Pick<TenantVariableRow, 'id' | 'value'>): string {
  return decryptSecret(row.value, { aad: columnAad(VALUE_SPEC, row.id) }) ?? '';
}

export function tenantVariableOwnerScope(row: Pick<TenantVariableRow, 'orgId'>): TenantVariableOwnerScope {
  return row.orgId === null ? 'partner' : 'organization';
}

/**
 * Row -> API shape. Secret values are dropped here, at the single chokepoint
 * every route response goes through, so no endpoint can leak one by forgetting
 * to redact.
 */
export function toApiTenantVariable(row: TenantVariableRow): TenantVariable {
  let value: string | null = null;
  if (!row.isSecret) {
    try {
      value = decryptTenantVariableValue(row);
    } catch (err) {
      // A single unreadable row (mid-rotation, wrong key) must not 500 the
      // whole list — surface it as an absent value and leave a breadcrumb.
      console.warn('[tenant-variables] failed to decrypt value', { id: row.id, err });
      value = null;
    }
  }

  return {
    id: row.id,
    key: row.key,
    value,
    isSecret: row.isSecret,
    description: row.description,
    ownerScope: tenantVariableOwnerScope(row),
    orgId: row.orgId,
    partnerId: row.partnerId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/**
 * READ condition: org rows the caller can reach, plus the caller's OWN
 * partner's partner-wide rows.
 *
 * The partner branch applies to organization scope too, unlike
 * ticketFormAccessCondition — deliberately, because tenant_variables carries a
 * SELECT-only RLS policy (tenant_variables_partner_wide_select) widening the
 * same rows to org sessions. An org admin has to see the inherited variables
 * that already apply to their own devices. App and DB agree exactly.
 */
export function tenantVariableReadCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(tenantVariables.orgId);
  if (!orgCond) return undefined; // system scope: unrestricted
  if (auth.partnerId) {
    return sql`(${orgCond} OR (${tenantVariables.orgId} IS NULL AND ${tenantVariables.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

/**
 * WRITE condition: strictly narrower than the read condition. An org-scoped
 * session may READ its partner's partner-wide variables but must never target
 * one for update/delete — the DB widening is FOR SELECT, so a write would
 * silently affect 0 rows. Dropping the branch here turns that into an honest
 * 404 at the fetch step instead.
 */
function tenantVariableWriteCondition(auth: AuthContext): SQL | undefined {
  const orgCond = auth.orgCondition(tenantVariables.orgId);
  if (!orgCond) return undefined;
  if (auth.scope === 'partner' && auth.partnerId) {
    return sql`(${orgCond} OR (${tenantVariables.orgId} IS NULL AND ${tenantVariables.partnerId} = ${auth.partnerId}))`;
  }
  return orgCond;
}

/**
 * Fetch a mutation target with the caller's write condition ANDed in —
 * app-layer defense in depth mirroring getFormWithAccess in
 * routes/tickets/forms.ts. RLS is the primary boundary; the app layer must not
 * rely on it alone.
 */
async function getVariableForWrite(id: string, auth: AuthContext): Promise<TenantVariableRow | null> {
  const conditions: SQL[] = [eq(tenantVariables.id, id)];
  const accessCondition = tenantVariableWriteCondition(auth);
  if (accessCondition) conditions.push(accessCondition);

  const rows = await db
    .select()
    .from(tenantVariables)
    .where(and(...conditions))
    .limit(1);
  return rows[0] ?? null;
}

interface VariableOwner {
  orgId: string | null;
  partnerId: string | null;
}

/**
 * Resolve the ownership axis for a create. The partner is ALWAYS the caller's
 * own — a client-supplied partner id is never consulted. Mirrors the ownership
 * block in routes/tickets/forms.ts:160-178.
 */
function resolveOwner(auth: AuthContext, input: CreateTenantVariableInput): VariableOwner {
  if (input.ownerScope === 'partner') {
    if (!auth.partnerId) {
      throw new TenantVariableError('Partner-wide variables require partner scope', 403);
    }
    if (!canManagePartnerWidePolicies(auth)) {
      throw new TenantVariableError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 403);
    }
    return { orgId: null, partnerId: auth.partnerId };
  }

  if (auth.scope === 'organization') {
    if (!auth.orgId || (input.orgId && input.orgId !== auth.orgId)) {
      throw new TenantVariableError('Organization context required', 403);
    }
    return { orgId: auth.orgId, partnerId: null };
  }

  if (!input.orgId || !auth.canAccessOrg(input.orgId)) {
    throw new TenantVariableError('orgId is required and must be accessible', 400);
  }
  return { orgId: input.orgId, partnerId: null };
}

/**
 * Bound the number of variables per owner. This is what keeps PR 2's
 * per-dispatch resolution a single small query rather than an unbounded one,
 * so it is enforced on the write path, not merely displayed in the UI.
 *
 * Count-then-insert is deliberately not serialized: two concurrent creates can
 * both observe 199 and land on 201. The cap is a resource bound, not a security
 * boundary, and an advisory lock per owner would add contention to every create
 * to prevent an overshoot of one.
 */
async function assertOwnerCapacity(owner: VariableOwner): Promise<void> {
  const ownerCondition = owner.orgId
    ? eq(tenantVariables.orgId, owner.orgId)
    : and(isNull(tenantVariables.orgId), eq(tenantVariables.partnerId, owner.partnerId!));

  const [row] = await db.select({ total: count() }).from(tenantVariables).where(ownerCondition);
  if ((row?.total ?? 0) >= MAX_TENANT_VARIABLES_PER_OWNER) {
    throw new TenantVariableError(
      `This scope already has the maximum of ${MAX_TENANT_VARIABLES_PER_OWNER} variables`,
      409
    );
  }
}

/** Postgres unique-violation, however the driver happens to wrap it. */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

export interface ListTenantVariablesFilter {
  /** Restrict to one org's own variables plus the partner-wide rows it inherits. */
  orgId?: string;
}

export async function listTenantVariables(
  auth: AuthContext,
  filter: ListTenantVariablesFilter = {}
): Promise<TenantVariable[]> {
  const conditions: SQL[] = [];
  const accessCondition = tenantVariableReadCondition(auth);
  if (accessCondition) conditions.push(accessCondition);
  if (filter.orgId) {
    // Partner-wide rows (org_id NULL) apply to this org too; the access
    // condition above already restricts them to the caller's own partner.
    conditions.push(sql`(${tenantVariables.orgId} = ${filter.orgId} OR ${tenantVariables.orgId} IS NULL)`);
  }

  const rows = await db
    .select()
    .from(tenantVariables)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // Org-owned rows first within a key so the UI can render the override
    // above the partner-wide row it shadows (false sorts before true).
    .orderBy(asc(tenantVariables.key), asc(sql`${tenantVariables.orgId} IS NULL`));

  return rows.map(toApiTenantVariable);
}

export async function createTenantVariable(
  auth: AuthContext,
  input: CreateTenantVariableInput
): Promise<TenantVariableRow> {
  const owner = resolveOwner(auth, input);
  await assertOwnerCapacity(owner);

  // Server-generated: the AAD binds to this id, and a client-supplied id must
  // never reach a uuid/FK column.
  const id = randomUUID();

  try {
    const [row] = await db
      .insert(tenantVariables)
      .values({
        id,
        orgId: owner.orgId,
        partnerId: owner.partnerId,
        key: input.key,
        value: encryptTenantVariableValue(id, input.value),
        isSecret: input.isSecret,
        description: input.description ?? null,
        version: 1,
        createdBy: auth.user.id,
        updatedBy: auth.user.id
      })
      .returning();
    if (!row) throw new TenantVariableError('Failed to create variable', 500);
    return row;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TenantVariableError(`A variable named "${input.key}" already exists in this scope`, 409);
    }
    throw err;
  }
}

export async function updateTenantVariable(
  auth: AuthContext,
  id: string,
  input: UpdateTenantVariableInput
): Promise<TenantVariableRow> {
  const row = await getVariableForWrite(id, auth);
  if (!row) throw new TenantVariableError('Variable not found', 404);

  if (row.orgId === null && !canManagePartnerWidePolicies(auth)) {
    throw new TenantVariableError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 403);
  }

  // Un-secreting a variable would start returning its stored value in every
  // list response. Require the caller to supply a replacement instead, so the
  // old secret is never revealed by a flag flip alone.
  if (row.isSecret && input.isSecret === false && input.value === undefined) {
    throw new TenantVariableError(
      'Provide a new value when turning off "secret" — the stored secret is never revealed',
      400
    );
  }

  // #3409 PR4a — redaction floor. The shared cross-field refinement only fires
  // when BOTH `value` and `isSecret` are on the request; `updateTenantVariableSchema`
  // is `.partial()`, so flipping `isSecret` to true alone slips past it. Measure
  // against the STORED value here, otherwise a 2-character variable could be
  // promoted to secret and would then fail on every device at dispatch.
  const willBeSecret = input.isSecret ?? row.isSecret;
  if (willBeSecret) {
    const effectiveValue = input.value ?? readStoredPlaintextForFloorCheck(row);
    if (effectiveValue !== null && effectiveValue.length < MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH) {
      throw new TenantVariableError(
        `Secret values must be at least ${MIN_SECRET_TENANT_VARIABLE_VALUE_LENGTH} characters so they can be redacted from script output`,
        400
      );
    }
  }

  const updates: Partial<TenantVariableRow> = { updatedBy: auth.user.id, updatedAt: new Date() };
  if (input.description !== undefined) updates.description = input.description;
  if (input.isSecret !== undefined) updates.isSecret = input.isSecret;

  // Omitting `value` is the no-clobber path — the stored ciphertext is left
  // byte-identical, which is the only way to edit a secret's description.
  if (input.value !== undefined) {
    updates.value = encryptTenantVariableValue(row.id, input.value);
    if (valueChanged(row, input.value)) {
      // version identifies which snapshot a dispatch resolved (PR 4 pins it in
      // the four-eyes effect digest), so it tracks the VALUE only — a
      // description edit must not invalidate a pending approval.
      updates.version = row.version + 1;
    }
  }

  // The predicate repeats the access condition and pins the version read above:
  // the fetch and the write are separate statements, so without this a row that
  // changed owner (or was edited by a concurrent request) in between would be
  // updated anyway — and two concurrent value edits would both write version
  // N+1, breaking the pinning PR 4's effect digest depends on. No row matching
  // means the row moved out from under us, which is a 404/409, never a 500.
  const conditions: SQL[] = [eq(tenantVariables.id, id), eq(tenantVariables.version, row.version)];
  const accessCondition = tenantVariableWriteCondition(auth);
  if (accessCondition) conditions.push(accessCondition);

  const [updated] = await db
    .update(tenantVariables)
    .set(updates)
    .where(and(...conditions))
    .returning();
  if (!updated) {
    throw new TenantVariableError('This variable changed while you were editing it — reload and try again', 409);
  }
  return updated;
}

/**
 * Stored plaintext for the redaction-floor check, or `null` when it cannot be
 * read. An unreadable stored value must NOT block the edit: the variable is
 * already broken for dispatch, and refusing the update would trap the operator
 * in a state they cannot edit their way out of.
 */
function readStoredPlaintextForFloorCheck(row: TenantVariableRow): string | null {
  try {
    return decryptTenantVariableValue(row);
  } catch {
    return null;
  }
}

/** True when the incoming plaintext differs from what is stored (unreadable stored value counts as changed). */
function valueChanged(row: TenantVariableRow, nextPlaintext: string): boolean {
  try {
    return decryptTenantVariableValue(row) !== nextPlaintext;
  } catch {
    return true;
  }
}

export async function deleteTenantVariable(auth: AuthContext, id: string): Promise<TenantVariableRow> {
  const row = await getVariableForWrite(id, auth);
  if (!row) throw new TenantVariableError('Variable not found', 404);

  if (row.orgId === null && !canManagePartnerWidePolicies(auth)) {
    throw new TenantVariableError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 403);
  }

  // Same reasoning as the update: re-apply the access condition and confirm a
  // row was actually removed, so the caller is never told (and the audit log
  // never records) that something was deleted when nothing was.
  const conditions: SQL[] = [eq(tenantVariables.id, id)];
  const accessCondition = tenantVariableWriteCondition(auth);
  if (accessCondition) conditions.push(accessCondition);

  const deleted = await db.delete(tenantVariables).where(and(...conditions)).returning();
  if (deleted.length === 0) throw new TenantVariableError('Variable not found', 404);
  return deleted[0]!;
}
