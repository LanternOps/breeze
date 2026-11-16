/**
 * The SCIM bearer credential of one org (portal registration W9 #11386, plan
 * D1, D2, D11).
 *
 * Wire format: `brzscim_<32 hex row id>_<43 char base64url secret>`. The id is
 * the `portal_scim_tokens` row id (not secret) so the row is found by primary
 * key; the 256-bit secret is compared as SHA-256 digests with
 * `timingSafeEqual`. Only the digest is stored; the secret exists once, in the
 * mint response.
 *
 * A token authenticates only while (D2): the row exists and is not revoked;
 * the org's PROVEN Entra tenant equals the tenant bound at mint (removing the
 * proof suspends the token, proving another tenant ends it for this org); the
 * org and its partner are active. Every refusal is the same `null` — the SCIM
 * router answers one uniform 401.
 *
 * Contexts: every function opens its own system context and refuses a held
 * one (MSP routes call through runOutsideDbContext), so a thrown refusal never
 * poisons a request transaction.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, hasDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs, clientAiTenantMappings, portalScimTokens } from '../../db/schema';
import { markRequestAuditWritten } from '../auditRequestTracking';
import { findProvenEntraTenantForOrg } from '../portalEntraTenantProof';
import { entraIssuer } from '../portalUserIdentities';
import { getActiveOrgTenant } from '../tenantStatus';

export const SCIM_TOKEN_PREFIX = 'brzscim_';
/** Two live tokens per org: enough to rotate (mint the new, paste it, revoke the old). */
export const PORTAL_SCIM_LIVE_TOKEN_CAP = 2;
/** `last_used_at` is written at most this often per token. */
const LAST_USED_RESOLUTION_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WIRE_RE = /^brzscim_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;
/** Compared against when the id names no row, so a miss costs the same compare as a hit. */
const DUMMY_HASH = createHash('sha256').update('portal-scim-no-such-token').digest('hex');

export const AUDIT_SCIM_TOKEN_CREATE = 'organization.portal_scim_token.create';
export const AUDIT_SCIM_TOKEN_REVOKE = 'organization.portal_scim_token.revoke';

export type PortalScimTokenErrorCode =
  | 'PORTAL_SCIM_TENANT_NOT_PROVEN'
  | 'PORTAL_SCIM_TOKEN_LIMIT'
  | 'PORTAL_SCIM_TOKEN_NOT_FOUND';

/** An MSP-route refusal; the route maps `code` + `httpStatus` as is. */
export class PortalScimTokenError extends Error {
  constructor(
    readonly code: PortalScimTokenErrorCode,
    readonly httpStatus: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'PortalScimTokenError';
  }
}

/** What an authenticated SCIM request acts as. Nothing here comes from the request body. */
export interface VerifiedScimToken {
  tokenId: string;
  orgId: string;
  partnerId: string;
  /** The tenant bound at mint, lowercase. Equal to the org's proven tenant at verify time. */
  tenantId: string;
  /** `entraIssuer(tenantId)`: the only issuer SCIM ever reads or writes. */
  issuer: string;
}

export interface PortalScimTokenView {
  id: string;
  label: string;
  hint: string;
  tenantId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Not revoked and bound to the org's current proven tenant: it would authenticate now. */
  usable: boolean;
}

function assertNoHeldContext(operation: string): void {
  if (hasDbAccessContext()) {
    throw new Error(`${operation} opens its own system-scope transaction — call it through runOutsideDbContext`);
  }
}

const hyphenate = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/** `Authorization` header → the row id and the secret, or null for anything else (no DB). */
export function parseScimBearer(header: string | undefined | null): { tokenId: string; secret: string } | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const m = WIRE_RE.exec(header.slice(7));
  if (!m) return null;
  return { tokenId: hyphenate(m[1]!), secret: m[2]! };
}

export function hashScimSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function digestsEqual(secret: string, storedHash: string): boolean {
  const given = Buffer.from(hashScimSecret(secret), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The SCIM router's authentication (D1, D2). Null on ANY failure; the caller
 * answers one identical 401.
 */
export async function verifyPortalScimToken(authorization: string | undefined | null, now: Date = new Date()): Promise<VerifiedScimToken | null> {
  const out = await authenticatePortalScimToken(authorization, now);
  return out.ok ? out.token : null;
}

/**
 * {@link verifyPortalScimToken} with the one fact the router's failure budget
 * needs (D9): whether the token id named no row at all (`unknownId` — id
 * guessing, budgeted per client address) or named a real token that was
 * refused (wrong secret, revoked, proof or org changed — budgeted per token id
 * and address). The HTTP answer is the same 401 either way.
 */
export async function authenticatePortalScimToken(
  authorization: string | undefined | null,
  now: Date = new Date(),
): Promise<{ ok: true; token: VerifiedScimToken } | { ok: false; unknownId: boolean }> {
  const refused = { ok: false as const, unknownId: false };
  const parsed = parseScimBearer(authorization);
  if (!parsed) return refused;

  const [row] = await withSystemDbAccessContext(
    () => db
      .select({
        id: portalScimTokens.id,
        orgId: portalScimTokens.orgId,
        entraTenantId: portalScimTokens.entraTenantId,
        secretHash: portalScimTokens.secretHash,
        revokedAt: portalScimTokens.revokedAt,
        lastUsedAt: portalScimTokens.lastUsedAt,
      })
      .from(portalScimTokens)
      .where(eq(portalScimTokens.id, parsed.tokenId))
      .limit(1),
    'portalScim.verifyToken',
  );
  // One compare whether or not the row exists.
  const matches = digestsEqual(parsed.secret, row?.secretHash ?? DUMMY_HASH);
  if (!row) return { ok: false, unknownId: true };
  if (!matches || row.revokedAt) return refused;

  const tenantId = row.entraTenantId.toLowerCase();
  const proven = await findProvenEntraTenantForOrg(row.orgId);
  if (!proven || proven.tenantId.toLowerCase() !== tenantId) return refused;
  const active = await getActiveOrgTenant(row.orgId);
  if (!active) return refused;

  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await withSystemDbAccessContext(
      () => db.update(portalScimTokens).set({ lastUsedAt: now }).where(eq(portalScimTokens.id, row.id)),
      'portalScim.touchToken',
    );
  }
  return { ok: true, token: { tokenId: row.id, orgId: row.orgId, partnerId: active.partnerId, tenantId, issuer: entraIssuer(tenantId) } };
}

/**
 * Inside a SCIM mutation's transaction, after its row locks (D2): the token is
 * still live and the org's proven tenant is still the token's, both held
 * `FOR SHARE` to commit — a revoke or a proof change waits for this write, or
 * committed first and this returns false.
 */
export async function lockLiveScimToken(token: VerifiedScimToken): Promise<boolean> {
  const [live] = await db
    .select({ id: portalScimTokens.id })
    .from(portalScimTokens)
    .where(and(
      eq(portalScimTokens.id, token.tokenId),
      eq(portalScimTokens.orgId, token.orgId),
      isNull(portalScimTokens.revokedAt),
    ))
    .for('share')
    .limit(1);
  if (!live) return false;
  // The W4 lockProvenEntraTenant pattern (services/portalAccessRequests.ts).
  const [mapping] = await db
    .select({ tenantId: clientAiTenantMappings.entraTenantId })
    .from(clientAiTenantMappings)
    .where(and(eq(clientAiTenantMappings.orgId, token.orgId), isNotNull(clientAiTenantMappings.provenAt)))
    .for('share')
    .limit(1);
  return Boolean(mapping) && mapping!.tenantId.toLowerCase() === token.tenantId;
}

function toView(row: {
  id: string; label: string; secretHint: string; entraTenantId: string;
  createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null;
}, provenTenant: string | null): PortalScimTokenView {
  const tenantId = row.entraTenantId.toLowerCase();
  return {
    id: row.id,
    label: row.label,
    hint: row.secretHint,
    tenantId,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    usable: !row.revokedAt && provenTenant !== null && provenTenant === tenantId,
  };
}

export interface MintPortalScimTokenInput {
  orgId: string;
  label: string;
  actorUserId: string;
  now?: Date;
}

/**
 * Mint a token (D1): under the per-org advisory lock, refuse an org with no
 * proven tenant or with {@link PORTAL_SCIM_LIVE_TOKEN_CAP} live tokens, then
 * store the digest and audit. The returned `token` is the only copy of the
 * secret.
 */
export async function mintPortalScimToken(input: MintPortalScimTokenInput): Promise<{ token: string; view: PortalScimTokenView }> {
  assertNoHeldContext('mintPortalScimToken');
  const now = input.now ?? new Date();
  const label = input.label.trim();

  const result = await withSystemDbAccessContext(async () => {
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`portal-scim-tokens:${input.orgId}`}))`);
    const proven = await findProvenEntraTenantForOrg(input.orgId);
    if (!proven) {
      throw new PortalScimTokenError(
        'PORTAL_SCIM_TENANT_NOT_PROVEN',
        409,
        'Prove this organization\'s Microsoft Entra tenant before creating a provisioning token.',
      );
    }
    const [live] = await db
      .select({ n: count() })
      .from(portalScimTokens)
      .where(and(eq(portalScimTokens.orgId, input.orgId), isNull(portalScimTokens.revokedAt)));
    if (Number(live?.n ?? 0) >= PORTAL_SCIM_LIVE_TOKEN_CAP) {
      throw new PortalScimTokenError(
        'PORTAL_SCIM_TOKEN_LIMIT',
        409,
        `This organization already has ${PORTAL_SCIM_LIVE_TOKEN_CAP} active provisioning tokens. Revoke one first.`,
      );
    }

    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const tenantId = proven.tenantId.toLowerCase();
    const row = {
      id,
      orgId: input.orgId,
      entraTenantId: tenantId,
      label,
      secretHash: hashScimSecret(secret),
      secretHint: secret.slice(-4),
      createdByUserId: input.actorUserId,
      createdAt: now,
    };
    await db.insert(portalScimTokens).values(row);
    await db.insert(auditLogs).values({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.actorUserId,
      action: AUDIT_SCIM_TOKEN_CREATE,
      resourceType: 'portal_scim_token',
      resourceId: id,
      resourceName: label,
      details: { tenantId },
      result: 'success',
    });
    return {
      token: `${SCIM_TOKEN_PREFIX}${id.replace(/-/g, '')}_${secret}`,
      view: toView({ ...row, lastUsedAt: null, revokedAt: null }, tenantId),
    };
  }, 'portalScim.mintToken');

  markRequestAuditWritten();
  return result;
}

/** Revoke one token of the org (D11), idempotently. Another org's token, or none: NOT_FOUND. */
export async function revokePortalScimToken(input: { orgId: string; tokenId: string; actorUserId: string; now?: Date }): Promise<void> {
  assertNoHeldContext('revokePortalScimToken');
  const notFound = () => new PortalScimTokenError('PORTAL_SCIM_TOKEN_NOT_FOUND', 404, 'Provisioning token not found.');
  if (!UUID_RE.test(input.tokenId) || !UUID_RE.test(input.orgId)) throw notFound();
  const now = input.now ?? new Date();

  const wrote = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ id: portalScimTokens.id, revokedAt: portalScimTokens.revokedAt })
      .from(portalScimTokens)
      .where(and(eq(portalScimTokens.id, input.tokenId), eq(portalScimTokens.orgId, input.orgId)))
      .for('update')
      .limit(1);
    if (!row) throw notFound();
    if (row.revokedAt) return false;
    await db
      .update(portalScimTokens)
      .set({ revokedAt: now, revokedByUserId: input.actorUserId })
      .where(and(eq(portalScimTokens.id, input.tokenId), eq(portalScimTokens.orgId, input.orgId)));
    await db.insert(auditLogs).values({
      orgId: input.orgId,
      actorType: 'user',
      actorId: input.actorUserId,
      action: AUDIT_SCIM_TOKEN_REVOKE,
      resourceType: 'portal_scim_token',
      resourceId: input.tokenId,
      details: {},
      result: 'success',
    });
    return true;
  }, 'portalScim.revokeToken');
  if (wrote) markRequestAuditWritten();
}

/** The org's tokens, newest first, without secret material. */
export async function listPortalScimTokens(orgId: string): Promise<PortalScimTokenView[]> {
  assertNoHeldContext('listPortalScimTokens');
  if (!UUID_RE.test(orgId)) return [];
  const rows = await withSystemDbAccessContext(
    () => db
      .select({
        id: portalScimTokens.id,
        label: portalScimTokens.label,
        secretHint: portalScimTokens.secretHint,
        entraTenantId: portalScimTokens.entraTenantId,
        createdAt: portalScimTokens.createdAt,
        lastUsedAt: portalScimTokens.lastUsedAt,
        revokedAt: portalScimTokens.revokedAt,
      })
      .from(portalScimTokens)
      .where(eq(portalScimTokens.orgId, orgId))
      .orderBy(desc(portalScimTokens.createdAt)),
    'portalScim.listTokens',
  );
  const proven = await findProvenEntraTenantForOrg(orgId);
  const provenTenant = proven ? proven.tenantId.toLowerCase() : null;
  return rows.map((row) => toView(row, provenTenant));
}
