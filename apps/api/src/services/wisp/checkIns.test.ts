/**
 * Wisp event check-ins W04 (#11493, #10410) — the pure parts of
 * services/wisp/checkIns.ts: the DTO and the fire-time post body. The DB
 * paths (create, fire, the event and tick reconciles, the claim race) run
 * against real Postgres in
 * __tests__/integration/wispCheckInTriggers.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { WispCheckInRow } from '../../db/schema/wispCheckIns';
import { checkInPostBody, toCheckInDto } from './checkIns';

const ID = '00000000-0000-4000-8000-000000000a01';
const SUBJECT = '00000000-0000-4000-8000-000000000b01';
const CREATED = new Date('2026-11-08T10:00:00.000Z');
const DUE = new Date('2026-11-09T10:00:00.000Z');

function row(over: Partial<WispCheckInRow> = {}): WispCheckInRow {
  return {
    id: ID,
    partnerId: '00000000-0000-4000-8000-000000000c01',
    orgId: '00000000-0000-4000-8000-000000000d01',
    grantId: '00000000-0000-4000-8000-000000000e01',
    threadId: '00000000-0000-4000-8000-000000000e02',
    sessionId: null,
    userId: '00000000-0000-4000-8000-000000000e03',
    dueAt: DUE,
    instruction: 'Check the patch scan results and report them.',
    context: null,
    status: 'scheduled',
    firedAt: null,
    consumedAt: null,
    cancelledAt: null,
    jobId: `wisp-check-in-${ID}`,
    createdAt: CREATED,
    triggerKind: 'time',
    triggerSubjectId: null,
    fireReason: null,
    cancelReason: null,
    ...over,
  };
}

describe('toCheckInDto', () => {
  it('a time check-in has no trigger, and no fire or cancel reason until one is written', () => {
    expect(toCheckInDto(row())).toMatchObject({ trigger: null, fireReason: null, cancelReason: null });
  });

  it('maps an event check-in: the trigger kind + subject, the fire reason and the cancel reason', () => {
    const fired = toCheckInDto(row({
      triggerKind: 'device_online',
      triggerSubjectId: SUBJECT,
      status: 'fired',
      firedAt: DUE,
      fireReason: 'deadline',
    }));
    expect(fired).toMatchObject({
      trigger: { kind: 'device_online', subjectId: SUBJECT },
      fireReason: 'deadline',
      cancelReason: null,
      dueAt: DUE.toISOString(),
    });

    const cancelled = toCheckInDto(row({
      triggerKind: 'script_finished',
      triggerSubjectId: SUBJECT,
      status: 'cancelled',
      cancelledAt: DUE,
      cancelReason: 'subject_deleted',
    }));
    expect(cancelled).toMatchObject({ trigger: { kind: 'script_finished', subjectId: SUBJECT }, cancelReason: 'subject_deleted' });
  });
});

describe('checkInPostBody', () => {
  it('a due or event fire posts the instruction as it is', () => {
    const r = row();
    expect(checkInPostBody(r, 'due')).toBe(r.instruction);
    expect(checkInPostBody(row({ triggerKind: 'device_online', triggerSubjectId: SUBJECT }), 'event')).toBe(r.instruction);
  });

  it('a deadline fire says what did not happen by the due time, in UTC, before the instruction', () => {
    const r = row({ triggerKind: 'device_online', triggerSubjectId: SUBJECT, dueAt: new Date('2026-11-09T15:40:12.000Z') });
    expect(checkInPostBody(r, 'deadline')).toBe(
      'Did not happen by 15:40 UTC: the device is still offline. Check the patch scan results and report them.',
    );
    for (const [kind, line] of [
      ['script_finished', 'the script is still running'],
      ['command_finished', 'the command is still pending'],
      ['run_settled', 'the run is still going'],
    ] as const) {
      expect(checkInPostBody(row({ triggerKind: kind, triggerSubjectId: SUBJECT }), 'deadline')).toContain(`UTC: ${line}. `);
    }
  });
});
