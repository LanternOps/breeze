import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchWithAuth, showToast } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../stores/auth', () => ({ fetchWithAuth }));
vi.mock('../components/shared/Toast', () => ({ showToast }));

import { mapEdrSeverity, s1ThreatToIncident, huntressIncidentToIncident, promoteToIncident } from './incidents';

function ok(b: unknown) {
  return { ok: true, status: 201, json: async () => b } as Response;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('mapEdrSeverity', () => {
  it('maps EDR severities to p1-p4 with a safe default', () => {
    expect(mapEdrSeverity('critical')).toBe('p1');
    expect(mapEdrSeverity('HIGH')).toBe('p2');
    expect(mapEdrSeverity('medium')).toBe('p3');
    expect(mapEdrSeverity('low')).toBe('p4');
    expect(mapEdrSeverity(null)).toBe('p3');
    expect(mapEdrSeverity('weird')).toBe('p3');
  });
});

describe('mappers', () => {
  it('builds an incident input from an S1 threat', () => {
    const input = s1ThreatToIncident({
      id: 't1',
      orgId: 'org-1',
      deviceId: 'dev-9',
      deviceName: 'PC',
      threatName: 'Emotet',
      severity: 'critical',
      status: 'active',
      detectedAt: '2026-06-20T00:00:00Z',
    } as any);
    expect(input.orgId).toBe('org-1');
    expect(input.severity).toBe('p1');
    expect(input.affectedDevices).toEqual(['dev-9']);
    expect(input.classification).toBe('sentinelone-threat');
    expect(input.title).toContain('Emotet');
  });

  it('builds an incident input from a Huntress incident with no device', () => {
    const input = huntressIncidentToIncident({
      id: 'i1',
      orgId: 'org-2',
      deviceId: null,
      title: 'Persistence',
      severity: 'high',
      status: 'open',
      reportedAt: '2026-06-21T00:00:00Z',
    } as any);
    expect(input.orgId).toBe('org-2');
    expect(input.severity).toBe('p2');
    expect(input.affectedDevices).toEqual([]);
    expect(input.classification).toBe('huntress-incident');
  });

  it('s1ThreatToIncident sets the s1 source link', () => {
    const input = s1ThreatToIncident({ id: 't1', orgId: 'org-1', deviceId: 'dev-9', deviceName: 'PC',
      s1ThreatId: 's1-xyz', threatName: 'Emotet', severity: 'critical', status: 'active',
      detectedAt: '2026-06-20T00:00:00Z' } as any);
    expect(input.sourceType).toBe('s1_threat');
    expect(input.sourceRef).toBe('s1-xyz');
  });

  it('huntressIncidentToIncident sets the huntress source link', () => {
    const input = huntressIncidentToIncident({ id: 'i1', orgId: 'org-1', deviceId: 'dev-9',
      huntressIncidentId: 'hunt-1', title: 'Bad login', severity: 'high', status: 'open',
      reportedAt: '2026-06-20T00:00:00Z' } as any);
    expect(input.sourceType).toBe('huntress_incident');
    expect(input.sourceRef).toBe('hunt-1');
  });
});

describe('promoteToIncident', () => {
  it('POSTs /incidents and returns the new id', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Promise.resolve(ok({ id: 'inc-1' }));
    });
    const res = await promoteToIncident({
      orgId: 'org-1',
      title: 'X',
      classification: 'sentinelone-threat',
      severity: 'p1',
      affectedDevices: ['dev-9'],
    });
    expect(res).toEqual({ id: 'inc-1' });
    expect(fetchWithAuth.mock.calls[0][0]).toBe('/incidents');
    expect((body as any).orgId).toBe('org-1');
    expect((body as any).severity).toBe('p1');
  });
});
