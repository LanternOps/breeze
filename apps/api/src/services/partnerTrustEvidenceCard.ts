import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { auditLogs, devices, organizations, partners, users } from '../db/schema';
import { sendOpsAlert } from './opsAlerts';
import { getRedis } from './redis';

export type TrustAction = 'approve' | 'suspend';

export interface EvidenceCard {
  partner: {
    id: string;
    name: string;
    plan: string;
    status: string;
    trustState: string;
  };
  signup: { ip: string | null; ipClass: string; asn: number | null };
  emailDomain: { domain: string | null; ageDays: null; hasMx: boolean | null };
  identity: {
    userName: string | null;
    userEmail: string | null;
    cardholderName: string | null;
    namesMatch: boolean | null;
  };
  billing: {
    distinctPaymentMethods: number;
    failedAttempts: number;
    region: string | null;
  };
  devices: Array<{
    hostname: string;
    enrollmentIpClass: string;
    isVirtual: boolean;
    enrollmentIp: string | null;
  }>;
  denials24h: number;
  matchedSuspendedAxes: Array<'email_domain' | 'billing_card_fingerprint'>;
}

export interface TrustActionTokenPayload {
  partnerId: string;
  action: TrustAction;
  operatorUserId: string;
  iat: number;
  exp: number;
  jti: string;
}

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MX_TIMEOUT_MS = 2_000;
const tokenReservations = new Map<string, Promise<void>>();

function emailDomain(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  return at > 0 ? email!.slice(at + 1).trim().toLowerCase() || null : null;
}

function normalizedName(value: string | null): string | null {
  const normalized = value?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return normalized || null;
}

async function resolveMx(domain: string | null): Promise<boolean | null> {
  if (!domain) return null;
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('MX lookup timed out')), MX_TIMEOUT_MS);
      }),
    ]);
    return result.length > 0;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function buildEvidenceCard(partnerId: string): Promise<EvidenceCard> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [partner] = await db.select({
      id: partners.id,
      name: partners.name,
      plan: partners.plan,
      status: partners.status,
      trustState: partners.trustState,
      signupIp: partners.signupIp,
      signupIpClass: partners.signupIpClass,
      signupIpAsn: partners.signupIpAsn,
      billingCardholderName: partners.billingCardholderName,
      billingCardFingerprint: partners.billingCardFingerprint,
      billingDistinctPaymentMethods: partners.billingDistinctPaymentMethods,
      billingFailedAttempts: partners.billingFailedAttempts,
      billingAddressRegion: partners.billingAddressRegion,
    }).from(partners).where(eq(partners.id, partnerId)).limit(1);

    if (!partner) throw new Error(`Partner not found: ${partnerId}`);

    const [primaryUser] = await db.select({
      name: users.name,
      email: users.email,
    }).from(users).where(eq(users.partnerId, partnerId)).orderBy(asc(users.createdAt)).limit(1);

    const [deviceRows, denialRows] = await Promise.all([
      db.select({
        hostname: devices.hostname,
        enrollmentIpClass: devices.enrollmentIpClass,
        isVirtual: devices.isVirtual,
        enrollmentIp: devices.enrollmentIp,
      }).from(devices)
        .innerJoin(organizations, eq(devices.orgId, organizations.id))
        .where(eq(organizations.partnerId, partnerId)),
      db.select({ count: sql<number>`count(*)::int` }).from(auditLogs).where(and(
        eq(auditLogs.action, 'partner.trust.capability_denied'),
        eq(auditLogs.resourceId, partnerId),
        gte(auditLogs.timestamp, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      )),
    ]);

    const domain = emailDomain(primaryUser?.email);
    const axes = new Set<'email_domain' | 'billing_card_fingerprint'>();
    if (partner.billingAddressRegion) {
      const suspended = await db.select({
        id: partners.id,
        billingCardFingerprint: partners.billingCardFingerprint,
      }).from(partners).where(and(
        eq(partners.status, 'suspended'),
        eq(partners.billingAddressRegion, partner.billingAddressRegion),
      ));
      const suspendedIds = suspended.filter((row) => row.id !== partnerId).map((row) => row.id);
      if (partner.billingCardFingerprint && suspended.some((row) =>
        row.id !== partnerId && row.billingCardFingerprint === partner.billingCardFingerprint
      )) axes.add('billing_card_fingerprint');

      if (domain && suspendedIds.length > 0) {
        const suspendedUsers = await db.select({
          partnerId: users.partnerId,
          email: users.email,
        }).from(users).where(inArray(users.partnerId, suspendedIds));
        if (suspendedUsers.some((row) => emailDomain(row.email) === domain)) {
          axes.add('email_domain');
        }
      }
    }

    const userName = primaryUser?.name ?? null;
    const cardholderName = partner.billingCardholderName;
    const normalizedUser = normalizedName(userName);
    const normalizedCardholder = normalizedName(cardholderName);
    return {
      partner: {
        id: partner.id,
        name: partner.name,
        plan: partner.plan,
        status: partner.status,
        trustState: partner.trustState,
      },
      signup: { ip: partner.signupIp, ipClass: partner.signupIpClass, asn: partner.signupIpAsn },
      emailDomain: {
        domain,
        ageDays: null,
        hasMx: await resolveMx(domain),
      },
      identity: {
        userName,
        userEmail: primaryUser?.email ?? null,
        cardholderName,
        namesMatch: normalizedUser && normalizedCardholder ? normalizedUser === normalizedCardholder : null,
      },
      billing: {
        distinctPaymentMethods: partner.billingDistinctPaymentMethods,
        failedAttempts: partner.billingFailedAttempts,
        region: partner.billingAddressRegion,
      },
      devices: deviceRows,
      denials24h: denialRows[0]?.count ?? 0,
      matchedSuspendedAxes: [...axes],
    };
  }, 'partnerTrustEvidenceCard.build'));
}

function tokenSecret(): string {
  const secret = process.env.TRUST_ACTION_TOKEN_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error('JWT_SECRET or TRUST_ACTION_TOKEN_SECRET is required to mint trust action tokens');
  return secret;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(input: string): string {
  return createHmac('sha256', tokenSecret()).update(input).digest('base64url');
}

export function mintTrustActionToken(
  partnerId: string,
  action: TrustAction,
  operatorUserId: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: TrustActionTokenPayload = {
    partnerId,
    action,
    operatorUserId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    jti: randomUUID(),
  };
  const unsigned = `${encode({ alg: 'HS256', typ: 'TRUSTACT' })}.${encode(payload)}`;
  const token = `${unsigned}.${sign(unsigned)}`;
  const redis = getRedis();
  if (!redis) throw new Error('Redis unavailable while minting trust action token');
  const reservation = redis.set(`trustact:${payload.jti}`, 'active', 'EX', TOKEN_TTL_SECONDS)
    .then(() => undefined)
    .finally(() => tokenReservations.delete(payload.jti));
  // The reservation remains awaitable by verification/email delivery; attach
  // a rejection handler so a caller that only mints cannot cause an unhandled
  // rejection if Redis fails before the token is handed off.
  void reservation.catch(() => undefined);
  tokenReservations.set(payload.jti, reservation);
  return token;
}

function parsePayload(token: string): TrustActionTokenPayload | null {
  const [header, body, signature, extra] = token.split('.');
  if (!header || !body || !signature || extra) return null;
  const expected = Buffer.from(sign(`${header}.${body}`), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const headerValue = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>;
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<TrustActionTokenPayload>;
    if (headerValue.alg !== 'HS256' || headerValue.typ !== 'TRUSTACT') return null;
    if (typeof value.partnerId !== 'string' || (value.action !== 'approve' && value.action !== 'suspend') ||
      typeof value.operatorUserId !== 'string' || typeof value.iat !== 'number' || typeof value.exp !== 'number' ||
      typeof value.jti !== 'string') return null;
    return value as TrustActionTokenPayload;
  } catch {
    return null;
  }
}

export async function verifyTrustActionToken(
  token: string,
  operatorUserId: string,
): Promise<TrustActionTokenPayload | null> {
  const payload = parsePayload(token);
  if (!payload || payload.exp <= Math.floor(Date.now() / 1000) || payload.operatorUserId !== operatorUserId) return null;
  await tokenReservations.get(payload.jti);
  const redis = getRedis();
  if (!redis || await redis.get(`trustact:${payload.jti}`) !== 'active') return null;
  return payload;
}

export async function consumeTrustActionToken(jti: string): Promise<boolean> {
  await tokenReservations.get(jti);
  const redis = getRedis();
  if (!redis) return false;
  const result = await redis.eval(
    "if redis.call('GET', KEYS[1]) == 'active' then redis.call('SET', KEYS[1], 'used', 'KEEPTTL'); return 1 else return 0 end",
    1,
    `trustact:${jti}`,
  );
  return result === 1;
}

function renderCardText(card: EvidenceCard): string {
  const devicesText = card.devices.length
    ? card.devices.map((d) => `- ${d.hostname}: ${d.enrollmentIp ?? 'unknown'} (${d.enrollmentIpClass}, virtual=${d.isVirtual})`).join('\n')
    : '- none';
  return [
    `Partner: ${card.partner.name} (${card.partner.id})`,
    `Plan/status/trust: ${card.partner.plan} / ${card.partner.status} / ${card.partner.trustState}`,
    `Signup IP: ${card.signup.ip ?? 'unknown'} (${card.signup.ipClass}, ASN ${card.signup.asn ?? 'unknown'})`,
    `Email domain: ${card.emailDomain.domain ?? 'unknown'} (age: unknown; MX: ${card.emailDomain.hasMx ?? 'unknown'})`,
    `Cardholder/user: ${card.identity.cardholderName ?? 'unknown'} / ${card.identity.userName ?? 'unknown'} (match: ${card.identity.namesMatch ?? 'unknown'})`,
    `Billing: ${card.billing.distinctPaymentMethods} distinct payment methods; ${card.billing.failedAttempts} failed attempts`,
    `Capability denials (24h): ${card.denials24h}`,
    `Matched suspended axes (same region): ${card.matchedSuspendedAxes.join(', ') || 'none'}`,
    'Devices:', devicesText,
  ].join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function publicBaseUrl(): string {
  const value = process.env.PUBLIC_URL || process.env.PUBLIC_APP_URL || process.env.PUBLIC_API_URL;
  if (value?.trim()) return value.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') throw new Error('PUBLIC_URL, PUBLIC_APP_URL, or PUBLIC_API_URL is required');
  return 'http://localhost:3000';
}

export async function sendEvidenceCard(
  partnerId: string,
  trigger: 'probation_watch' | 'review_requested' | 'restricted',
): Promise<void> {
  const card = await buildEvidenceCard(partnerId);
  const operatorEmail = process.env.OPS_ALERT_EMAIL?.split(',')[0]?.trim().toLowerCase();
  const admins = await runOutsideDbContext(() => withSystemDbAccessContext(() => db.select({
    id: users.id,
    email: users.email,
  }).from(users).where(eq(users.isPlatformAdmin, true)).orderBy(asc(users.createdAt)), 'partnerTrustEvidenceCard.operator'));
  const operator = admins.find((admin) => operatorEmail && admin.email.toLowerCase() === operatorEmail) ?? admins[0];
  if (!operator) throw new Error('No platform admin exists for trust action links');

  const approveToken = mintTrustActionToken(partnerId, 'approve', operator.id);
  const suspendToken = mintTrustActionToken(partnerId, 'suspend', operator.id);
  const approvePayload = parsePayload(approveToken)!;
  const suspendPayload = parsePayload(suspendToken)!;
  await Promise.all([tokenReservations.get(approvePayload.jti), tokenReservations.get(suspendPayload.jti)]);

  const base = publicBaseUrl();
  const approveUrl = `${base}/admin/trust/act?token=${encodeURIComponent(approveToken)}`;
  const suspendUrl = `${base}/admin/trust/act?token=${encodeURIComponent(suspendToken)}`;
  const summary = renderCardText(card);
  const body = `${summary}\n\nApprove: ${approveUrl}\nSuspend: ${suspendUrl}`;
  const html = `<h2>${escapeHtml(card.partner.name)} trust evidence</h2><pre>${escapeHtml(summary)}</pre>` +
    `<p><a href="${escapeHtml(approveUrl)}">Approve</a> &nbsp; <a href="${escapeHtml(suspendUrl)}">Suspend</a></p>`;
  await sendOpsAlert({ title: `Partner trust review: ${card.partner.name} (${trigger})`, body, html });
}

export function renderEvidenceCardSummary(card: EvidenceCard): string {
  return renderCardText(card);
}
