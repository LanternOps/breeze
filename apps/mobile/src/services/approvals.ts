import * as SecureStore from 'expo-secure-store';
import { getServerUrl } from './serverConfig';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const PREFIX = '/api/v1/mobile/approvals';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_HEADER_VALUE = '1';
const TOKEN_KEY = 'breeze_auth_token';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'reported';

export interface ApprovalRequest {
  id: string;
  requestingClientLabel: string;
  requestingMachineLabel: string | null;
  actionLabel: string;
  actionToolName: string;
  actionArguments: Record<string, unknown>;
  riskTier: RiskTier;
  riskSummary: string;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
}

async function authedFetch(path: string, init?: RequestInit) {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      ...(init?.headers ?? {}),
    },
  });
  return res;
}

export async function fetchPendingApprovals(): Promise<ApprovalRequest[]> {
  const res = await authedFetch(`${PREFIX}/pending`);
  if (!res.ok) throw new Error(`Failed to fetch approvals: ${res.status}`);
  const json = await res.json();
  return json.approvals;
}

export async function fetchApproval(id: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch approval: ${res.status}`);
  const json = await res.json();
  return json.approval;
}

export async function approveRequest(id: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}/approve`, { method: 'POST' });
  if (res.status === 409) throw new Error('ALREADY_DECIDED');
  if (res.status === 410) throw new Error('EXPIRED');
  if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
  const json = await res.json();
  return json.approval;
}

export async function denyRequest(id: string, reason?: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}/deny`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  if (res.status === 409) throw new Error('ALREADY_DECIDED');
  if (res.status === 410) throw new Error('EXPIRED');
  if (!res.ok) throw new Error(`Deny failed: ${res.status}`);
  const json = await res.json();
  return json.approval;
}
