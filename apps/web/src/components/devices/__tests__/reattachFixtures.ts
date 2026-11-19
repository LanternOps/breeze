import type { ReattachCandidate, ReinstallCandidatesView } from '../../../lib/deviceReattach';

/** A 43-character opaque target version, as the API's REATTACH_TARGET_VERSION_PATTERN expects. */
export const TARGET_VERSION = 'v'.repeat(43);

export const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
export const TARGET_ID = '22222222-2222-4222-8222-222222222222';

export function reattachSource(overrides: Partial<ReinstallCandidatesView['source']> = {}): ReinstallCandidatesView['source'] {
  return {
    deviceId: SOURCE_ID,
    hostname: 'LAPTOP-NEW',
    displayName: null,
    osType: 'windows',
    osVersion: '11',
    agentVersion: '0.120.0',
    status: 'online',
    enrolledAt: '2026-11-10T10:00:00.000Z',
    createdAt: '2026-11-10T10:00:00.000Z',
    lastSeenAt: '2026-11-11T10:00:00.000Z',
    decommissionedAt: null,
    serialNumber: 'SER-1',
    manufacturer: 'Dell',
    model: 'XPS 13',
    systemUuid: 'uuid-1',
    parked: false,
    rebindSupported: true,
    ...overrides,
  };
}

export function reattachCandidate(overrides: Partial<ReattachCandidate> = {}): ReattachCandidate {
  return {
    deviceId: TARGET_ID,
    orgId: 'org-a',
    orgName: 'Acme',
    siteId: 'site-1',
    siteName: 'HQ',
    hostname: 'LAPTOP-OLD',
    displayName: null,
    osType: 'windows',
    osVersion: '10',
    agentVersion: '0.110.0',
    status: 'offline',
    enrolledAt: '2025-01-01T10:00:00.000Z',
    createdAt: '2025-01-01T10:00:00.000Z',
    lastSeenAt: '2026-11-01T10:00:00.000Z',
    decommissionedAt: null,
    serialNumber: 'SER-1',
    manufacturer: 'Dell',
    model: 'XPS 13',
    systemUuid: 'uuid-1',
    evidence: 'system_uuid',
    reason: 'hardware',
    evidenceLevel: 'hint',
    flagged: true,
    osChanged: false,
    requiresRestore: false,
    targetVersion: TARGET_VERSION,
    ...overrides,
  };
}

export function candidatesView(overrides: Partial<ReinstallCandidatesView> = {}): ReinstallCandidatesView {
  return {
    source: reattachSource(),
    candidates: [reattachCandidate()],
    reviewPending: false,
    openIntent: null,
    evidenceNotice: 'Hardware identifiers reported by the device. Not verified.',
    ...overrides,
  };
}

export const requestedIntent = {
  id: 'intent-1',
  state: 'requested',
  sourceDeviceId: SOURCE_ID,
  targetDeviceId: TARGET_ID,
  evidenceLevel: 'hint' as const,
  restoreDecommissioned: false,
  requestedAt: '2026-11-11T10:00:00.000Z',
  expiresAt: '2026-11-12T10:00:00.000Z',
};

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
