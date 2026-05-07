import * as SecureStore from 'expo-secure-store';
import type { ApprovalRequest } from './approvals';

const KEY = 'breeze.approvals.cache.v1';

// Cache last /pending response so cold open with no network still renders the queue.

async function clearCache(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY);
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
    await clearCache();
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
