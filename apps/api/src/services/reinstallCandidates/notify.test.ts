import { describe, expect, it } from 'vitest';
import {
  OTHER_ORG_SOURCE_LABEL,
  PARKED_SOURCE_LABEL,
  buildReinstallSuspectedAlertContext,
  buildReinstallSuspectedAuditDetails,
  buildReinstallSuspectedEventPayload,
  reinstallSourceLabel,
  type ReinstallSuspicion,
} from './notify';

const SOURCE_ID = '00000000-0000-4000-8000-0000000000b1';
const SOURCE_HOST = 'PARKED-SECRET-HOST';
const TARGET_ORG = '00000000-0000-4000-8000-0000000000f1';

function suspicion(source: Partial<ReinstallSuspicion['source']>): ReinstallSuspicion {
  return {
    source: { id: SOURCE_ID, orgId: TARGET_ORG, hostname: SOURCE_HOST, parked: false, ...source },
    target: { id: '00000000-0000-4000-8000-0000000000a1', orgId: TARGET_ORG, siteId: '00000000-0000-4000-8000-0000000000e1', hostname: 'PC-01' },
    reason: 'hardware',
    evidence: 'system_uuid',
    detectedAt: new Date('2027-01-10T00:00:00Z'),
    kind: 'new',
    trigger: 'enroll',
  };
}

const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.includes(SOURCE_ID) || text.includes(SOURCE_HOST);
};

describe('reinstall-suspected payloads never leak a parked or cross-org source', () => {
  it('a parked source: no id, no hostname, anywhere', () => {
    const s = suspicion({ parked: true, orgId: '00000000-0000-4000-8000-0000000000f9' });
    const event = buildReinstallSuspectedEventPayload(s);
    expect(event).toEqual({
      targetDeviceId: s.target.id,
      reason: 'hardware',
      detectedAt: '2027-01-10T00:00:00.000Z',
      sourceParked: true,
    });
    expect(leaks(event)).toBe(false);
    expect(leaks(buildReinstallSuspectedAlertContext(s))).toBe(false);
    expect(leaks(buildReinstallSuspectedAuditDetails(s))).toBe(false);
    expect(reinstallSourceLabel(s)).toBe(PARKED_SOURCE_LABEL);
    expect(buildReinstallSuspectedAlertContext(s).sourceLabel).toBe(PARKED_SOURCE_LABEL);
  });

  it('a source in another customer org: no id, no hostname either', () => {
    const s = suspicion({ orgId: '00000000-0000-4000-8000-0000000000f2' });
    expect(leaks(buildReinstallSuspectedEventPayload(s))).toBe(false);
    expect(leaks(buildReinstallSuspectedAlertContext(s))).toBe(false);
    expect(leaks(buildReinstallSuspectedAuditDetails(s))).toBe(false);
    expect(reinstallSourceLabel(s)).toBe(OTHER_ORG_SOURCE_LABEL);
  });

  it('a source in the same org is named', () => {
    const s = suspicion({});
    expect(buildReinstallSuspectedEventPayload(s)).toMatchObject({ sourceDeviceId: SOURCE_ID, sourceHostname: SOURCE_HOST, sourceParked: false });
    expect(buildReinstallSuspectedAlertContext(s)).toMatchObject({ sourceDeviceId: SOURCE_ID, sourceHostname: SOURCE_HOST });
    expect(reinstallSourceLabel(s)).toContain(SOURCE_HOST);
  });
});
