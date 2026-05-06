import * as SecureStore from 'expo-secure-store';
import type { ApprovalRequest } from './approvals';

const KEY = 'breeze.approvals.cache.v1';

// Brief promise: "approvals work offline if already delivered."
// Cache the most recent /pending response so a cold open with no network
// can still render the queue.

export async function readCachedApprovals(): Promise<ApprovalRequest[]> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ApprovalRequest[];
    return parsed.filter((a) => new Date(a.expiresAt).getTime() > Date.now());
  } catch {
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
