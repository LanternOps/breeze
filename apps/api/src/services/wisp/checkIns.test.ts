/**
 * Wisp event check-ins W04 (#11493, #10410) — the pure parts of
 * services/wisp/checkIns.ts: the DTO and the fire-time post body. The DB
 * paths (create, fire, the event and tick reconciles, the claim race) run
 * against real Postgres in
 * __tests__/integration/wispCheckInTriggers.integration.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WISP_CHECK_IN_CANCEL_REASON_MAX,
  WISP_CHECK_IN_FIRE_REASONS,
  WISP_CHECK_IN_MODES,
  WISP_CHECK_IN_STATUSES,
  WISP_CHECK_IN_TRIGGER_KINDS,
} from '@breeze/shared';
import type { WispCheckInRow } from '../../db/schema/wispCheckIns';
import { checkInPostBody, toCheckInDto } from './checkIns';

const MIGRATIONS = resolve(import.meta.dirname, '../../../migrations');

/** The value list of the LAST `ADD CONSTRAINT <name> CHECK (<col> IN (…))` across all migrations. */
function lastCheckList(name: string): string[] {
  let last: string | null = null;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    for (const line of readFileSync(join(MIGRATIONS, file), 'utf8').split('\n')) {
      if (line.includes(`ADD CONSTRAINT ${name} CHECK`)) last = line;
    }
  }
  expect(last, name).not.toBeNull();
  const list = /IN \(([^)]*)\)/.exec(last!)?.[1] ?? '';
  return [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

describe('wisp_check_ins CHECKs mirror the shared constants', () => {
  it('trigger kinds, fire reasons and the cancel-reason length', () => {
    expect(lastCheckList('wisp_check_ins_trigger_kind_chk')).toEqual([...WISP_CHECK_IN_TRIGGER_KINDS]);
    expect(lastCheckList('wisp_check_ins_fire_reason_chk')).toEqual([...WISP_CHECK_IN_FIRE_REASONS]);
    const lenLine = readdirSync(MIGRATIONS).sort().map((f) => (f.endsWith('.sql') ? readFileSync(join(MIGRATIONS, f), 'utf8') : ''))
      .join('\n').split('\n').filter((l) => l.includes('ADD CONSTRAINT wisp_check_ins_cancel_reason_len_chk')).at(-1);
    expect(lenLine).toContain(`char_length(cancel_reason) <= ${WISP_CHECK_IN_CANCEL_REASON_MAX}`);
  });

  it('W07: statuses (widened with running) and modes', () => {
    expect(lastCheckList('wisp_check_ins_status_chk')).toEqual([...WISP_CHECK_IN_STATUSES]);
    expect(WISP_CHECK_IN_STATUSES).toContain('running');
    expect(lastCheckList('wisp_check_ins_mode_chk')).toEqual([...WISP_CHECK_IN_MODES]);
  });
});

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
    mode: 'notify',
    runId: null,
    grantRevisionId: null,
    ...over,
  };
}

describe('toCheckInDto', () => {
  it('W07: a notify check-in maps mode notify and no run', () => {
    expect(toCheckInDto(row())).toMatchObject({ mode: 'notify', runId: null });
  });

  it('W07: a run check-in maps its mode and the run it admitted', () => {
    const RUN = '00000000-0000-4000-8000-000000000f01';
    expect(toCheckInDto(row({ mode: 'run', runId: RUN, status: 'running' }))).toMatchObject({ mode: 'run', runId: RUN, status: 'running' });
  });

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
