/**
 * Real-DB integration proof for SR2-16 (trusted client-IP boundary) closing
 * out the partner IP allowlist's fail-open gap.
 *
 * Drives the REAL `enforceIpAllowlist` / `evaluateIpAllowlist`
 * (`services/ipAllowlist.ts`) and the REAL `getClientRateLimitKey`
 * (`routes/auth/helpers.ts`) against a real Postgres instance (RLS enforced
 * as the unprivileged `breeze_app` role) for a partner with a configured
 * `settings.security.ipAllowlist`.
 *
 * Prior to Task 1 of this PR, `evaluateIpAllowlist` returned
 * `{ decision: 'skip', reason: 'untrusted_ip' }` when the client IP could not
 * be determined, and `isBlocked(skip) === false` — so any allowlist-protected
 * partner was silently let through whenever proxy trust was unconfigured,
 * stale, or a request carried a spoofed forwarded-IP header from an
 * untrusted peer. Task 1 flipped that branch to `deny`. This suite proves
 * the fix end-to-end against real infrastructure; the deny assertions were
 * verified to go RED by reverting that branch to `skip` before restoring it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, it, expect, afterEach } from 'vitest';
import { partners, auditLogs } from '../../db/schema';
import { enforceIpAllowlist, isBlocked } from '../../services/ipAllowlist';
import { getClientRateLimitKey } from '../../routes/auth/helpers';
import type { RequestLike } from '../../services/auditEvents';
import { createPartner } from './db-utils';
import { getTestDb } from './setup';

// --- Test context shim ------------------------------------------------------
// Mirrors the canonical `makeContext` pattern in `services/clientIp.test.ts`:
// a minimal Hono-context-like object with case-insensitive header lookup and
// an optional `env.incoming.socket.remoteAddress` (the Node adapter's raw TCP
// peer, which `getImmediatePeerIp(OrUndefined)` reads and which can NEVER be
// spoofed at L7 — unlike any forwarded header).
function makeContext(headers: Record<string, string | undefined>, remoteAddress?: string): RequestLike {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) normalized[k.toLowerCase()] = v;
  }
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
    ...(remoteAddress ? { env: { incoming: { socket: { remoteAddress } } } } : {}),
  } as RequestLike;
}

async function setPartnerAllowlist(partnerId: string, ipAllowlist: string[]): Promise<void> {
  await getTestDb()
    .update(partners)
    .set({ settings: { security: { ipAllowlist } } })
    .where(eq(partners.id, partnerId));
}

// `writeAuditEvent` (called synchronously inside `enforceIpAllowlist`) fires
// `createAuditLogAsync` WITHOUT awaiting it — by design, so a slow/failing
// audit write never blocks the caller's request path. That means the audit
// row lands asynchronously relative to `enforceIpAllowlist`'s returned
// Promise resolving. Poll briefly instead of assuming synchronous landing.
async function waitForAuditRow(action: string, resourceId: string, timeoutMs = 3000) {
  const database = getTestDb();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await database
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)));
    if (rows.length > 0) return rows[0];
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const ALLOWLISTED_IP = '203.0.113.5/32';
const TRUSTED_PROXY_PEER = '198.51.100.10';
const UNTRUSTED_PEER = '45.66.77.88';

describe('SR2-16 — partner IP allowlist trust boundary (real DB)', () => {
  const originalTrust = process.env.TRUST_PROXY_HEADERS;
  const originalCidrs = process.env.TRUSTED_PROXY_CIDRS;
  const originalMode = process.env.IP_ALLOWLIST_ENFORCEMENT_MODE;
  const originalTrustCf = process.env.TRUST_CF_CONNECTING_IP;

  afterEach(() => {
    if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrust;
    if (originalCidrs === undefined) delete process.env.TRUSTED_PROXY_CIDRS;
    else process.env.TRUSTED_PROXY_CIDRS = originalCidrs;
    if (originalMode === undefined) delete process.env.IP_ALLOWLIST_ENFORCEMENT_MODE;
    else process.env.IP_ALLOWLIST_ENFORCEMENT_MODE = originalMode;
    if (originalTrustCf === undefined) delete process.env.TRUST_CF_CONNECTING_IP;
    else process.env.TRUST_CF_CONNECTING_IP = originalTrustCf;
  });

  describe('Hosted / Cloudflare mode — trusted peer, CF-Connecting-IP honored', () => {
    it('allows when CF-Connecting-IP (from the trusted Caddy/CF peer) matches the allowlist', async () => {
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.TRUSTED_PROXY_CIDRS = `${TRUSTED_PROXY_PEER}/32`;
      process.env.TRUST_CF_CONNECTING_IP = 'true';

      const partner = await createPartner();
      await setPartnerAllowlist(partner.id, [ALLOWLISTED_IP]);

      const c = makeContext({ 'cf-connecting-ip': '203.0.113.5' }, TRUSTED_PROXY_PEER);
      const decision = await enforceIpAllowlist(c, { partnerId: partner.id, isPlatformAdmin: false });

      expect(decision).toEqual({ decision: 'allow' });
      expect(isBlocked(decision)).toBe(false);
    });

    it('denies with not_in_list when CF-Connecting-IP (from the trusted peer) is NOT in the allowlist', async () => {
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.TRUSTED_PROXY_CIDRS = `${TRUSTED_PROXY_PEER}/32`;
      process.env.TRUST_CF_CONNECTING_IP = 'true';

      const partner = await createPartner();
      await setPartnerAllowlist(partner.id, [ALLOWLISTED_IP]);

      const c = makeContext({ 'cf-connecting-ip': '198.51.100.9' }, TRUSTED_PROXY_PEER);
      const decision = await enforceIpAllowlist(c, { partnerId: partner.id, isPlatformAdmin: false });

      expect(decision).toEqual({ decision: 'deny', reason: 'not_in_list' });
      expect(isBlocked(decision)).toBe(true);
    });
  });

  describe('Self-hosted, NOT behind Cloudflare — CF-Connecting-IP is not trusted (TRUST_CF_CONNECTING_IP unset)', () => {
    // The bundled Caddy does not strip CF-Connecting-IP. With the flag off, a
    // CF-Connecting-IP even from the TRUSTED proxy peer must be ignored — the
    // request is attributed to the real peer IP, not the header — so an
    // attacker cannot spoof an allowlisted IP by sending the header.
    it('ignores CF-Connecting-IP and attributes to the peer IP, denying a spoofed allowlisted value', async () => {
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.TRUSTED_PROXY_CIDRS = `${TRUSTED_PROXY_PEER}/32`;
      delete process.env.TRUST_CF_CONNECTING_IP;

      const partner = await createPartner();
      await setPartnerAllowlist(partner.id, [ALLOWLISTED_IP]);

      // CF-Connecting-IP claims the allowlisted IP, but the flag is off and there
      // is no XFF, so resolution falls to the (trusted) peer IP, which is not on
      // the allowlist → deny.
      const c = makeContext({ 'cf-connecting-ip': ALLOWLISTED_IP }, TRUSTED_PROXY_PEER);
      const decision = await enforceIpAllowlist(c, { partnerId: partner.id, isPlatformAdmin: false });

      expect(isBlocked(decision)).toBe(true);
    });
  });

  describe('Spoof from an untrusted peer — THE guard-bite', () => {
    it('denies with untrusted_ip when a forged CF-Connecting-IP arrives from a peer NOT in TRUSTED_PROXY_CIDRS', async () => {
      process.env.TRUST_PROXY_HEADERS = 'true';
      process.env.TRUSTED_PROXY_CIDRS = `${TRUSTED_PROXY_PEER}/32`;

      const partner = await createPartner();
      await setPartnerAllowlist(partner.id, [ALLOWLISTED_IP]);

      // The attacker's TCP peer is NOT the trusted Caddy/CF IP, yet they set
      // CF-Connecting-IP to an address that IS on the allowlist. If the
      // header were honored, this would wrongly ALLOW — asserting only
      // "not allowed" would pass vacuously against a `deny/not_in_list` too;
      // the reason MUST be `untrusted_ip` specifically.
      const c = makeContext({ 'cf-connecting-ip': '203.0.113.5' }, UNTRUSTED_PEER);
      const decision = await enforceIpAllowlist(c, { partnerId: partner.id, isPlatformAdmin: false });

      expect(decision).toEqual({ decision: 'deny', reason: 'untrusted_ip' });
      expect(isBlocked(decision)).toBe(true);
    });
  });

  describe('Generic / no-trust mode — fail closed with no proxy trust configured', () => {
    it('denies with untrusted_ip regardless of headers when TRUST_PROXY_HEADERS is false', async () => {
      process.env.TRUST_PROXY_HEADERS = 'false';
      delete process.env.TRUSTED_PROXY_CIDRS;

      const partner = await createPartner();
      await setPartnerAllowlist(partner.id, [ALLOWLISTED_IP]);

      const c = makeContext(
        { 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '203.0.113.5', 'x-real-ip': '203.0.113.5' },
        UNTRUSTED_PEER,
      );
      const decision = await enforceIpAllowlist(c, { partnerId: partner.id, isPlatformAdmin: false });

      expect(decision).toEqual({ decision: 'deny', reason: 'untrusted_ip' });
      expect(isBlocked(decision)).toBe(true);
    });
  });

  describe('No over-deny — lockout regression guard', () => {
    it('does NOT deny a partner with an empty allowlist, even with an untrustable IP', async () => {
      process.env.TRUST_PROXY_HEADERS = 'false';
      delete process.env.TRUSTED_PROXY_CIDRS;

      const partner = await createPartner(); // default settings = {} -> empty allowlist

      const c = makeContext({ 'cf-connecting-ip': '203.0.113.5' }, UNTRUSTED_PEER);
      const decision = await enforceIpAllowlist(c, { partnerId: partner.id, isPlatformAdmin: false });

      expect(decision).toEqual({ decision: 'skip', reason: 'empty_list' });
      expect(isBlocked(decision)).toBe(false);
    });

    it('does NOT deny a platform admin, even with a configured allowlist and an untrustable IP', async () => {
      process.env.TRUST_PROXY_HEADERS = 'false';
      delete process.env.TRUSTED_PROXY_CIDRS;

      const partner = await createPartner();
      await setPartnerAllowlist(partner.id, [ALLOWLISTED_IP]);

      const c = makeContext({ 'cf-connecting-ip': '203.0.113.5' }, UNTRUSTED_PEER);
      const decision = await enforceIpAllowlist(c, { partnerId: partner.id, isPlatformAdmin: true });

      expect(decision).toEqual({ decision: 'skip', reason: 'platform_admin' });
      expect(isBlocked(decision)).toBe(false);
    });
  });

  describe('Rate-limit evasion — socket-peer keying', () => {
    it('keys two requests with different forged X-Forwarded-For values from the same untrusted socket peer identically', () => {
      process.env.TRUST_PROXY_HEADERS = 'false';
      delete process.env.TRUSTED_PROXY_CIDRS;

      const c1 = makeContext({ 'x-forwarded-for': '1.2.3.4' }, UNTRUSTED_PEER);
      const c2 = makeContext({ 'x-forwarded-for': '9.8.7.6' }, UNTRUSTED_PEER);

      const key1 = getClientRateLimitKey(c1);
      const key2 = getClientRateLimitKey(c2);

      expect(key1).toBe(`socket:${UNTRUSTED_PEER}`);
      expect(key2).toBe(`socket:${UNTRUSTED_PEER}`);
      expect(key1).toBe(key2);
      // Guard against a vacuous pass: the key must not be derived from the
      // (attacker-controlled) forwarded header at all.
      expect(key1).not.toContain('1.2.3.4');
      expect(key2).not.toContain('9.8.7.6');
    });
  });

  describe('Audit — untrusted_ip deny writes an audit event with no leaked spoofed IP', () => {
    it('writes ip_allowlist.denied with details.reason=untrusted_ip and details.clientIp=null', async () => {
      process.env.TRUST_PROXY_HEADERS = 'false';
      delete process.env.TRUSTED_PROXY_CIDRS;

      const partner = await createPartner();
      await setPartnerAllowlist(partner.id, [ALLOWLISTED_IP]);

      const actorId = randomUUID();
      const c = makeContext({ 'cf-connecting-ip': '203.0.113.5' }, UNTRUSTED_PEER);
      const decision = await enforceIpAllowlist(c, {
        partnerId: partner.id,
        isPlatformAdmin: false,
        actorId,
        actorEmail: 'attacker@example.com',
      });
      expect(decision).toEqual({ decision: 'deny', reason: 'untrusted_ip' });

      const row = await waitForAuditRow('ip_allowlist.denied', partner.id);
      expect(row).toBeDefined();
      expect(row?.result).toBe('denied');
      const details = row?.details as Record<string, unknown> | null;
      expect(details?.reason).toBe('untrusted_ip');
      // The forged CF-Connecting-IP value (203.0.113.5) must NOT leak into
      // the audit log as if it were a trusted observation.
      expect(details?.clientIp).toBeNull();
      expect(JSON.stringify(details)).not.toContain('203.0.113.5');
    });
  });
});
