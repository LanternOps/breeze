// Wisp W04 (web): grant handshake + thread read shared by the step-up modal
// (create / refresh) and the thread header. Server contracts: W02
// `routes/wisp.ts` (grants) and W04a `routes/wispThreads.ts` (thread).
import { fetchWithAuth } from '../stores/auth';
import type { WispGrantStatus, WispState } from '../stores/aiStore';
import { extractApiError } from './apiError';
import { mintStepUpGrant, type StepUpReauth } from './mfaStepUp';
import { pickReauthTier, type ReauthTier } from '../components/settings/StepUpPrompt';

/** The factor the step-up will ask for (same discovery as TopologyArmStepUp). */
export async function discoverStepUpTier(): Promise<ReauthTier> {
  const [user, passkeys] = await Promise.all([fetchWithAuth('/users/me'), fetchWithAuth('/auth/passkeys')]);
  if (!user.ok || !passkeys.ok) throw new Error('factor discovery failed');
  const me = (await user.json()) as { mfaMethod?: string | null } | null;
  const keys = (await passkeys.json()) as unknown;
  const list = Array.isArray(keys) ? keys : (keys as { passkeys?: unknown[] } | null)?.passkeys;
  if (!me || !Array.isArray(list)) throw new Error('factor discovery failed');
  return pickReauthTier(list.length, me.mfaMethod ?? null);
}

/** A preview the server refused (entitlement, scope, flag off) — message is the server's. */
export class WispPreviewError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'WispPreviewError';
  }
}

/**
 * w00 A4: the `wisp_grant` step-up is bound to the server-computed ceiling
 * hash, so every create/refresh is `GET /wisp/grants/preview` → mint. The
 * hash is re-read on every attempt: a reach change between two attempts must
 * produce a new proof, never a replay of the old one.
 */
export async function mintWispGrantStepUp(input: {
  partnerId: string;
  orgId: string | null;
  reauth: StepUpReauth;
}): Promise<string> {
  const query = input.orgId ? `?orgId=${encodeURIComponent(input.orgId)}` : '';
  const res = await fetchWithAuth(`/wisp/grants/preview${query}`);
  const body = (await res.json().catch(() => null)) as { ceilingHash?: unknown; code?: unknown } | null;
  if (!res.ok) {
    throw new WispPreviewError(
      extractApiError(body, 'Could not prepare the Wisp grant.'),
      res.status,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  if (typeof body?.ceilingHash !== 'string') throw new WispPreviewError('Could not prepare the Wisp grant.', res.status);
  return mintStepUpGrant({
    operation: 'wisp_grant',
    resource: { partnerId: input.partnerId, orgId: input.orgId, requestedCeilingHash: body.ceilingHash },
    reauth: input.reauth,
  });
}

const STATUSES: ReadonlySet<string> = new Set<WispGrantStatus>(['active', 'paused', 'revoked', 'expired']);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * `GET /wisp/thread` → the panel's Wisp state. Tolerant of fields it does not
 * know (W05 adds `spentTodayCents`/`budgetResetsAt`, A32); null when the
 * required ids or the status are missing.
 */
export function wispStateFromThread(body: unknown): NonNullable<WispState> | null {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  const thread = data?.thread as Record<string, unknown> | undefined;
  const grant = data?.grant as Record<string, unknown> | undefined;
  const threadId = str(thread?.id);
  const grantId = str(grant?.id);
  const status = str(grant?.status);
  const expiresAt = str(grant?.expiresAt);
  if (!threadId || !grantId || !status || !STATUSES.has(status) || !expiresAt) return null;
  return {
    grantId,
    threadId,
    scopeOrgId: str(grant?.orgId),
    focusOrgId: str(thread?.focusOrgId),
    focusOrgName: str(data?.focusOrgName),
    status: status as WispGrantStatus,
    expiresAt,
    summary: str(thread?.summary) ?? '',
    // w00 A6 column defaults when an older payload omits them.
    budgetCentsPerDay: int(grant?.budgetCentsPerDay, 200),
    floorTickMinutes: int(grant?.floorTickMinutes, 30),
    wideningAvailable: data?.wideningAvailable === true,
  };
}

/** Read the caller's active grant + thread for a scope (null orgId = partner-wide). */
export async function fetchWispThread(orgId: string | null): Promise<NonNullable<WispState>> {
  const res = await fetchWithAuth(orgId ? `/wisp/thread?orgId=${encodeURIComponent(orgId)}` : '/wisp/thread');
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(extractApiError(body, 'Could not open the Wisp thread.'));
  const state = wispStateFromThread(body);
  if (!state) throw new Error('Could not open the Wisp thread.');
  return state;
}
