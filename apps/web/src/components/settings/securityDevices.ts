import type { ApproverDevice } from '../../stores/authenticator';

// Moved here from ProfilePage.tsx (which now imports it back), gaining the
// Task 3 field.
export type PasskeySummary = {
  id: string;
  name: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  credentialId?: string | null;
};

export type SecurityDeviceRow = {
  key: string;
  name: string;
  createdAt?: string;
  lastUsedAt?: string | null;
  passkey?: PasskeySummary;
  approver?: ApproverDevice;
};

export function mergeSecurityDevices(
  passkeys: PasskeySummary[],
  approvers: ApproverDevice[]
): SecurityDeviceRow[] {
  const rows: SecurityDeviceRow[] = passkeys.map((p) => ({
    key: `pk-${p.id}`,
    name: p.name || 'Passkey',
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt,
    passkey: p,
  }));
  const byCred = new Map(
    rows.filter((r) => r.passkey?.credentialId).map((r) => [r.passkey!.credentialId as string, r])
  );
  for (const a of approvers) {
    const match = a.credentialId ? byCred.get(a.credentialId) : undefined;
    if (match) {
      match.approver = a;
      // Prefer the more recent activity across both capabilities.
      if (a.lastUsedAt && (!match.lastUsedAt || a.lastUsedAt > match.lastUsedAt)) {
        match.lastUsedAt = a.lastUsedAt;
      }
    } else {
      rows.push({
        key: `ad-${a.id}`,
        name: a.label?.trim() || 'Unnamed device',
        createdAt: a.createdAt,
        lastUsedAt: a.lastUsedAt,
        approver: a,
      });
    }
  }
  return rows;
}
