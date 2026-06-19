import * as SecureStore from 'expo-secure-store';
import type { ApprovalRequest } from './approvals';

export const APPROVAL_CACHE_KEY = 'breeze.approvals.cache.v1';
const KEY = APPROVAL_CACHE_KEY;

// Cache last /pending response so cold open with no network still renders the queue.

/**
 * Delete the persisted approvals cache, propagating any SecureStore error.
 *
 * Use this on the security-teardown path (sign-out) where a failed wipe must be
 * surfaced rather than swallowed — leaving the prior session's approvals cache
 * on-device is the cross-session leak #1415 closed. The swallowing
 * `clearApprovalCache` below is for best-effort/graceful-degradation callers
 * (e.g. resetting a corrupt cache) where a failure is non-sensitive.
 */
export async function clearApprovalCacheOrThrow(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}

export async function clearApprovalCache(): Promise<void> {
  try {
    await clearApprovalCacheOrThrow();
  } catch (err) {
    console.warn('[approvalCache] clear failed', err);
  }
}

export async function readCachedApprovals(): Promise<ApprovalRequest[]> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(KEY);
  } catch (err) {
    // SecureStore unavailable / decrypt failure — degrade gracefully to an empty queue.
    console.warn('[approvalCache] read failed', err);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ApprovalRequest[];
    return parsed.filter((a) => new Date(a.expiresAt).getTime() > Date.now());
  } catch (err) {
    console.warn('[approvalCache] corrupt cache, resetting', err);
    await clearApprovalCache();
    return [];
  }
}

export async function writeCachedApprovals(approvals: ApprovalRequest[]): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(approvals));
  } catch (err) {
    console.warn('[approvalCache] write failed', err);
  }
}

export async function clearCachedApproval(id: string): Promise<void> {
  const cached = await readCachedApprovals();
  await writeCachedApprovals(cached.filter((a) => a.id !== id));
}
