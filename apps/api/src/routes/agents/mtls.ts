import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, desc, eq, or } from 'drizzle-orm';
import { createHash } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import { db, withSystemDbAccessContext } from '../../db';
import { isAgentTenantActive } from '../../services/tenantStatus';
import { devices, organizations, deviceMtlsCertificates } from '../../db/schema';
import { authMiddleware, requireMfa, requirePermission } from '../../middleware/auth';
import { matchAgentTokenHash } from '../../middleware/agentAuth';
import { writeAuditEvent } from '../../services/auditEvents';
import {
  CloudflareMtlsError,
  CloudflareMtlsService,
  categorizeCloudflareMtlsError,
  parseIssuedLeafCertificate,
  type CfCertResult,
  type ParsedIssuedCertificate,
} from '../../services/cloudflareMtls';
import { orgMtlsSettingsSchema, orgHelperSettingsSchema, orgLogForwardingSettingsSchema } from '@breeze/shared';
import { getOrgHelperSettings, issueMtlsCertForDevice, isObject } from './helpers';
import { disconnectAgent } from '../agentWs';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { encryptSecret } from '../../services/secretCrypto';
import { isPrivateIp } from '../../services/urlSafety';
import { terminateDeviceRemoteSessions, TEARDOWN_FAILED } from '../../services/remoteSessionTeardown';
import {
  getAgentMtlsBindingMode,
  normalizeCertificateSerial,
  readAgentCertificateAssertion,
  type AgentMtlsBindingMode,
} from '../../services/agentCertificateBinding';
import { issueRenewalChallenge, verifyAndConsumeRenewalProof } from '../../services/mtlsRenewalProof';
import {
  queueCertificateRevocationCore,
  revokeCertificateNowOrEnqueue,
} from '../../services/deviceMtlsCertificateLifecycle';

export const mtlsRoutes = new Hono();

const deviceIdParamSchema = z.object({ id: z.string().guid() });
const orgIdParamSchema = z.object({ orgId: z.string().guid() });

// E4: per-device renewal cooldowns (Redis sliding window).
// Short-term: 1 attempt / 30s — prevents agent-restart hammering.
// Long-term:  1 success / 1h — caps Cloudflare issuance even if a token leaks.
const MTLS_RENEW_ATTEMPT_LIMIT = 1;
const MTLS_RENEW_ATTEMPT_WINDOW_SECONDS = 30;
const MTLS_RENEW_SUCCESS_LIMIT = 1;
const MTLS_RENEW_SUCCESS_WINDOW_SECONDS = 3600;
const LOG_FORWARDING_MASK = '****';

// Wave 5 Task 4: proof-of-possession + two-phase renewal.
//
// Challenge issuance gets its own (more generous) per-device window —
// unlike /renew-cert, issuing a challenge never touches Cloudflare or the DB
// write path, but it's still an agent-authenticated endpoint that should not
// be hammered.
const MTLS_CHALLENGE_LIMIT = 5;
const MTLS_CHALLENGE_WINDOW_SECONDS = 300;

// Fix round 2 (code review, deferred minor (b)): /renew-cert/confirm gets
// its own per-device window, the same pattern as /renew-cert/challenge —
// confirm is expected once per successful issuance, but an agent may
// legitimately retry a few times across a network blip within the 15-minute
// activation window.
const MTLS_CONFIRM_LIMIT = 5;
const MTLS_CONFIRM_WINDOW_SECONDS = 300;

// Protocol v2 pending-activation window: the agent must persist the pending
// certificate and confirm it (see /renew-cert/confirm) within this window.
// The 5-minute sweep (jobs/mtlsCertificateRevocation.ts, Task 3) revokes any
// pending row whose activation_expires_at has passed and was never confirmed.
const PENDING_ACTIVATION_TTL_MS = 15 * 60 * 1000;

const recoveryProofSchema = z.object({
  challengeId: z.string().min(1),
  expiresUnix: z.number().int().positive(),
  signatureBase64: z.string().min(1),
});

const capableRenewRequestSchema = z.object({
  protocolVersion: z.literal(2),
  recoveryProof: recoveryProofSchema.optional(),
});

const confirmRenewRequestSchema = z.object({
  protocolVersion: z.literal(2),
  certificateId: z.string().guid(),
});

type CapableRenewRequest = z.infer<typeof capableRenewRequestSchema>;

type MtlsBindingMode = AgentMtlsBindingMode;

interface ClientCertAssertion {
  /** True only when a verified, trusted-source assertion carried a serial. */
  verified: boolean;
  /** Uppercase hex, no separators. Null unless `verified` is true. */
  serial: string | null;
}

/**
 * Reads the edge-set certificate assertion headers via the centralized
 * reader (services/agentCertificateBinding.ts) and collapses it to the
 * trust-gated `{ verified, serial }` shape `evaluateRenewalAuthorization`
 * below expects — its proof-based renewal semantics are deliberately NOT
 * absorbed into the shared checkAgentCertificateBinding decision (Task 6),
 * so this adapter is the seam between the two. Trust-gating (only honoring
 * the headers when `trustsForwardedHeadersFrom(c)` is true) happens inside
 * `readAgentCertificateAssertion`.
 */
function readClientCertAssertion(c: Context): ClientCertAssertion {
  const assertion = readAgentCertificateAssertion(c);
  const verified = assertion.assertionTrusted && assertion.assertedVerified;
  return { verified, serial: verified ? assertion.assertedSerial : null };
}

function toOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

async function validateLogForwardingTarget(rawUrl: string | undefined): Promise<string[]> {
  if (!rawUrl) return [];

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return ['Invalid Elasticsearch URL format'];
  }

  if (parsed.protocol !== 'https:') {
    return ['Elasticsearch URL must use HTTPS'];
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) {
    return ['Elasticsearch URL hostname is required'];
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    return ['Elasticsearch URL cannot target localhost or local network hostnames'];
  }

  const ipVersion = isIP(hostname);
  if (ipVersion !== 0) {
    return isPrivateIp(hostname)
      ? ['Elasticsearch URL cannot target private, loopback, link-local, or reserved addresses']
      : [];
  }

  try {
    const resolved = await dnsLookup(hostname, { all: true, verbatim: true });
    if (resolved.length === 0) {
      return ['Elasticsearch URL hostname could not be resolved'];
    }
    const blockedTargets = resolved
      .map((entry) => entry.address)
      .filter((address) => isPrivateIp(address));
    if (blockedTargets.length > 0) {
      return [`Elasticsearch URL resolves to blocked address space: ${blockedTargets.join(', ')}`];
    }
  } catch {
    return ['Elasticsearch URL hostname could not be resolved'];
  }

  return [];
}

function resolveSecretForStorage(incoming: unknown, existing: unknown): string | undefined {
  if (typeof incoming !== 'string') return undefined;
  const trimmed = incoming.trim();
  if (!trimmed) return undefined;
  if (trimmed === LOG_FORWARDING_MASK) return encryptSecret(toOptionalString(existing)) ?? undefined;
  return encryptSecret(trimmed) ?? undefined;
}

type OrgMtlsPolicy = { certLifetimeDays: number; expiredCertPolicy: 'auto_reissue' | 'quarantine' };

/**
 * Read the org's mTLS policy for the /renew-cert agent path.
 *
 * SECURITY (fail-closed): this route hand-rolls bearer auth and skips
 * agentAuthMiddleware (see AGENT_AUTH_SKIP_ID_SEGMENTS), so it carries NO
 * ambient request DB context. Under FORCE RLS the bare `breeze_app` pool would
 * return 0 rows for a contextless read — silently collapsing an org configured
 * `quarantine` into the `auto_reissue` default and handing a fresh cert+key to
 * a possibly-compromised agent. We therefore read INSIDE
 * `withSystemDbAccessContext` (mirroring the device lookup above) so RLS
 * returns the real row and the true policy is honored.
 *
 * Returns `null` when the org row is genuinely absent. Callers MUST treat null
 * as the most-restrictive path (error / deny) — never fall back to
 * `auto_reissue` on a missing row. (An org that simply has no mTLS settings
 * still yields a row and its real default policy; only a truly missing org row
 * returns null.) The parse mirrors helpers.ts `getOrgMtlsSettings`, inlined
 * here so we can distinguish "no org row" from "org with default settings",
 * which that helper cannot.
 */
async function readOrgMtlsPolicyOrNull(orgId: string): Promise<OrgMtlsPolicy | null> {
  return withSystemDbAccessContext(async () => {
    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);
    if (!org) return null;
    const settings = isObject(org.settings) ? org.settings : {};
    const mtls = isObject(settings.mtls) ? settings.mtls : {};
    const certLifetimeDays =
      typeof mtls.certLifetimeDays === 'number' && mtls.certLifetimeDays >= 1 && mtls.certLifetimeDays <= 365
        ? Math.round(mtls.certLifetimeDays)
        : 90;
    const expiredCertPolicy = mtls.expiredCertPolicy === 'quarantine' ? 'quarantine' : 'auto_reissue';
    return { certLifetimeDays, expiredCertPolicy };
  });
}

// ============================================
// mTLS Certificate Renewal
// ============================================

interface AuthenticatedMtlsDevice {
  id: string;
  orgId: string;
  agentId: string;
  hostname: string;
  status: string;
  mtlsCertExpiresAt: Date | null;
  mtlsCertCfId: string | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    mtlsAgentDevice: AuthenticatedMtlsDevice;
  }
}

/**
 * Shared bearer-auth + device-status gate for every hand-rolled-auth mTLS
 * agent route (/renew-cert, /renew-cert/challenge, /renew-cert/confirm).
 * Extracted from the original /renew-cert handler so all three routes apply
 * the EXACT same token/rotation/suspension/lifecycle checks. Returns either
 * the authenticated device row or a ready-to-return `Response` — callers
 * short-circuit on the latter.
 */
async function authenticateAgentBearer(
  c: Context,
): Promise<{ device: AuthenticatedMtlsDevice } | { response: Response }> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { response: c.json({ error: 'Missing or invalid Authorization header' }, 401) };
  }

  const token = authHeader.slice(7);
  if (!token.startsWith('brz_')) {
    return { response: c.json({ error: 'Invalid agent token format' }, 401) };
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  const device = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        agentId: devices.agentId,
        hostname: devices.hostname,
        status: devices.status,
        agentTokenHash: devices.agentTokenHash,
        previousTokenHash: devices.previousTokenHash,
        previousTokenExpiresAt: devices.previousTokenExpiresAt,
        agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
        mtlsCertExpiresAt: devices.mtlsCertExpiresAt,
        mtlsCertCfId: devices.mtlsCertCfId,
      })
      .from(devices)
      .where(or(eq(devices.agentTokenHash, tokenHash), eq(devices.previousTokenHash, tokenHash)))
      .limit(1);
    return row ?? null;
  });

  // Issue #2621 — deliberately NOT passing pendingTokenHash here. Staged
  // credentials from an unconfirmed rotation authenticate for ordinary agent
  // traffic, but this route mints fresh cert material and stays fail-closed on
  // the CURRENT token only (same rationale as the superseded-token rejection
  // below). A legitimate agent confirms its rotation on the next request and
  // renews immediately after; the pending set is never the long-term identity.
  const match = device
    ? matchAgentTokenHash({
        agentTokenHash: device.agentTokenHash,
        previousTokenHash: device.previousTokenHash,
        previousTokenExpiresAt: device.previousTokenExpiresAt,
        tokenHash,
      })
    : null;

  if (!device || !match) {
    return { response: c.json({ error: 'Invalid agent credentials' }, 401) };
  }

  // FINDING #2 (fail-closed): only the CURRENT token may mint new cert material.
  // `matchAgentTokenHash` accepts the PREVIOUS (superseded) token within its
  // rotation grace window — that's correct for idempotent agent traffic
  // (heartbeats/results) but NOT for this cert-issuing route: a stolen,
  // already-rotated token must not be able to obtain a fresh certificate +
  // private key. When the previous hash matched, `match.tokenRotationRequired`
  // is true; reject here (ONLY on this route — the general agent auth path
  // keeps accepting the previous token for grace). The message tells a
  // legitimate agent to finish rotating before renewing.
  if (match.tokenRotationRequired) {
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'previous_token_rejected' },
    });
    return {
      response: c.json(
        { error: 'Rotate to the current agent token before renewing the certificate' },
        401
      ),
    };
  }

  // Task 18: auto-suspended tokens fail closed at every auth gate. The
  // suspended-reason is intentionally not surfaced to the caller.
  if (device.agentTokenSuspendedAt) {
    return { response: c.json({ error: 'Invalid agent credentials' }, 401) };
  }

  if (device.status === 'decommissioned') {
    return { response: c.json({ error: 'Device has been decommissioned' }, 403) };
  }

  if (device.status === 'quarantined') {
    return { response: c.json({ error: 'Device quarantined', quarantined: true }, 403) };
  }

  return { device };
}

/** Hono middleware wrapper around {@link authenticateAgentBearer}. */
async function agentBearerAuthMiddleware(c: Context, next: () => Promise<void>) {
  const result = await authenticateAgentBearer(c);
  if ('response' in result) return result.response;
  c.set('mtlsAgentDevice', result.device);
  await next();
}

interface ActiveCertificateRow {
  id: string;
  /**
   * CANONICAL serial (uppercase hex, no separators) — already passed through
   * `normalizeCertificateSerial` at the read boundary below. Null when the
   * stored value normalizes to nothing. NEVER compare a raw stored serial
   * against an asserted one; see the read boundary's comment.
   */
  serialNumber: string | null;
  expiresAt: Date;
  publicKeySpki: string | null;
}

/**
 * Reads the device's current `active` device_mtls_certificates row, if any.
 *
 * FINAL-REVIEW I3: the serial is normalized HERE, at the read boundary, with
 * the same shared helper `services/agentCertificateBinding.ts` uses on both
 * the header side (`readAgentCertificateAssertion`) and its own stored side
 * (`loadAgentCertificateBindingIdentity`). Before this fix the three serial
 * comparisons in this file compared a RAW stored value against a normalized
 * asserted one, so any row whose serial isn't already canonical — Task 1's
 * migration import of historical `devices.mtls_cert_serial_number` values,
 * and every row written by the legacy renewal path before Task 6's fix —
 * could never match and renewal 401'd permanently. Worse, the mismatch branch
 * in `evaluateRenewalAuthorization` fires BEFORE its `mode === 'off'` return,
 * so those devices were bricked for renewal even with binding mode off, as
 * soon as Cloudflare started asserting.
 *
 * Known reconciliation limitation: Node's `X509Certificate.serialNumber`
 * renders the DER INTEGER without a leading zero byte, while some providers
 * render the same serial as `00AB...`. Stripping non-hex characters and
 * uppercasing (what `normalizeCertificateSerial` does) does NOT reconcile
 * that difference — `00AB` and `AB` remain distinct. Every serial Breeze
 * stores comes from `parseIssuedLeafCertificate` (i.e. from
 * `X509Certificate.serialNumber`) or from a Cloudflare `serial_number` field
 * normalized on write, and the edge asserts the same certificate's serial, so
 * the two sides agree in practice; a provider that starts emitting a
 * zero-padded form would need an explicit leading-zero-trim added here rather
 * than a wider normalization.
 */
async function fetchActiveCertificateRow(deviceId: string): Promise<ActiveCertificateRow | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        id: deviceMtlsCertificates.id,
        serialNumber: deviceMtlsCertificates.serialNumber,
        expiresAt: deviceMtlsCertificates.expiresAt,
        publicKeySpki: deviceMtlsCertificates.publicKeySpki,
      })
      .from(deviceMtlsCertificates)
      .where(and(eq(deviceMtlsCertificates.deviceId, deviceId), eq(deviceMtlsCertificates.state, 'active')))
      .limit(1);
    if (!row) return null;
    return { ...row, serialNumber: normalizeCertificateSerial(row.serialNumber) };
  });
}

type RenewalAuthOutcome =
  | { allowed: true; auditReason?: string }
  | { allowed: false; reason: string; message?: string; status?: number };

/**
 * The mode-gated renewal-authorization decision for /renew-cert, per the
 * Wave 5 Task 4 brief:
 *
 *  - a SUPPLIED recovery proof (or a supplied-but-mismatched cert assertion)
 *    must be valid — a replay, wrong device/key, expiry mismatch, tampered
 *    bytes, or serial mismatch fails closed in EVERY mode, independent of
 *    the mode gate below;
 *  - `off`: otherwise always allowed (legacy bearer-only compatibility);
 *  - `audit`: otherwise always allowed, but tags a bounded observation
 *    reason (`renewal_binding_missing` / `renewal_proof_missing`) for the
 *    caller to audit-log — never denies on the observation alone;
 *  - `enforce`: an unexpired active certificate requires a matching
 *    assertion; an expired (or missing) one requires a valid recovery proof
 *    — and a legacy-imported row with no recorded SPKI can never satisfy
 *    that, so it's denied with a message pointing at administrator-
 *    authorized re-enrollment rather than an unusable "get a proof" prompt.
 */
async function evaluateRenewalAuthorization(input: {
  mode: MtlsBindingMode;
  activeCertRow: ActiveCertificateRow | null;
  assertion: ClientCertAssertion;
  recoveryProof: CapableRenewRequest['recoveryProof'];
  deviceId: string;
}): Promise<RenewalAuthOutcome> {
  const { mode, activeCertRow, assertion, recoveryProof, deviceId } = input;

  if (recoveryProof) {
    const result = await verifyAndConsumeRenewalProof(deviceId, recoveryProof);
    if (!result.ok) {
      return {
        allowed: false,
        reason: `renewal_proof_invalid:${result.reason}`,
        message: 'Invalid or expired recovery proof',
        status: 401,
      };
    }
    return { allowed: true };
  }

  if (assertion.verified && activeCertRow && assertion.serial !== activeCertRow.serialNumber) {
    // A trusted, verified assertion that names a DIFFERENT certificate than
    // the device's active one is a fail-closed signal in every mode — never
    // treated the same as "no assertion supplied".
    //
    // I3: both sides are canonical here. `assertion.serial` was normalized by
    // `readAgentCertificateAssertion`, `activeCertRow.serialNumber` by
    // `fetchActiveCertificateRow`'s read boundary. Because this branch runs
    // BEFORE the `mode === 'off'` return below — deliberately, so a spoof
    // signal is never ignored — comparing a raw stored serial here previously
    // bricked renewal for legacy-imported devices in EVERY mode, `off`
    // included.
    return {
      allowed: false,
      reason: 'renewal_assertion_mismatch',
      message: "Certificate assertion does not match the device's active certificate",
      status: 401,
    };
  }

  if (mode === 'off') {
    return { allowed: true };
  }

  const isExpired = !activeCertRow || activeCertRow.expiresAt.getTime() < Date.now();

  if (!isExpired) {
    // I3: canonical-vs-canonical (see fetchActiveCertificateRow). A raw
    // stored serial here meant an enforce-mode agent presenting the CORRECT
    // certificate was still denied renewal.
    if (assertion.verified && activeCertRow && assertion.serial === activeCertRow.serialNumber) {
      return { allowed: true };
    }
    if (mode === 'enforce') {
      return {
        allowed: false,
        reason: 'renewal_binding_missing',
        message: 'Certificate renewal requires a matching client certificate assertion',
        status: 401,
      };
    }
    return { allowed: true, auditReason: 'renewal_binding_missing' };
  }

  // Expired (or missing) active row and no recovery proof was supplied.
  if (mode === 'enforce') {
    if (!activeCertRow || !activeCertRow.publicKeySpki) {
      return {
        allowed: false,
        reason: 'renewal_proof_missing',
        message:
          'Expired certificate has no recorded public key on file; administrator-authorized re-enrollment is required',
        status: 403,
      };
    }
    return {
      allowed: false,
      reason: 'renewal_proof_missing',
      message: 'Certificate renewal requires a valid recovery proof',
      status: 401,
    };
  }

  return { allowed: true, auditReason: 'renewal_proof_missing' };
}

/**
 * Tolerantly parses an optional JSON body for /renew-cert: legacy agents send
 * NO body at all (must remain byte-compatible), so an empty/absent/malformed
 * body is treated as "legacy request", never a 400. A body that DOES declare
 * `protocolVersion: 2` but fails schema validation is the only case that
 * yields an explicit 400 — that's a capable agent sending a malformed
 * request, not a legacy one.
 */
async function parseOptionalCapableRenewBody(
  c: Context,
): Promise<{ ok: true; data: CapableRenewRequest | null } | { ok: false }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: true, data: null };
  }

  if (!isObject(raw) || (raw as Record<string, unknown>).protocolVersion !== 2) {
    return { ok: true, data: null };
  }

  const result = capableRenewRequestSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false };
  }
  return { ok: true, data: result.data };
}

/**
 * Fix round 1 (code review, Important #1): inserts a minimal
 * `device_mtls_certificates` marker row for an orphan provider certificate
 * — one that was issued but never became the device's persisted
 * certificate (a failed pending-row insert on the v2 path, or a failed
 * activation transaction on the legacy path) — in state `pending_revocation`
 * with `next_revoke_attempt_at = now()` so it's immediately due. This is
 * ONLY possible when the leaf was parsed successfully (both callers here
 * have `parsedCert`), since `fingerprint_sha256` is NOT NULL for
 * `legacy_provenance = false` rows via the fingerprint check constraint.
 *
 * Never `active` (so the one-active-per-device partial unique index is
 * never at risk) and uses the device's real `orgId`/`id` (so the composite
 * `(device_id, org_id) -> devices(id, org_id)` FK is always satisfied).
 *
 * Returns the new row's id, or `null` if the insert itself failed (in which
 * case the caller falls back to an inline best-effort provider revoke).
 */
async function insertOrphanRevocationMarkerRow(
  device: AuthenticatedMtlsDevice,
  cert: CfCertResult,
  parsedCert: ParsedIssuedCertificate,
): Promise<string | null> {
  const now = new Date();
  try {
    return await withSystemDbAccessContext(async () => {
      const [inserted] = await db
        .insert(deviceMtlsCertificates)
        .values({
          orgId: device.orgId,
          deviceId: device.id,
          providerCertificateId: cert.id,
          serialNumber: parsedCert.serialNumber,
          fingerprintSha256: parsedCert.fingerprintSha256,
          publicKeySpki: parsedCert.publicKeySpkiBase64,
          legacyProvenance: false,
          state: 'pending_revocation',
          issuedAt: new Date(cert.issuedOn),
          expiresAt: new Date(cert.expiresOn),
          nextRevokeAttemptAt: now,
        })
        .returning({ id: deviceMtlsCertificates.id });
      return inserted?.id ?? null;
    });
  } catch (err) {
    console.error(
      '[agents] mTLS renew: failed to insert durable orphan-revoke marker row:',
      err instanceof Error ? err.name : 'unknown',
    );
    return null;
  }
}

/**
 * Revokes an orphan provider certificate through Task 3's durable lifecycle
 * machinery (`revokeCertificateNowOrEnqueue`) by first minting the marker
 * row above, so a provider 5xx/timeout at revoke time is retried by the
 * 5-minute sweep instead of being permanently unrevoked and untracked.
 * Falls back to a single inline best-effort revoke ONLY if the marker-row
 * insert itself fails (defensive fallback-of-a-fallback — logged distinctly
 * from the accepted cert-parse-failure exception, since this case is an
 * unexpected SECOND failure on top of an already-failing path).
 */
async function revokeOrphanCertificateDurably(
  device: AuthenticatedMtlsDevice,
  cert: CfCertResult,
  parsedCert: ParsedIssuedCertificate,
  cfService: CloudflareMtlsService,
): Promise<void> {
  const markerRowId = await insertOrphanRevocationMarkerRow(device, cert, parsedCert);
  if (markerRowId) {
    await revokeCertificateNowOrEnqueue(markerRowId);
    return;
  }

  console.error(
    '[agents] mTLS renew: durable orphan-revoke marker row unavailable, falling back to inline best-effort revoke:',
    device.id,
  );
  try {
    await cfService.revokeCertificate(cert.id);
  } catch (revokeErr) {
    console.error('[agents] failed to revoke orphan mTLS cert via inline fallback:', String(revokeErr));
  }
}

mtlsRoutes.post('/renew-cert/challenge', agentBearerAuthMiddleware, async (c) => {
  const device = c.get('mtlsAgentDevice') as AuthenticatedMtlsDevice;

  const redis = getRedis();
  const challengeRate = await rateLimiter(
    redis,
    `mtls:renew:challenge:${device.id}`,
    MTLS_CHALLENGE_LIMIT,
    MTLS_CHALLENGE_WINDOW_SECONDS,
  );
  if (!challengeRate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((challengeRate.resetAt.getTime() - Date.now()) / 1000));
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'Renewal challenge rate limited; retry later' }, 429);
  }

  if (!(await isAgentTenantActive(device.orgId))) {
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  const activeCert = await fetchActiveCertificateRow(device.id);
  const isExpired = activeCert && activeCert.expiresAt.getTime() < Date.now();
  if (!activeCert || !activeCert.publicKeySpki || !isExpired) {
    // Deliberately the same response whether the active row is missing, has
    // no recorded SPKI (a legacy-imported certificate — see Task 1's
    // migration — can never support recovery), or simply isn't expired yet:
    // none of these states can produce a usable challenge.
    return c.json({ error: 'Recovery challenge unavailable' }, 400);
  }

  const challenge = await issueRenewalChallenge(device.id, activeCert.publicKeySpki);
  if (!challenge) {
    return c.json({ error: 'Recovery challenge unavailable' }, 500);
  }

  return c.json(challenge);
});

mtlsRoutes.post('/renew-cert', agentBearerAuthMiddleware, async (c) => {
  const device = c.get('mtlsAgentDevice') as AuthenticatedMtlsDevice;

  const bodyResult = await parseOptionalCapableRenewBody(c);
  if (!bodyResult.ok) {
    return c.json({ error: 'Invalid renewal request' }, 400);
  }
  const capableRequest = bodyResult.data;

  // E4: per-device renewal cooldowns (defense against leaked tokens spamming
  // Cloudflare issuance). Two layers via the existing sliding-window helper.
  const redis = getRedis();
  const attemptResult = await rateLimiter(
    redis,
    `mtls:renew:attempt:${device.id}`,
    MTLS_RENEW_ATTEMPT_LIMIT,
    MTLS_RENEW_ATTEMPT_WINDOW_SECONDS
  );
  if (!attemptResult.allowed) {
    const retryAfter = Math.max(1, Math.ceil((attemptResult.resetAt.getTime() - Date.now()) / 1000));
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'attempt_rate_limited', retryAfter },
    });
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'Renewal attempt rate limited; retry later' }, 429);
  }

  // Long-term cap: peek at the success window without consuming a slot
  // (cost=0 would still record — instead, do a read-only zcard check).
  if (redis) {
    try {
      const successKey = `mtls:renew:success:${device.id}`;
      const cutoff = Date.now() - MTLS_RENEW_SUCCESS_WINDOW_SECONDS * 1000;
      await redis.zremrangebyscore(successKey, '-inf', cutoff);
      const recentSuccessCount = await redis.zcard(successKey);
      if (recentSuccessCount >= MTLS_RENEW_SUCCESS_LIMIT) {
        const oldest = await redis.zrange(successKey, 0, 0, 'WITHSCORES');
        const oldestScore = Array.isArray(oldest) && oldest.length >= 2 ? Number(oldest[1]) : Date.now();
        const retryAfter = Math.max(
          1,
          Math.ceil((oldestScore + MTLS_RENEW_SUCCESS_WINDOW_SECONDS * 1000 - Date.now()) / 1000)
        );
        writeAuditEvent(c, {
          orgId: device.orgId,
          actorType: 'agent',
          actorId: device.agentId,
          action: 'agent.mtls.renew.denied',
          resourceType: 'device',
          resourceId: device.id,
          result: 'denied',
          details: { reason: 'success_rate_limited', retryAfter },
        });
        c.header('Retry-After', String(retryAfter));
        return c.json({ error: 'Renewal success rate limited; retry later' }, 429);
      }
    } catch (err) {
      // Soft-fail on redis errors here — the attempt limiter (above) already
      // failed-closed if redis is fully unavailable; if zcard fails we proceed.
      console.warn('[agents] mTLS success-window check failed:', String(err));
    }
  }

  // Tenant-status gate (F4): this route authenticates the device token by hand
  // and never passes through agentAuthMiddleware, so it missed the org/partner
  // lifecycle check the rest of the agent surface enforces. A device whose
  // tenant is suspended/churned/soft-deleted — but whose token was not
  // individually suspended — could otherwise keep minting fresh Cloudflare mTLS
  // cert + private-key material. Mirror the agentAuth gate: run it after the
  // per-device rate limiters (so an inactive tenant can't drive uncached
  // lookups) and before any Cloudflare issuance, and return the same opaque 401
  // as a stale token so suspension is not distinguishable from a bad credential.
  if (!(await isAgentTenantActive(device.orgId))) {
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'tenant_inactive' },
    });
    return c.json({ error: 'Invalid agent credentials' }, 401);
  }

  const cfService = CloudflareMtlsService.fromEnv();
  if (!cfService) {
    return c.json({ error: 'mTLS not configured' }, 400);
  }

  // FINDING #1 (fail-closed): read the org mTLS policy INSIDE a system DB
  // context. A contextless read here returns 0 rows under FORCE RLS, which
  // would silently downgrade a `quarantine` org to the `auto_reissue` default.
  // A genuinely missing org row (null) is treated as an error — never
  // auto_reissue — so we deny rather than issue a cert against an org we can't
  // resolve a policy for.
  const mtlsSettings = await readOrgMtlsPolicyOrNull(device.orgId);
  if (!mtlsSettings) {
    console.error('[agents] mTLS renew: org policy row not found, failing closed:', device.orgId);
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'org_policy_unavailable' },
    });
    return c.json({ error: 'Certificate renewal unavailable' }, 500);
  }

  const certExpired = device.mtlsCertExpiresAt && device.mtlsCertExpiresAt.getTime() < Date.now();

  if (certExpired && mtlsSettings.expiredCertPolicy === 'quarantine') {
    // FINDING #1: the quarantine write must run in a system DB context and
    // actually affect a row. A contextless / 0-row write under FORCE RLS would
    // "succeed" while leaving the device un-quarantined. Require exactly 1 row;
    // if none, fail closed (500) rather than tearing down / returning as if the
    // device were isolated.
    const quarantined = await withSystemDbAccessContext(async () =>
      db
        .update(devices)
        .set({
          status: 'quarantined',
          quarantinedAt: new Date(),
          quarantinedReason: 'mtls_cert_expired',
          updatedAt: new Date(),
        })
        .where(eq(devices.id, device.id))
        .returning({ id: devices.id })
    );

    if (quarantined.length !== 1) {
      console.error('[agents] mTLS quarantine write affected 0 rows, failing closed:', device.id);
      return c.json({ error: 'Certificate renewal failed' }, 500);
    }

    // Cut any live remote-control session to this device. Flipping `status`
    // alone is only checked at connect time, so an in-flight desktop/terminal
    // session would otherwise keep running against a device we just isolated as
    // compromised. Never throws; a TEARDOWN_FAILED (already Sentry-reported
    // inside the service) is recorded in the audit trail below so there's a
    // forensic record that live control may have persisted.
    const teardownResult = await terminateDeviceRemoteSessions(device.id);

    // FINDING #3: also sever the agent command WebSocket. terminateDeviceRemoteSessions
    // only cuts remote-desktop/terminal sessions; the agent's own command channel
    // would keep draining decrypted commands after quarantine. In-process only
    // (cross-replica broadcast is handled by the agentWs owner). Mirrors the
    // decommission caller in devices/core.ts (code 4041).
    const agentWsDisconnect = disconnectAgent(device.agentId, 4041, 'Device quarantined: mTLS cert expired');

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.quarantined',
      resourceType: 'device',
      resourceId: device.id,
      details: {
        reason: 'mtls_cert_expired',
        remoteSessionTeardown: teardownResult === TEARDOWN_FAILED ? 'failed' : 'ok',
        agentWsDisconnect,
      },
    });

    return c.json({ error: 'Device quarantined', quarantined: true }, 403);
  }

  // Wave 5 Task 4 (P1-MTLS-002): mode-gated proof-of-possession /
  // certificate-binding gate. Runs AFTER the legacy quarantine branch above
  // (unchanged) and BEFORE spending any Cloudflare issuance quota.
  const activeCertRow = await fetchActiveCertificateRow(device.id);
  const mode = getAgentMtlsBindingMode();
  const assertion = readClientCertAssertion(c);
  const authDecision = await evaluateRenewalAuthorization({
    mode,
    activeCertRow,
    assertion,
    recoveryProof: capableRequest?.recoveryProof,
    deviceId: device.id,
  });

  if (!authDecision.allowed) {
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: authDecision.reason, mode },
    });
    return c.json({ error: authDecision.message ?? 'Certificate renewal denied' }, (authDecision.status ?? 403) as 400 | 401 | 403 | 500);
  }

  if (authDecision.auditReason) {
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.binding_observed',
      resourceType: 'device',
      resourceId: device.id,
      details: { reason: authDecision.auditReason, mode },
    });
  }

  let cert;
  try {
    cert = await cfService.issueCertificate(mtlsSettings.certLifetimeDays);
  } catch (err) {
    // I9: `issueCertificate` now throws a typed, body-free CloudflareMtlsError,
    // so the rate-limit branch keys off the STATUS instead of substring-
    // matching a message that used to embed the raw upstream response body
    // (and was logged verbatim right here).
    console.error(
      '[agents] mTLS cert issuance failed:',
      err instanceof CloudflareMtlsError
        ? `${err.name}:${categorizeCloudflareMtlsError(err)}`
        : err instanceof Error ? err.name : 'unknown',
    );
    const message = err instanceof CloudflareMtlsError && err.status === 429
      ? 'Certificate renewal failed: rate limited, retry later'
      : 'Certificate renewal failed';
    return c.json({ error: message }, 500);
  }

  let parsedCert;
  try {
    parsedCert = parseIssuedLeafCertificate(cert.certificate);
  } catch (err) {
    console.error(
      '[agents] mTLS renew: failed to parse issued certificate, revoking orphan cert:',
      err instanceof Error ? err.name : 'unknown',
    );
    // ACCEPTED SCOPED EXCEPTION (fix round 1, Important #1): every OTHER
    // orphan-cert path below parses successfully and revokes durably via
    // revokeOrphanCertificateDurably. This is the one path that cannot: a
    // durable `device_mtls_certificates` row requires a NOT NULL
    // `serial_number` and (for `legacy_provenance = false`) a NOT NULL
    // `fingerprint_sha256` via the fingerprint check constraint — both come
    // ONLY from parsing the leaf we just failed to parse. Inventing either
    // value to satisfy the constraint would violate the same
    // never-fabricate-identity principle Task 1's migration documents for
    // legacy-imported rows. A bounded marker (no cert material) is logged so
    // this scoped exception is observable without leaking anything.
    console.error('[agents] ORPHAN_PROVIDER_CERT (cert-parse-failure, no durable row possible):', device.id);
    try {
      await cfService.revokeCertificate(cert.id);
    } catch (revokeErr) {
      console.error('[agents] failed to revoke unparseable orphan mTLS cert:', String(revokeErr));
    }
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'cert_parse_failed' },
    });
    return c.json({ error: 'Certificate renewal failed' }, 500);
  }

  if (capableRequest) {
    // ---- Protocol v2: two-phase — issue a pending_activation row only.
    // The old active row and legacy devices.mtls_cert_* columns are left
    // untouched until /renew-cert/confirm activates this row. ----
    const activationExpiresAt = new Date(Date.now() + PENDING_ACTIVATION_TTL_MS);

    // FINAL-REVIEW I8: only the `active` state carries a per-device partial
    // unique index, so nothing stopped a device from accumulating unbounded
    // `pending_activation` rows — each one a REAL Cloudflare certificate that
    // stays valid at the provider until the 5-minute sweep eventually reaches
    // it. Any agent that repeatedly issued but never confirmed (exactly the
    // C2 self-host-default case, and any confirm-side failure) piled these up.
    //
    // Supersede rather than reject: the agent is entitled to a certificate,
    // and rejecting would wedge a device whose earlier pending row it can no
    // longer confirm (lost material after a crash before the durable save).
    // The prior pending rows are moved to `pending_revocation` with an
    // immediately-due `next_revoke_attempt_at` INSIDE the same transaction as
    // the new insert, then revoked post-commit through Task 3's durable
    // lifecycle — never inside the transaction (#1105: no DB txn held across a
    // provider HTTP call).
    let insertedId: string | null = null;
    let supersededPendingIds: string[] = [];
    try {
      const txOut = await withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          const nowTs = new Date();
          const superseded = await tx
            .update(deviceMtlsCertificates)
            .set({ state: 'pending_revocation', nextRevokeAttemptAt: nowTs, updatedAt: nowTs })
            .where(and(
              eq(deviceMtlsCertificates.deviceId, device.id),
              eq(deviceMtlsCertificates.state, 'pending_activation'),
            ))
            .returning({ id: deviceMtlsCertificates.id });

          const [inserted] = await tx
            .insert(deviceMtlsCertificates)
            .values({
              orgId: device.orgId,
              deviceId: device.id,
              providerCertificateId: cert.id,
              serialNumber: parsedCert.serialNumber,
              fingerprintSha256: parsedCert.fingerprintSha256,
              publicKeySpki: parsedCert.publicKeySpkiBase64,
              legacyProvenance: false,
              state: 'pending_activation',
              issuedAt: new Date(cert.issuedOn),
              expiresAt: new Date(cert.expiresOn),
              activationExpiresAt,
            })
            .returning({ id: deviceMtlsCertificates.id });

          return { id: inserted?.id ?? null, supersededIds: superseded.map((r) => r.id) };
        }),
      );
      insertedId = txOut.id;
      supersededPendingIds = txOut.supersededIds;
    } catch (err) {
      console.error('[agents] mTLS renew (v2): pending row insert failed:', err instanceof Error ? err.name : 'unknown');
      insertedId = null;
      supersededPendingIds = [];
    }

    if (!insertedId) {
      console.error(
        '[agents] mTLS renew (v2): failed to persist pending certificate row, revoking orphan cert durably:',
        device.id,
      );
      await revokeOrphanCertificateDurably(device, cert, parsedCert, cfService);
      writeAuditEvent(c, {
        orgId: device.orgId,
        actorType: 'agent',
        actorId: device.agentId,
        action: 'agent.mtls.renew.denied',
        resourceType: 'device',
        resourceId: device.id,
        result: 'denied',
        // I7: emit the serial on BOTH cert_metadata_persist_failed twins.
        // The legacy branch's identical audit event already carried it; this
        // one omitted it, so the same failure was forensically weaker
        // depending on which protocol the agent spoke. Keeping the serial is
        // acceptable here — audit `details` is DB-resident, org-scoped, and
        // classified `excludedOpen` in the tenant export registry.
        details: { reason: 'cert_metadata_persist_failed', serialNumber: cert.serialNumber },
      });
      return c.json({ error: 'Certificate renewal failed' }, 500);
    }

    // I8: post-commit durable revoke of any pending row this issuance
    // superseded. Never fails the renewal — the 5-minute sweep repairs it.
    for (const supersededId of supersededPendingIds) {
      try {
        await revokeCertificateNowOrEnqueue(supersededId);
      } catch (err) {
        console.error(
          '[agents] mTLS renew (v2): superseded-pending revoke-or-enqueue failed unexpectedly:',
          err instanceof Error ? err.name : 'unknown',
        );
      }
    }

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.pending',
      resourceType: 'device',
      resourceId: device.id,
      details: { protocolVersion: 2, supersededPendingCount: supersededPendingIds.length },
    });

    if (redis) {
      try {
        const successKey = `mtls:renew:success:${device.id}`;
        const nowTs = Date.now();
        const memberId = `${nowTs}-${Math.random().toString(36).slice(2, 10)}`;
        await redis.zadd(successKey, nowTs, memberId);
        await redis.expire(successKey, MTLS_RENEW_SUCCESS_WINDOW_SECONDS);
      } catch (recordErr) {
        console.warn('[agents] failed to record mTLS success cooldown:', String(recordErr));
      }
    }

    return c.json({
      protocolVersion: 2 as const,
      certificateId: insertedId,
      activationExpiresAt: activationExpiresAt.toISOString(),
      mtls: {
        certificate: cert.certificate,
        privateKey: cert.privateKey,
        expiresAt: cert.expiresOn,
        serialNumber: cert.serialNumber,
      },
    });
  }

  // ---- Legacy (no protocolVersion): activate immediately, one transaction.
  // Insert the new row as pending_activation FIRST (satisfies
  // queueCertificateRevocationCore's "a replacement already exists" guard),
  // demote the old active row (if any), THEN promote the new row to active —
  // never both active at once, honoring the partial unique index. ----
  const now = new Date();
  let txResult: { demotedOldCertId: string | null } | null = null;
  try {
    txResult = await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        const [existingActive] = await tx
          .select({ id: deviceMtlsCertificates.id })
          .from(deviceMtlsCertificates)
          .where(and(eq(deviceMtlsCertificates.deviceId, device.id), eq(deviceMtlsCertificates.state, 'active')))
          .limit(1);

        const [inserted] = await tx
          .insert(deviceMtlsCertificates)
          .values({
            orgId: device.orgId,
            deviceId: device.id,
            providerCertificateId: cert.id,
            serialNumber: parsedCert.serialNumber,
            fingerprintSha256: parsedCert.fingerprintSha256,
            publicKeySpki: parsedCert.publicKeySpkiBase64,
            legacyProvenance: false,
            state: 'pending_activation',
            issuedAt: new Date(cert.issuedOn),
            expiresAt: new Date(cert.expiresOn),
            activationExpiresAt: now,
          })
          .returning({ id: deviceMtlsCertificates.id });

        if (!inserted) {
          throw new Error('mtls_history_insert_failed');
        }

        let demoted = false;
        if (existingActive) {
          demoted = await queueCertificateRevocationCore(tx, existingActive.id);
        }

        const activated = await tx
          .update(deviceMtlsCertificates)
          .set({ state: 'active', activatedAt: now, updatedAt: now })
          .where(and(eq(deviceMtlsCertificates.id, inserted.id), eq(deviceMtlsCertificates.state, 'pending_activation')))
          .returning({ id: deviceMtlsCertificates.id });

        if (activated.length !== 1) {
          throw new Error('mtls_history_activation_failed');
        }

        // Fix round 3 (code review): `cert.serialNumber` is Cloudflare's raw
        // `serial_number` API field — format is NOT guaranteed to match the
        // canonical uppercase-hex-no-separators form the certificate binding
        // decision (services/agentCertificateBinding.ts) compares against.
        // Normalize with the SAME shared helper that read side uses, so new
        // rows are stored canonical (the loader also defensively normalizes
        // on read, for rows written before this fix and for Task 1's
        // migration import of historical raw values).
        const legacyUpdated = await tx
          .update(devices)
          .set({
            mtlsCertSerialNumber: normalizeCertificateSerial(cert.serialNumber),
            mtlsCertExpiresAt: new Date(cert.expiresOn),
            mtlsCertIssuedAt: new Date(cert.issuedOn),
            mtlsCertCfId: cert.id,
            updatedAt: now,
          })
          .where(eq(devices.id, device.id))
          .returning({ id: devices.id });

        if (legacyUpdated.length !== 1) {
          throw new Error('legacy_device_update_failed');
        }

        return { demotedOldCertId: demoted ? existingActive!.id : null };
      }),
    );
  } catch (txErr) {
    console.error(
      '[agents] mTLS renew: transaction failed, revoking orphan cert durably:',
      // Minor (final review): log the error NAME, not `.message` — a raw
      // postgres message can carry column values / constraint detail. Matches
      // every sibling catch in this file.
      txErr instanceof Error ? txErr.name : 'unknown',
    );
    await revokeOrphanCertificateDurably(device, cert, parsedCert, cfService);
    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.denied',
      resourceType: 'device',
      resourceId: device.id,
      result: 'denied',
      details: { reason: 'cert_metadata_persist_failed', serialNumber: cert.serialNumber },
    });
    return c.json({ error: 'Certificate renewal failed' }, 500);
  }

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'agent',
    actorId: device.agentId,
    action: 'agent.mtls.renewed',
    resourceType: 'device',
    resourceId: device.id,
    details: { serialNumber: cert.serialNumber },
  });

  // E4: record successful renewal in the long-term cooldown window.
  if (redis) {
    try {
      const successKey = `mtls:renew:success:${device.id}`;
      const nowTs = Date.now();
      const memberId = `${nowTs}-${Math.random().toString(36).slice(2, 10)}`;
      await redis.zadd(successKey, nowTs, memberId);
      await redis.expire(successKey, MTLS_RENEW_SUCCESS_WINDOW_SECONDS);
    } catch (recordErr) {
      console.warn('[agents] failed to record mTLS success cooldown:', String(recordErr));
    }
  }

  // Post-commit durable revoke of the just-superseded certificate — NEVER
  // inside the transaction above (Task 3's #1105 rule: no DB txn held across
  // a provider HTTP call). Failure here is repaired by the 5-minute sweep and
  // must never fail the renewal response itself.
  if (txResult.demotedOldCertId) {
    try {
      await revokeCertificateNowOrEnqueue(txResult.demotedOldCertId);
    } catch (err) {
      console.error(
        '[agents] mTLS renew: post-commit revoke-or-enqueue failed unexpectedly:',
        err instanceof Error ? err.name : 'unknown',
      );
    }
  }

  return c.json({
    mtls: {
      certificate: cert.certificate,
      privateKey: cert.privateKey,
      expiresAt: cert.expiresOn,
      serialNumber: cert.serialNumber,
    }
  });
});

mtlsRoutes.post(
  '/renew-cert/confirm',
  agentBearerAuthMiddleware,
  zValidator('json', confirmRenewRequestSchema),
  async (c) => {
    const device = c.get('mtlsAgentDevice') as AuthenticatedMtlsDevice;
    const { certificateId } = c.req.valid('json');

    // Fix round 2 (code review, deferred minor (b)): per-device rate limit,
    // the same Redis-key pattern as /renew-cert and /renew-cert/challenge.
    const redis = getRedis();
    const confirmRate = await rateLimiter(
      redis,
      `mtls:renew:confirm:${device.id}`,
      MTLS_CONFIRM_LIMIT,
      MTLS_CONFIRM_WINDOW_SECONDS,
    );
    if (!confirmRate.allowed) {
      const retryAfter = Math.max(1, Math.ceil((confirmRate.resetAt.getTime() - Date.now()) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Confirmation rate limited; retry later' }, 429);
    }

    // Fix round 2 (code review, deferred minor (a)): tenant-status gate,
    // matching /renew-cert's F4 pattern — this route hand-rolls bearer auth
    // and never passes through agentAuthMiddleware, so a suspended/churned
    // tenant whose device token was not individually suspended could
    // otherwise still activate a pending certificate. Same opaque 401 as a
    // stale token so suspension is not distinguishable from a bad credential.
    if (!(await isAgentTenantActive(device.orgId))) {
      writeAuditEvent(c, {
        orgId: device.orgId,
        actorType: 'agent',
        actorId: device.agentId,
        action: 'agent.mtls.renew.confirm_denied',
        resourceType: 'device',
        resourceId: device.id,
        result: 'denied',
        details: { reason: 'tenant_inactive' },
      });
      return c.json({ error: 'Invalid agent credentials' }, 401);
    }

    const pendingRow = await withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          id: deviceMtlsCertificates.id,
          deviceId: deviceMtlsCertificates.deviceId,
          state: deviceMtlsCertificates.state,
          serialNumber: deviceMtlsCertificates.serialNumber,
          activationExpiresAt: deviceMtlsCertificates.activationExpiresAt,
          expiresAt: deviceMtlsCertificates.expiresAt,
          issuedAt: deviceMtlsCertificates.issuedAt,
          providerCertificateId: deviceMtlsCertificates.providerCertificateId,
        })
        .from(deviceMtlsCertificates)
        .where(eq(deviceMtlsCertificates.id, certificateId))
        .limit(1);
      return row ?? null;
    });

    if (!pendingRow || pendingRow.deviceId !== device.id) {
      return c.json({ error: 'Certificate not found' }, 404);
    }

    // FINAL-REVIEW C4 (idempotent re-confirm): if this row is ALREADY the
    // device's active certificate, a previous confirm succeeded and its
    // response was lost in flight. Returning 409 here — as this route used to
    // — told the agent "confirmation failed", so it kept the material pending,
    // retried until `activation_expires_at` elapsed, and then DELETED the only
    // copy of the certificate the server considers active: permanent identity
    // loss from a single dropped response. Re-confirming an already-active row
    // for the SAME device is a no-op, so report success and let the agent
    // adopt the material it is holding.
    if (pendingRow.state === 'active') {
      writeAuditEvent(c, {
        orgId: device.orgId,
        actorType: 'agent',
        actorId: device.agentId,
        action: 'agent.mtls.renew.confirmed',
        resourceType: 'device',
        resourceId: device.id,
        details: { serialNumber: pendingRow.serialNumber, idempotentReplay: true },
      });
      return c.json({ success: true, alreadyActive: true });
    }

    if (pendingRow.state !== 'pending_activation') {
      // Terminal, non-adoptable states (revoked / pending_revocation). `state`
      // is echoed so the agent can distinguish "already yours, adopt it" from
      // "this certificate is dead, discard it" instead of guessing from a
      // bare 409 (see agent/internal/heartbeat/heartbeat.go).
      return c.json({ error: 'Certificate is not pending activation', state: pendingRow.state }, 409);
    }

    if (!pendingRow.activationExpiresAt || pendingRow.activationExpiresAt.getTime() < Date.now()) {
      return c.json({ error: 'Activation window has expired; request a new certificate' }, 410);
    }

    // Confirmation proves possession of the NEW certificate: the assertion's
    // serial must match this pending row's serial, not the device's
    // currently-active (old) certificate.
    //
    // FINAL-REVIEW C2/I4 — the assertion REQUIREMENT is mode-gated, matching
    // the other two mode surfaces:
    //
    //   - `off`     the assertion is not required (nor is one expected: the
    //               binding surface never consults it either). Before this fix
    //               confirmation demanded a verified assertion in EVERY mode
    //               while the protocol-v2 issue branch was NOT mode-gated, so
    //               a current agent — which always sends protocolVersion: 2 —
    //               could never complete a renewal against the self-host
    //               default AGENT_MTLS_BINDING_MODE=off: it received pending
    //               material it could never activate, and the certificate was
    //               swept and reissued forever.
    //   - `audit`   same as `off`, but a bounded observation is audit-logged.
    //   - `enforce` unchanged: a verified, matching assertion is required.
    //
    // A verified assertion naming a DIFFERENT certificate still fails closed
    // in every mode — identical to `evaluateRenewalAuthorization`'s
    // pre-mode-gate mismatch branch. A trusted spoof signal is never ignored
    // just because the mode is permissive; only the ABSENCE of an assertion is
    // tolerated in off/audit.
    //
    // I3: `pendingRow.serialNumber` is normalized before comparison, for the
    // same reason as `fetchActiveCertificateRow`.
    const mode = getAgentMtlsBindingMode();
    const assertion = readClientCertAssertion(c);
    const pendingSerial = normalizeCertificateSerial(pendingRow.serialNumber);
    const assertionMatches = assertion.verified && assertion.serial === pendingSerial;

    if (!assertionMatches) {
      const mismatched = assertion.verified;
      if (mode === 'enforce' || mismatched) {
        writeAuditEvent(c, {
          orgId: device.orgId,
          actorType: 'agent',
          actorId: device.agentId,
          action: 'agent.mtls.renew.confirm_denied',
          resourceType: 'device',
          resourceId: device.id,
          result: 'denied',
          details: { reason: mismatched ? 'renewal_assertion_mismatch' : 'renewal_binding_missing', mode },
        });
        return c.json({ error: "Confirmation requires the new certificate's assertion" }, 401);
      }
      if (mode === 'audit') {
        writeAuditEvent(c, {
          orgId: device.orgId,
          actorType: 'agent',
          actorId: device.agentId,
          action: 'agent.mtls.renew.confirm_binding_observed',
          resourceType: 'device',
          resourceId: device.id,
          details: { reason: 'renewal_binding_missing', mode },
        });
      }
    }

    const now = new Date();
    let txResult: { demotedOldCertId: string | null } | null = null;
    try {
      txResult = await withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          const [existingActive] = await tx
            .select({ id: deviceMtlsCertificates.id })
            .from(deviceMtlsCertificates)
            .where(and(eq(deviceMtlsCertificates.deviceId, device.id), eq(deviceMtlsCertificates.state, 'active')))
            .limit(1);

          // Demote-before-promote: the partial unique index allows only one
          // `active` row per device, so the old row must leave `active`
          // before the pending row enters it.
          let demoted = false;
          if (existingActive) {
            demoted = await queueCertificateRevocationCore(tx, existingActive.id);
          }

          const activated = await tx
            .update(deviceMtlsCertificates)
            .set({ state: 'active', activatedAt: now, updatedAt: now })
            .where(and(eq(deviceMtlsCertificates.id, pendingRow.id), eq(deviceMtlsCertificates.state, 'pending_activation')))
            .returning({ id: deviceMtlsCertificates.id });

          if (activated.length !== 1) {
            throw new Error('mtls_confirm_activation_failed');
          }

          const legacyUpdated = await tx
            .update(devices)
            .set({
              // I3: store the canonical form, matching the legacy renewal
              // path's write and what the binding reader expects.
              mtlsCertSerialNumber: pendingSerial ?? pendingRow.serialNumber,
              mtlsCertExpiresAt: pendingRow.expiresAt,
              mtlsCertIssuedAt: pendingRow.issuedAt,
              mtlsCertCfId: pendingRow.providerCertificateId,
              updatedAt: now,
            })
            .where(eq(devices.id, device.id))
            .returning({ id: devices.id });

          if (legacyUpdated.length !== 1) {
            throw new Error('legacy_device_update_failed');
          }

          return { demotedOldCertId: demoted ? existingActive!.id : null };
        }),
      );
    } catch (txErr) {
      console.error(
        '[agents] mTLS confirm: activation transaction failed:',
        // Minor (final review): error NAME only — see the sibling catch above.
        txErr instanceof Error ? txErr.name : 'unknown',
      );
      writeAuditEvent(c, {
        orgId: device.orgId,
        actorType: 'agent',
        actorId: device.agentId,
        action: 'agent.mtls.renew.confirm_denied',
        resourceType: 'device',
        resourceId: device.id,
        result: 'denied',
        details: { reason: 'confirm_transaction_failed' },
      });
      return c.json({ error: 'Certificate confirmation failed' }, 500);
    }

    writeAuditEvent(c, {
      orgId: device.orgId,
      actorType: 'agent',
      actorId: device.agentId,
      action: 'agent.mtls.renew.confirmed',
      resourceType: 'device',
      resourceId: device.id,
      details: { serialNumber: pendingRow.serialNumber },
    });

    // Post-commit durable revoke of the just-superseded certificate — see the
    // identical rationale on /renew-cert above. Never fails the response.
    if (txResult.demotedOldCertId) {
      try {
        await revokeCertificateNowOrEnqueue(txResult.demotedOldCertId);
      } catch (err) {
        console.error(
          '[agents] mTLS confirm: post-commit revoke-or-enqueue failed unexpectedly:',
          err instanceof Error ? err.name : 'unknown',
        );
      }
    }

    return c.json({ success: true });
  },
);

// ============================================
// Admin Quarantine Management (user JWT auth)
// ============================================

mtlsRoutes.get('/quarantined', authMiddleware, requirePermission('devices', 'read'), async (c) => {
  const auth = c.get('auth') as { orgId?: string; orgCondition?: (col: any) => any };

  const rows = await db
    .select({
      id: devices.id,
      agentId: devices.agentId,
      hostname: devices.hostname,
      osType: devices.osType,
      quarantinedAt: devices.quarantinedAt,
      quarantinedReason: devices.quarantinedReason,
    })
    .from(devices)
    .where(
      and(
        eq(devices.status, 'quarantined'),
        auth.orgCondition ? auth.orgCondition(devices.orgId) : undefined
      )
    )
    .orderBy(desc(devices.quarantinedAt))
    .limit(100);

  return c.json({ devices: rows });
});

mtlsRoutes.post('/:id/approve', authMiddleware, requirePermission('devices', 'write'), zValidator('param', deviceIdParamSchema), async (c) => {
  const { id: deviceId } = c.req.valid('param');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      agentId: devices.agentId,
      hostname: devices.hostname,
      status: devices.status,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  const mtlsCert = await issueMtlsCertForDevice(device.id, device.orgId);

  await db
    .update(devices)
    .set({
      status: 'online',
      quarantinedAt: null,
      quarantinedReason: null,
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.approve',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
    details: { mtlsCertIssued: mtlsCert !== null },
  });

  return c.json({
    success: true,
    mtls: mtlsCert,
  });
});

mtlsRoutes.post('/:id/deny', authMiddleware, requirePermission('devices', 'write'), zValidator('param', deviceIdParamSchema), async (c) => {
  const { id: deviceId } = c.req.valid('param');
  const auth = c.get('auth') as { orgId?: string; user?: { id: string }; canAccessOrg?: (id: string) => boolean };

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      agentId: devices.agentId,
      hostname: devices.hostname,
      status: devices.status,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (auth.canAccessOrg && !auth.canAccessOrg(device.orgId)) {
    return c.json({ error: 'Not authorized' }, 403);
  }

  if (device.status !== 'quarantined') {
    return c.json({ error: 'Device is not quarantined' }, 400);
  }

  await db
    .update(devices)
    .set({
      status: 'decommissioned',
      updatedAt: new Date(),
    })
    .where(eq(devices.id, device.id));

  // Tear down any live remote-control session to a device we're decommissioning.
  // Never throws; a TEARDOWN_FAILED is recorded in the audit trail below.
  const teardownResult = await terminateDeviceRemoteSessions(device.id);

  writeAuditEvent(c, {
    orgId: device.orgId,
    actorType: 'user',
    actorId: auth.user?.id ?? 'unknown',
    action: 'admin.device.deny',
    resourceType: 'device',
    resourceId: device.id,
    resourceName: device.hostname,
    details: { remoteSessionTeardown: teardownResult === TEARDOWN_FAILED ? 'failed' : 'ok' },
  });

  return c.json({ success: true });
});

// ============================================
// Org mTLS Settings (user JWT auth)
// ============================================

mtlsRoutes.patch(
  '/org/:orgId/settings/mtls',
  authMiddleware,
  requirePermission('orgs', 'write'),
  zValidator('param', orgIdParamSchema),
  zValidator('json', orgMtlsSettingsSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const data = c.req.valid('json');
    const auth = c.get('auth') as { user?: { id: string }; canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const currentSettings = isObject(org.settings) ? org.settings : {};
    const updatedSettings = {
      ...currentSettings,
      mtls: {
        certLifetimeDays: data.certLifetimeDays,
        expiredCertPolicy: data.expiredCertPolicy,
      },
    };

    await db
      .update(organizations)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));

    writeAuditEvent(c, {
      orgId,
      actorType: 'user',
      actorId: auth.user?.id ?? 'unknown',
      action: 'admin.org.mtls_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: data,
    });

    return c.json({ success: true, settings: updatedSettings.mtls });
  }
);

// ============================================
// Org Helper Settings (user JWT auth)
// ============================================

mtlsRoutes.get(
  '/org/:orgId/settings/helper',
  authMiddleware,
  requirePermission('orgs', 'read'),
  zValidator('param', orgIdParamSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const auth = c.get('auth') as { canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const helperSettings = await getOrgHelperSettings(orgId);
    return c.json(helperSettings);
  }
);

mtlsRoutes.patch(
  '/org/:orgId/settings/helper',
  authMiddleware,
  requirePermission('orgs', 'write'),
  zValidator('param', orgIdParamSchema),
  zValidator('json', orgHelperSettingsSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const data = c.req.valid('json');
    const auth = c.get('auth') as { user?: { id: string }; canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const currentSettings = isObject(org.settings) ? org.settings : {};
    const updatedSettings = {
      ...currentSettings,
      helper: {
        enabled: data.enabled,
      },
    };

    await db
      .update(organizations)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));

    writeAuditEvent(c, {
      orgId,
      actorType: 'user',
      actorId: auth.user?.id ?? 'unknown',
      action: 'admin.org.helper_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: data,
    });

    return c.json({ success: true, settings: updatedSettings.helper });
  }
);

// ============================================
// Org Log Forwarding Settings (user JWT auth)
// ============================================

mtlsRoutes.get(
  '/org/:orgId/settings/log-forwarding',
  authMiddleware,
  requirePermission('orgs', 'read'),
  zValidator('param', orgIdParamSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const auth = c.get('auth') as { canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const settings = isObject(org.settings) ? org.settings : {};
    const forwarding = (isObject(settings.logForwarding) ? settings.logForwarding : { enabled: false }) as Record<string, unknown>;
    const safe = {
      ...forwarding,
      elasticsearchApiKey: forwarding.elasticsearchApiKey ? '****' : undefined,
      elasticsearchPassword: forwarding.elasticsearchPassword ? '****' : undefined,
    };

    return c.json({ settings: { logForwarding: safe } });
  }
);

mtlsRoutes.patch(
  '/org/:orgId/settings/log-forwarding',
  authMiddleware,
  requirePermission('orgs', 'write'),
  requireMfa(),
  zValidator('param', orgIdParamSchema),
  zValidator('json', orgLogForwardingSettingsSchema),
  async (c) => {
    const { orgId } = c.req.valid('param');
    const data = c.req.valid('json');
    const auth = c.get('auth') as { user?: { id: string }; canAccessOrg?: (id: string) => boolean };

    if (auth.canAccessOrg && !auth.canAccessOrg(orgId)) {
      return c.json({ error: 'Not authorized' }, 403);
    }

    const [org] = await db
      .select({ id: organizations.id, settings: organizations.settings })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!org) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const currentSettings = isObject(org.settings) ? org.settings : {};
    const existingForwarding = isObject(currentSettings.logForwarding)
      ? (currentSettings.logForwarding as Record<string, unknown>)
      : {};
    const hasOwn = (obj: Record<string, unknown>, key: string): boolean =>
      Object.prototype.hasOwnProperty.call(obj, key);

    const incoming = data as Record<string, unknown>;
    const providedApiKey = hasOwn(incoming, 'elasticsearchApiKey');
    const providedBasic =
      hasOwn(incoming, 'elasticsearchUsername') || hasOwn(incoming, 'elasticsearchPassword');

    const resolvedUrl = hasOwn(incoming, 'elasticsearchUrl')
      ? toOptionalString(incoming.elasticsearchUrl)
      : toOptionalString(existingForwarding.elasticsearchUrl);
    const resolvedIndexPrefix = hasOwn(incoming, 'indexPrefix')
      ? toOptionalString(incoming.indexPrefix)
      : toOptionalString(existingForwarding.indexPrefix);
    let resolvedApiKey = hasOwn(incoming, 'elasticsearchApiKey')
      ? resolveSecretForStorage(incoming.elasticsearchApiKey, existingForwarding.elasticsearchApiKey)
      : encryptSecret(toOptionalString(existingForwarding.elasticsearchApiKey)) ?? undefined;
    let resolvedUsername = hasOwn(incoming, 'elasticsearchUsername')
      ? toOptionalString(incoming.elasticsearchUsername)
      : toOptionalString(existingForwarding.elasticsearchUsername);
    let resolvedPassword = hasOwn(incoming, 'elasticsearchPassword')
      ? resolveSecretForStorage(incoming.elasticsearchPassword, existingForwarding.elasticsearchPassword)
      : encryptSecret(toOptionalString(existingForwarding.elasticsearchPassword)) ?? undefined;

    // Explicit auth-method updates should clear stale credentials from the other mode.
    if (providedBasic && !providedApiKey) {
      resolvedApiKey = undefined;
    } else if (providedApiKey && !providedBasic) {
      resolvedUsername = undefined;
      resolvedPassword = undefined;
    }

    if (data.enabled) {
      const targetErrors = await validateLogForwardingTarget(resolvedUrl);
      if (targetErrors.length > 0) {
        return c.json({ error: 'Invalid log forwarding target', details: targetErrors }, 400);
      }
    }

    const normalizedForwarding: Record<string, unknown> = {
      enabled: data.enabled,
      indexPrefix: resolvedIndexPrefix ?? 'breeze-logs',
    };
    if (resolvedUrl) normalizedForwarding.elasticsearchUrl = resolvedUrl;
    if (resolvedApiKey) normalizedForwarding.elasticsearchApiKey = resolvedApiKey;
    if (resolvedUsername) normalizedForwarding.elasticsearchUsername = resolvedUsername;
    if (resolvedPassword) normalizedForwarding.elasticsearchPassword = resolvedPassword;

    const updatedSettings = {
      ...currentSettings,
      logForwarding: normalizedForwarding,
    };

    await db
      .update(organizations)
      .set({
        settings: updatedSettings,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, orgId));

    const { elasticsearchApiKey, elasticsearchPassword, ...safeData } = normalizedForwarding;
    const maskedDetails = {
      ...safeData,
      elasticsearchApiKey: elasticsearchApiKey ? '****' : undefined,
      elasticsearchPassword: elasticsearchPassword ? '****' : undefined,
    };

    writeAuditEvent(c, {
      orgId,
      actorType: 'user',
      actorId: auth.user?.id ?? 'unknown',
      action: 'admin.org.log_forwarding_settings.update',
      resourceType: 'organization',
      resourceId: orgId,
      details: maskedDetails,
    });

    return c.json({ success: true, settings: { logForwarding: maskedDetails } });
  }
);
