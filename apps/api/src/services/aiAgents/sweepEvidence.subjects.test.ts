/**
 * #4442 W04 Task 4 — the SYSTEM's own subject for an evidence row.
 *
 * The anti-substitution control for act mode. `persistSweepFindings` must be
 * able to say "the row I loaded is about (device, service `Spooler`)" from
 * NAMED loader fields, never from model prose — otherwise evidence about
 * service A could authorize an unattended restart of service B on the same
 * device.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleSweepEvidence,
  evidenceRowSubject,
  indexEvidenceSubjects,
  type SweepEvidenceRow,
} from './sweepEvidence';

const DEVICE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function row(fields: SweepEvidenceRow['fields'], deviceId: string | null = DEVICE_A): SweepEvidenceRow {
  return { deviceId, hostname: 'host-1', fields };
}

describe('evidenceRowSubject', () => {
  it('service_down: the subject key is the service NAME from the evidence row, and observedAt is checkedAt', () => {
    const subject = evidenceRowSubject('service_down', row({
      name: 'Spooler',
      watchType: 'service',
      status: 'stopped',
      checkedAt: '2026-09-15T10:00:00.000Z',
    }));
    expect(subject).toEqual({
      kind: 'service_down',
      deviceId: DEVICE_A,
      key: 'Spooler',
      observedAt: '2026-09-15T10:00:00.000Z',
    });
  });

  it('disk_pressure: the subject key is the mount point', () => {
    expect(evidenceRowSubject('disk_pressure', row({ mountPoint: 'C:', usedPercent: 93 })))
      .toMatchObject({ kind: 'disk_pressure', key: 'C:' });
  });

  it('unpatched_critical: the subject key is the SORTED device-vulnerability ids, comma-joined', () => {
    expect(evidenceRowSubject('unpatched_critical', row({
      deviceVulnerabilityIds: 'dv-c,dv-a,dv-b',
      openCriticalCount: 3,
    }))).toMatchObject({ key: 'dv-a,dv-b,dv-c' });
  });

  it('a kind with no single subject returns null', () => {
    expect(evidenceRowSubject('stale_agents', row({ lastSeenAt: null }))).toBeNull();
    expect(evidenceRowSubject('pending_reboots', row({ osType: 'windows' }))).toBeNull();
  });

  it('returns null when the row carries no device id — a subject is always (device, key)', () => {
    expect(evidenceRowSubject('service_down', row({ name: 'Spooler' }, null))).toBeNull();
  });

  it('returns null when the subject field is missing or empty rather than inventing a key', () => {
    expect(evidenceRowSubject('service_down', row({ status: 'stopped' }))).toBeNull();
    expect(evidenceRowSubject('service_down', row({ name: '' }))).toBeNull();
    expect(evidenceRowSubject('unpatched_critical', row({ deviceVulnerabilityIds: '' }))).toBeNull();
  });
});

describe('indexEvidenceSubjects', () => {
  it('keys on kind|deviceId|key and drops rows with a null deviceId', () => {
    const evidence = assembleSweepEvidence({
      service_down: {
        rows: [
          row({ name: 'Spooler', checkedAt: '2026-09-15T10:00:00.000Z' }),
          row({ name: 'W32Time', checkedAt: '2026-09-15T10:05:00.000Z' }, DEVICE_B),
          row({ name: 'Orphan', checkedAt: '2026-09-15T10:05:00.000Z' }, null),
        ],
        total: 3,
      },
      stale_agents: { rows: [row({ lastSeenAt: null })], total: 1 },
    });

    const index = indexEvidenceSubjects(evidence);

    expect([...index.keys()].sort()).toEqual([
      `service_down|${DEVICE_A}|Spooler`,
      `service_down|${DEVICE_B}|W32Time`,
    ]);
    expect(index.get(`service_down|${DEVICE_A}|Spooler`)).toMatchObject({ key: 'Spooler' });
  });

  it('indexes only the rows that SURVIVED the evidence cap — a trimmed row is not evidence', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row({ name: `Svc${i}`, checkedAt: '2026-09-15T10:00:00.000Z' }));
    const evidence = assembleSweepEvidence({ service_down: { rows, total: 30 } });

    const index = indexEvidenceSubjects(evidence);

    expect(index.size).toBe(evidence.kinds.service_down!.rows.length);
    expect(index.has(`service_down|${DEVICE_A}|Svc29`)).toBe(false);
  });
});
