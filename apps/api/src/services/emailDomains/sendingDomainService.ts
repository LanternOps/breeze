import { and, count, desc, eq, sql } from 'drizzle-orm';
import {
  normalizeSendingDomain, senderDisplayNameSchema, senderLocalPartSchema,
  type SenderIdentityDto, type SendingDomainDto, type SendingDomainProviderId,
  type SendingDomainStatusReason, type SendingDomainStatusValue,
  type SendingDomainsCapabilityDto, type SendingDomainsListResponse,
} from '@breeze/shared';
import type { PartnerMailStream } from './mailPurposes';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import {
  emailProviderDomainReleases, partnerInboundDomains, partnerSenderIdentities,
  partnerSendingDomains, partners,
} from '../../db/schema';
import type { PartnerTrustState } from '../../db/schema/orgs';
import { enqueueSyncDomain } from '../../jobs/sendingDomainsWorker';
import { evaluateCapabilityContinuationForState } from '../partnerTrust';
import { rateLimiter } from '../rate-limit';
import { getRedis } from '../redis';
import { getEmailDomainsConfig, isPartnerLaneConfigured } from './config';
import { STATS_WINDOW_DAYS, loadAllPartnerSendingWindowStats } from './deliveryStats';
import { SendingDomainPolicyError, assertSendingDomainAllowed } from './domainPolicy';
import { readProviderKeyProbe } from './keyProbe';
import { getEmailDomainProvider } from './providerRegistry';

export type SendingDomainErrorCode =
  | 'sending_domains_unsupported' | 'domain_invalid' | 'domain_unavailable'
  | 'domain_limit_reached' | 'rate_limited' | 'not_found' | 'domain_not_sendable';

export class SendingDomainServiceError extends Error {
  constructor(
    readonly code: SendingDomainErrorCode,
    message: string,
    readonly status: 400 | 404 | 409 | 429,
  ) {
    super(message);
    this.name = 'SendingDomainServiceError';
  }
}

/**
 * ONE message for BOTH conflict causes — "another partner holds this name" and
 * "it exists at our provider outside Breeze" (spec §4.3). Telling them apart
 * would let anyone probe which domains other Breeze customers send from.
 */
export const DOMAIN_UNAVAILABLE_MESSAGE =
  'This domain may already be registered with Breeze or with our email provider. '
  + 'Use a dedicated subdomain (for example mail.yourdomain.com), or contact support.';

const CREATE_LIMIT_PER_DAY = 5;
const CREATE_WINDOW_SECONDS = 24 * 60 * 60;
const CHECK_LIMIT_PER_MINUTE = 1;
const CHECK_WINDOW_SECONDS = 60;

export interface CapabilityPartnerRow {
  id: string;
  status: string;
  trustState: PartnerTrustState;
  probationEnrollments: number;
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * W02's `SendingDomainDto` is an EXACT field set with ISO-8601 strings, and it
 * deliberately omits `providerRegion` and `nextCheckAt` — the poll schedule and
 * the provider's region are not the partner's business. `statusChangedAt` IS
 * included: the UI dates the "at risk since"/"failed" banners from it.
 * Keep this mapper exhaustive against that type rather than spreading the row.
 */
function toDomainDto(row: typeof partnerSendingDomains.$inferSelect): SendingDomainDto {
  return {
    id: row.id,
    domain: row.domain,
    provider: row.provider as SendingDomainProviderId,
    status: row.status as SendingDomainStatusValue,
    statusReason: (row.statusReason ?? null) as SendingDomainStatusReason | null,
    dnsRecords: (row.dnsRecords ?? []) as SendingDomainDto['dnsRecords'],
    verifiedAt: iso(row.verifiedAt),
    lastCheckedAt: iso(row.lastCheckedAt),
    lastTestAt: iso(row.lastTestAt),
    lastTestStatus: row.lastTestStatus ?? null,
    lastTestError: row.lastTestError ?? null,
    lastSendError: row.lastSendError ?? null,
    lastSendErrorAt: iso(row.lastSendErrorAt),
    statusChangedAt: row.statusChangedAt.toISOString(),
    providerManaged: row.providerManaged,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `SenderIdentityDto` carries the JOINED domain and the computed `fromAddress`,
 * so the UI never has to reassemble `localPart@domain` itself (and cannot get
 * it wrong). Callers must therefore pass the identity row together with its
 * domain name.
 */
function toIdentityDto(
  row: typeof partnerSenderIdentities.$inferSelect,
  domain: string,
): SenderIdentityDto {
  return {
    id: row.id,
    stream: row.stream as PartnerMailStream,
    sendingDomainId: row.sendingDomainId,
    domain,
    localPart: row.localPart,
    displayName: row.displayName ?? null,
    replyTo: row.replyTo ?? null,
    fromAddress: `${row.localPart}@${domain}`,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Capability, spec §7 `GET /`. `eligible` is decided by the SIDE-EFFECT-FREE
 * trust evaluator (`evaluateCapabilityContinuationForState`) rather than
 * `evaluateCapability`, so merely rendering the settings tab never writes a
 * denial audit row or triggers auto-promotion.
 *
 * `supported` is about the INSTANCE (is a provider configured, can its key
 * manage domains); `eligible` is about the PARTNER (allowlist, status, trust).
 * They are separate so the UI can say "your plan/DNS is fine, this server is
 * not set up" without conflating the two.
 */
export async function getSendingDomainsCapability(partner: CapabilityPartnerRow): Promise<SendingDomainsCapabilityDto> {
  const config = getEmailDomainsConfig();
  const provider = getEmailDomainProvider();
  if (!provider || !isPartnerLaneConfigured()) {
    return { supported: false, provider: null, verifiesByDns: false, eligible: false, maxDomains: config.maxPerPartner };
  }

  // Written by the worker's one-shot probe and read across the process boundary
  // through Redis (see keyProbe.ts). `null` means "not probed", never "denied".
  const probe = await readProviderKeyProbe();
  if (probe === 'send_only') {
    return {
      supported: false, provider: provider.id, verifiesByDns: provider.verifiesByDns,
      eligible: false, reason: 'provider_key_send_only', maxDomains: config.maxPerPartner,
    };
  }

  const base = {
    supported: true, provider: provider.id, verifiesByDns: provider.verifiesByDns,
    maxDomains: config.maxPerPartner,
  };

  if (partner.status !== 'active') {
    return { ...base, eligible: false, reason: 'partner_inactive' };
  }
  if (config.partnerAllowlist.length > 0 && !config.partnerAllowlist.includes(partner.id)) {
    return { ...base, eligible: false, reason: 'not_allowlisted' };
  }
  const decision = evaluateCapabilityContinuationForState(
    'custom_sending_domain',
    { partnerId: partner.id },
    { trustState: partner.trustState, probationEnrollments: partner.probationEnrollments },
  );
  if (!decision.allow) {
    return { ...base, eligible: false, reason: decision.reason };
  }
  return { ...base, eligible: true };
}

export async function listSendingDomains(partner: CapabilityPartnerRow): Promise<SendingDomainsListResponse> {
  const capability = await getSendingDomainsCapability(partner);
  if (!isPartnerLaneConfigured()) return { capability, domains: [], identities: [] };

  // Ambient partner-scoped RLS context: these are the caller's OWN rows, and
  // breeze_has_partner_access(partner_id) is exactly the boundary we want.
  const domains = await db
    .select()
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.partnerId, partner.id))
    .orderBy(desc(partnerSendingDomains.createdAt));
  // Joined, because SenderIdentityDto carries `domain` and `fromAddress`.
  const identities = await db
    .select({ identity: partnerSenderIdentities, domain: partnerSendingDomains.domain })
    .from(partnerSenderIdentities)
    .innerJoin(partnerSendingDomains, eq(partnerSendingDomains.id, partnerSenderIdentities.sendingDomainId))
    .where(eq(partnerSenderIdentities.partnerId, partner.id));

  return {
    capability,
    domains: domains.map(toDomainDto),
    identities: identities.map((r) => toIdentityDto(r.identity, r.domain)),
  };
}

function requireProvider(): NonNullable<ReturnType<typeof getEmailDomainProvider>> {
  const provider = getEmailDomainProvider();
  if (!provider || !isPartnerLaneConfigured()) {
    throw new SendingDomainServiceError(
      'sending_domains_unsupported', 'Custom sending domains are not available on this Breeze instance.', 404,
    );
  }
  return provider;
}

export async function createSendingDomain(input: { partnerId: string; domain: string; userId: string }): Promise<SendingDomainDto> {
  requireProvider();

  // W02 returns a DISCRIMINATED UNION, not `string | null`, so the rejection
  // reason reaches the UI instead of a generic "invalid".
  const normalized = normalizeSendingDomain(input.domain);
  if (!normalized.ok) {
    throw new SendingDomainServiceError(
      'domain_invalid', `Enter a valid domain name, for example mail.yourdomain.com (${normalized.reason}).`, 400,
    );
  }
  const domain = normalized.domain;
  try {
    assertSendingDomainAllowed(domain);
  } catch (err) {
    if (err instanceof SendingDomainPolicyError) {
      throw new SendingDomainServiceError('domain_invalid', `This domain cannot be used for sending (${err.reason}).`, 400);
    }
    throw err;
  }

  const config = getEmailDomainsConfig();
  // READ-THEN-INSERT: two concurrent creates can both pass this count and take
  // the partner one over maxPerPartner. Deliberately not locked — the 5/day
  // create limiter below bounds the overshoot to a handful of rows a day, and
  // the alternative (a partner-level advisory lock or a count trigger) costs
  // more than the worst case is worth.
  const [existing] = await db
    .select({ count: count() })
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.partnerId, input.partnerId));
  if ((existing?.count ?? 0) >= config.maxPerPartner) {
    throw new SendingDomainServiceError(
      'domain_limit_reached', `This account can hold ${config.maxPerPartner} sending domains. Remove one first.`, 409,
    );
  }

  const rate = await rateLimiter(
    getRedis(), `rl:sending-domains:create:${input.partnerId}`, CREATE_LIMIT_PER_DAY, CREATE_WINDOW_SECONDS,
  );
  if (!rate.allowed) {
    throw new SendingDomainServiceError('rate_limited', 'Too many sending domains added today. Try again tomorrow.', 429);
  }

  // Spec §3.4: refuse a domain another partner already owns INBOUND, so the two
  // seams cannot disagree about who owns a name. partner_inbound_domains is
  // partner-axis, so a partner-scoped context sees ZERO rows for another
  // partner's entry and this check would silently pass — the sanctioned escape
  // for exactly this read is readWithPartnerAxisVisibility. The lookup key is
  // the requested domain; no partner id from request input is used as an axis.
  const inbound = await readWithPartnerAxisVisibility(() => db
    .select({ partnerId: partnerInboundDomains.partnerId })
    .from(partnerInboundDomains)
    .where(eq(partnerInboundDomains.domain, domain))
    .limit(1));
  if (inbound[0] && inbound[0].partnerId !== input.partnerId) {
    throw new SendingDomainServiceError('domain_unavailable', DOMAIN_UNAVAILABLE_MESSAGE, 409);
  }

  // `onConflictDoNothing` rather than catch-23505: a unique violation raised on
  // the request's own withDbAccessContext transaction ABORTS it even when
  // caught, and the mapped 409 then surfaces as a 500 at commit (utils/pgErrors.ts:42,
  // prod incident 2026-09-15). Zero returned rows is the race-safe conflict
  // signal and nothing is ever raised.
  const [created] = await db
    .insert(partnerSendingDomains)
    .values({
      partnerId: input.partnerId,
      domain,
      provider: requireProvider().id,
      providerRegion: config.region,
      status: 'provisioning',
      statusChangedAt: new Date(),
      nextCheckAt: new Date(),
      createdBy: input.userId,
    })
    .onConflictDoNothing({ target: partnerSendingDomains.domain })
    .returning();
  if (!created) {
    throw new SendingDomainServiceError('domain_unavailable', DOMAIN_UNAVAILABLE_MESSAGE, 409);
  }

  // The write above is awaited and its row exists; the enqueue is the next
  // statement rather than a hook inside the transaction callback, because the
  // repo has no after-commit helper. The worst case if the request transaction
  // later rolls back is one sync job that finds no row and returns 'not_found'.
  await enqueueSyncDomain(created.id);
  return toDomainDto(created);
}

export async function requestDomainCheck(input: { partnerId: string; domainId: string }): Promise<SendingDomainDto> {
  requireProvider();

  // OWNERSHIP FIRST, limiter second, and the limiter is keyed by PARTNER as
  // well as domain. Consuming the budget before the ownership check let any
  // authenticated partner burn another partner's 1/min allowance by replaying a
  // guessed domain id — they still got a 404, but the owner got a 429.
  const [row] = await db
    .select()
    .from(partnerSendingDomains)
    .where(and(eq(partnerSendingDomains.id, input.domainId), eq(partnerSendingDomains.partnerId, input.partnerId)))
    .limit(1);
  if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);

  const rate = await rateLimiter(
    getRedis(), `rl:sending-domains:check:${input.partnerId}:${input.domainId}`, CHECK_LIMIT_PER_MINUTE, CHECK_WINDOW_SECONDS,
  );
  if (!rate.allowed) {
    throw new SendingDomainServiceError('rate_limited', 'You can check a domain once a minute. Try again shortly.', 429);
  }

  if (row.status === 'suspended' || row.status === 'removing') {
    throw new SendingDomainServiceError('domain_not_sendable', 'This domain cannot be checked in its current state.', 409);
  }

  const now = new Date();
  const patch: Partial<typeof partnerSendingDomains.$inferInsert> = { checkRequestedAt: now, nextCheckAt: now };
  if (row.status === 'failed') {
    // Retry inside the window (spec §7). The DNS records are deliberately NOT
    // cleared: handing the partner a second set would invalidate whatever they
    // already published.
    patch.status = row.providerDomainId ? 'pending' : 'provisioning';
    patch.statusReason = null;
    patch.statusChangedAt = now;
    patch.checkAttempts = 0;
  }

  const [updated] = await db
    .update(partnerSendingDomains)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(partnerSendingDomains.id, input.domainId), eq(partnerSendingDomains.partnerId, input.partnerId)))
    .returning();
  if (!updated) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);

  await enqueueSyncDomain(input.domainId);
  return toDomainDto(updated);
}

export async function requestDomainRemoval(input: { partnerId: string; domainId: string }): Promise<void> {
  requireProvider();

  // Load-and-guard before the write. A `suspended` row must NOT be removable:
  // the domain name is unique platform-wide, so deleting it would free the name
  // and let the same partner re-create it as a fresh `pending` row — undoing a
  // platform suspension from a partner-facing route (spec §5.2, §9.1).
  const [existing] = await db
    .select({ status: partnerSendingDomains.status })
    .from(partnerSendingDomains)
    .where(and(eq(partnerSendingDomains.id, input.domainId), eq(partnerSendingDomains.partnerId, input.partnerId)))
    .limit(1);
  if (!existing) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  if (existing.status === 'suspended') {
    throw new SendingDomainServiceError(
      'domain_not_sendable', 'This domain cannot be removed in its current state.', 409,
    );
  }

  const now = new Date();
  const [updated] = await db
    .update(partnerSendingDomains)
    .set({ status: 'removing', statusReason: 'user_removed', statusChangedAt: now, nextCheckAt: now, updatedAt: sql`now()` })
    .where(and(eq(partnerSendingDomains.id, input.domainId), eq(partnerSendingDomains.partnerId, input.partnerId)))
    .returning();
  if (!updated) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  // The worker does the provider delete and the row delete, in that order, so
  // the BEFORE DELETE guard can never be bypassed from a request path.
  await enqueueSyncDomain(input.domainId);
}

/**
 * Spec §4.4, enforced by W02's SHARED schemas rather than a second regex here:
 * `senderLocalPartSchema` carries the pattern, the 64-char bound, the
 * consecutive-dot rule and RESERVED_SENDER_LOCAL_PARTS; `senderDisplayNameSchema`
 * carries the 78-char bound and the "display name that looks like another
 * address" spoof check. One definition, shared with the web form, so the two
 * cannot drift.
 */
function assertIdentityShape(localPart: string, displayName?: string | null): void {
  const local = senderLocalPartSchema.safeParse(localPart.trim().toLowerCase());
  if (!local.success) {
    throw new SendingDomainServiceError('domain_invalid', 'Enter a valid mailbox name, for example support.', 400);
  }
  if (displayName !== undefined && displayName !== null && displayName.trim() !== '') {
    const name = senderDisplayNameSchema.safeParse(displayName.trim());
    if (!name.success) {
      throw new SendingDomainServiceError('domain_invalid', 'The display name cannot contain an email address or a link.', 400);
    }
  }
}

export async function upsertSenderIdentity(input: {
  partnerId: string; stream: PartnerMailStream; sendingDomainId: string;
  localPart: string; displayName?: string | null; replyTo?: string | null; userId: string;
}): Promise<SenderIdentityDto> {
  requireProvider();

  const [domain] = await db
    .select({
      id: partnerSendingDomains.id,
      status: partnerSendingDomains.status,
      domain: partnerSendingDomains.domain,
    })
    .from(partnerSendingDomains)
    .where(and(
      eq(partnerSendingDomains.id, input.sendingDomainId),
      eq(partnerSendingDomains.partnerId, input.partnerId),
    ))
    .limit(1);
  if (!domain) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  // at_risk is allowed: mail still flows there, with fallback (spec §5.2).
  if (domain.status !== 'verified' && domain.status !== 'at_risk') {
    throw new SendingDomainServiceError('domain_not_sendable', 'Verify this domain before using it as a sender.', 409);
  }

  assertIdentityShape(input.localPart, input.displayName);
  const localPart = input.localPart.trim().toLowerCase();
  const now = new Date();

  const [row] = await db
    .insert(partnerSenderIdentities)
    .values({
      partnerId: input.partnerId, sendingDomainId: input.sendingDomainId, stream: input.stream,
      localPart, displayName: input.displayName ?? null, replyTo: input.replyTo ?? null,
      updatedBy: input.userId,
    })
    .onConflictDoUpdate({
      target: [partnerSenderIdentities.partnerId, partnerSenderIdentities.stream],
      set: {
        sendingDomainId: input.sendingDomainId, localPart,
        displayName: input.displayName ?? null, replyTo: input.replyTo ?? null,
        updatedBy: input.userId, updatedAt: now,
      },
    })
    .returning();
  if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  return toIdentityDto(row, domain.domain);
}

export async function deleteSenderIdentity(input: { partnerId: string; stream: PartnerMailStream }): Promise<void> {
  requireProvider();
  // Idempotent: removing a stream that has no identity already leaves it on the
  // platform sender, which is the requested end state.
  await db
    .delete(partnerSenderIdentities)
    .where(and(
      eq(partnerSenderIdentities.partnerId, input.partnerId),
      eq(partnerSenderIdentities.stream, input.stream),
    ));
}

// ---------------------------------------------------------------------------
// Platform admin. All of these run cross-partner, so they take SYSTEM scope —
// the caller has already passed platformAdminMiddleware + requireMfa().
// ---------------------------------------------------------------------------

export async function listAllSendingDomains(opts: { limit: number }): Promise<Array<SendingDomainDto & { partnerId: string; partnerName: string }>> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ domain: partnerSendingDomains, partnerName: partners.name })
      .from(partnerSendingDomains)
      .innerJoin(partners, eq(partners.id, partnerSendingDomains.partnerId))
      .orderBy(desc(partnerSendingDomains.statusChangedAt))
      .limit(opts.limit);
    return rows.map((r) => ({ ...toDomainDto(r.domain), partnerId: r.domain.partnerId, partnerName: r.partnerName }));
  }, 'sendingDomainsAdminList'));
}

export interface SendingPartnerMetricsDto {
  windowDays: number;
  /** GREATEST(sent, delivered + bounced + failed) — see deliveryStats.ts. */
  messages: number;
  delivered: number;
  bounced: number;
  complained: number;
  failed: number;
  suppressed: number;
  /** 0..1. */
  bounceRate: number;
}

const ZERO_METRICS: SendingPartnerMetricsDto = Object.freeze({
  windowDays: STATS_WINDOW_DAYS,
  messages: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, suppressed: 0, bounceRate: 0,
});

/**
 * The platform-admin list with each partner's 7-day deliverability attached
 * (spec §9.3).
 *
 * TWO queries total, whatever the page size: the domain list, then ONE grouped
 * rollup over partner_sending_daily_stats for the whole fleet, joined in memory
 * by partner id. Fetching per partner would be an N+1 on a page that exists to
 * be scanned, and two domains of the same partner would fetch the same window
 * twice.
 */
export async function listAllSendingDomainsWithMetrics(
  opts: { limit: number },
): Promise<Array<SendingDomainDto & { partnerId: string; partnerName: string; metrics: SendingPartnerMetricsDto }>> {
  // SEQUENTIAL, not Promise.all: each call opens its own
  // withSystemDbAccessContext transaction, so running them concurrently pins
  // three pooled connections per admin GET (this request's plus both children)
  // instead of two — the shape that hangs at concurrency >= pool size.
  const domains = await listAllSendingDomains(opts);
  const windowStats = await loadAllPartnerSendingWindowStats();
  const byPartner = new Map(windowStats.map((s) => [s.partnerId, s]));
  return domains.map((domain) => {
    const stats = byPartner.get(domain.partnerId);
    return {
      ...domain,
      metrics: stats
        ? {
            windowDays: STATS_WINDOW_DAYS,
            messages: stats.messages,
            delivered: stats.delivered,
            bounced: stats.bounced,
            complained: stats.complained,
            failed: stats.failed,
            suppressed: stats.suppressed,
            bounceRate: stats.bounceRate,
          }
        : { ...ZERO_METRICS },
    };
  });
}

async function setAdminStatus(domainId: string, patch: Partial<typeof partnerSendingDomains.$inferInsert>): Promise<void> {
  const updated = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .update(partnerSendingDomains)
    .set({ ...patch, statusChangedAt: new Date(), updatedAt: sql`now()` })
    .where(eq(partnerSendingDomains.id, domainId))
    .returning(), 'sendingDomainsAdminStatus'));
  if (updated.length === 0) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  await enqueueSyncDomain(domainId);
}

/**
 * The kill switch (spec §9.1). Sending stops on the next send, because
 * resolution reads the row.
 *
 * `statusReason` defaults to `platform_suspended` — the admin route's meaning
 * and W03's original behaviour, so that call site is unchanged. W06's
 * automatic suspension passes `abuse_auto` (spec §9.3). The status reason is
 * the ONLY difference between the two: both stop sending, both keep the
 * provider domain, and neither can be undone by the partner.
 *
 * This function deliberately does NOT write an audit row or send the status
 * notice. The admin route already writes its own `writeRouteAudit` with the
 * human actor, and the automatic path writes a system audit row and mails from
 * services/emailDomains/autoSuspend.ts, which is the only caller that has the
 * partner id, the domain name and `created_by` in hand.
 */
export async function suspendSendingDomain(
  domainId: string,
  statusReason: 'platform_suspended' | 'abuse_auto' = 'platform_suspended',
): Promise<void> {
  await setAdminStatus(domainId, { status: 'suspended', statusReason, nextCheckAt: new Date() });
}

export async function unsuspendSendingDomain(domainId: string): Promise<void> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ providerDomainId: partnerSendingDomains.providerDomainId })
    .from(partnerSendingDomains)
    .where(eq(partnerSendingDomains.id, domainId))
    .limit(1), 'sendingDomainsAdminUnsuspendLoad'));
  if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);
  // Back to the state the worker can advance from: a row that never got a
  // provider object must re-provision; one that has it only needs a poll.
  await setAdminStatus(domainId, {
    status: row.providerDomainId ? 'pending' : 'provisioning',
    statusReason: null, checkAttempts: 0, nextCheckAt: new Date(),
  });
}

/**
 * Drop Breeze's claim on a name without waiting for the partner (spec §7, §13).
 * Order is the same as the worker's: outbox row (MANAGED only) → null the
 * handle → delete the row, so the BEFORE DELETE guard is satisfied and the
 * provider object is still released after the partner rows are gone.
 *
 * `provider_managed = false` gets NO outbox row. That domain object pre-existed
 * Breeze and deleting it could take down the operator's primary sender.
 */
export async function forceReleaseSendingDomain(domainId: string): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(partnerSendingDomains)
      .where(eq(partnerSendingDomains.id, domainId))
      .limit(1);
    if (!row) throw new SendingDomainServiceError('not_found', 'Sending domain not found.', 404);

    if (row.providerManaged && row.providerDomainId) {
      await db
        .insert(emailProviderDomainReleases)
        .values({
          provider: row.provider,
          providerDomainId: row.providerDomainId,
          providerRegion: row.providerRegion,
          domain: row.domain,
          reason: 'force_release',   // one of the four values the CHECK allows
        })
        .onConflictDoNothing({
          target: [emailProviderDomainReleases.provider, emailProviderDomainReleases.providerDomainId],
        });
    }
    await db
      .update(partnerSendingDomains)
      .set({ providerDomainId: null, updatedAt: sql`now()` })
      .where(eq(partnerSendingDomains.id, domainId));
    await db.delete(partnerSendingDomains).where(eq(partnerSendingDomains.id, domainId));
  }, 'sendingDomainsForceRelease'));
}
