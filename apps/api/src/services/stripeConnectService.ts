// apps/api/src/services/stripeConnectService.ts
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { getConfig } from '../config/validate';
import { getStripe } from './stripeClient';
import { getRedis } from './redis';
import { encryptSecret } from './secretCrypto';

const STATE_TTL_SECONDS = 600;
const STATE_PREFIX = 'stripe:oauth:state:';

function stateKey(state: string) { return `${STATE_PREFIX}${state}`; }

export async function buildOAuthUrl(input: { partnerId: string; userId: string }): Promise<{ url: string }> {
  const cfg = getConfig();
  if (!cfg.STRIPE_CONNECT_CLIENT_ID || !cfg.STRIPE_OAUTH_REDIRECT_URL) {
    throw new Error('Stripe Connect is not configured');
  }
  const redis = getRedis();
  if (!redis) {
    // State binding (CSRF + partner pinning) requires Redis; fail closed.
    throw new Error('Stripe Connect is unavailable (Redis offline)');
  }
  const state = randomBytes(24).toString('hex');
  // Bind state → partner in Redis (CSRF + partner pinning).
  await redis.set(stateKey(state), input.partnerId, 'EX', STATE_TTL_SECONDS);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.STRIPE_CONNECT_CLIENT_ID,
    scope: 'read_write',
    redirect_uri: cfg.STRIPE_OAUTH_REDIRECT_URL,
    state
  });
  return { url: `https://connect.stripe.com/oauth/authorize?${params.toString()}` };
}

export async function consumeState(state: string, partnerId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const stored = await redis.get(stateKey(state));
  await redis.del(stateKey(state));
  if (!stored) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(partnerId);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function completeOAuth(input: { code: string; partnerId: string; userId: string }): Promise<{ stripeAccountId: string }> {
  const resp = await getStripe().oauth.token({ grant_type: 'authorization_code', code: input.code });
  const stripeAccountId = resp.stripe_user_id!;
  await withSystemDbAccessContext(async () => {
    await db.insert(stripeConnectAccounts).values({
      partnerId: input.partnerId,
      stripeAccountId,
      credentials: { accessToken: encryptSecret(resp.access_token ?? null) },
      livemode: Boolean(resp.livemode),
      status: 'connected',
      scope: resp.scope ?? 'read_write',
      connectedBy: input.userId,
      connectedAt: new Date(),
      disconnectedAt: null
    }).onConflictDoUpdate({
      target: stripeConnectAccounts.partnerId,
      set: { stripeAccountId, status: 'connected', livemode: Boolean(resp.livemode),
             connectedBy: input.userId, connectedAt: new Date(), disconnectedAt: null, updatedAt: new Date() }
    });
  });
  return { stripeAccountId };
}

export async function getConnection(partnerId: string) {
  const [row] = await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  return row ?? null;
}

/**
 * Resolve a connection by its Stripe account id. Used by the UNAUTHENTICATED
 * webhook to (a) route a Connect event to its partner and (b) enforce the
 * livemode guard. stripe_connect_accounts is a partner-axis table, so this must
 * run in system context — a bare org/partner-scope read would be silently
 * RLS-filtered to null with no error (the #1375 class).
 */
export async function getConnectionByAccount(stripeAccountId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.stripeAccountId, stripeAccountId)).limit(1);
    return row ?? null;
  });
}

export async function disconnect(partnerId: string): Promise<void> {
  const cfg = getConfig();
  const [row] = await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  if (!row || row.status === 'disconnected') return;
  try {
    await getStripe().oauth.deauthorize({ client_id: cfg.STRIPE_CONNECT_CLIENT_ID!, stripe_user_id: row.stripeAccountId });
  } catch { /* deauthorize is best-effort; we still mark disconnected locally */ }
  await db.update(stripeConnectAccounts)
    .set({ status: 'disconnected', disconnectedAt: new Date(), updatedAt: new Date() })
    .where(eq(stripeConnectAccounts.partnerId, partnerId));
}

/** Webhook-driven disconnect (MSP revoked from their own dashboard). System context. */
export async function markDisconnectedByAccount(stripeAccountId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(stripeConnectAccounts)
      .set({ status: 'disconnected', disconnectedAt: new Date(), updatedAt: new Date() })
      .where(eq(stripeConnectAccounts.stripeAccountId, stripeAccountId));
  });
}
