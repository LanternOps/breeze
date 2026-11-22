import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOemRun, type OemRunRow } from './history';

// The query (only this command type, current org, null excluded, pagination, actor
// join) runs against real Postgres in
// __tests__/integration/oemUpdateRunRoute.integration.test.ts.

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const CREATED = new Date('2026-11-05T01:00:00.000Z');
const COMPLETED = new Date('2026-11-05T01:30:00.000Z');

function goodResult(overrides: Record<string, unknown> = {}) {
  return {
    lane: 'dell',
    outcome: 'success_reboot_required',
    toolVersion: '5.7.2',
    rawExitCode: 1,
    errorCode: null,
    rebootRequired: true,
    shutdownRequired: false,
    items: [{ title: 'BIOS', category: 'bios', version: '1.21.0', result: 'installed' }],
    skippedCategories: [{ category: 'firmware', reason: 'no_recovery_key' }],
    takeover: 'not_attempted',
    ...overrides,
  };
}

/** What the transports store: the agent's envelope, with the result as JSON text on stdout. */
const envelope = (result: unknown) => ({ status: 'completed', exitCode: 0, stdout: JSON.stringify(result) });

function row(overrides: Partial<OemRunRow> = {}): OemRunRow {
  return {
    id: COMMAND_ID,
    status: 'completed',
    payload: { trigger: 'on_demand', rebootControlled: true },
    result: envelope(goodResult()),
    createdAt: CREATED,
    completedAt: COMPLETED,
    actorId: 'user-1',
    actorName: 'A Tech',
    actorEmail: 'tech@example.com',
    ...overrides,
  };
}

describe('normalizeOemRun', () => {
  it('reads the result out of the stored envelope', () => {
    expect(normalizeOemRun(row())).toEqual({
      commandId: COMMAND_ID,
      kind: 'run',
      observation: null,
      trigger: 'on_demand',
      status: 'completed',
      outcome: 'success_reboot_required',
      errorCode: null,
      toolVersion: '5.7.2',
      rebootRequired: true,
      rebootControlled: true,
      items: [{ title: 'BIOS', category: 'bios', version: '1.21.0', result: 'installed' }],
      skippedCategories: [{ category: 'firmware', reason: 'no_recovery_key' }],
      createdAt: CREATED,
      completedAt: COMPLETED,
      actor: { id: 'user-1', name: 'A Tech', email: 'tech@example.com' },
    });
  });

  it('a failed run keeps its outcome: the agent reports failures on stdout too', () => {
    const run = normalizeOemRun(row({
      status: 'failed',
      result: { status: 'failed', stdout: JSON.stringify(goodResult({ outcome: 'blocked_on_battery', rebootRequired: false, errorCode: 'on_battery' })) },
    }));
    expect(run).toMatchObject({ status: 'failed', outcome: 'blocked_on_battery', errorCode: 'on_battery' });
  });

  it.each([
    ['no result yet', null],
    ['an envelope with no stdout', { status: 'completed' }],
    ['stdout that is not JSON', { stdout: 'Dell Command Update exited' }],
    ['stdout that is not an object', { stdout: '[]' }],
    ['an unknown outcome', envelope(goodResult({ outcome: 'great' }))],
    ['an unknown key', envelope(goodResult({ extra: true }))],
    ['a control character in tool text', envelope(goodResult({ toolVersion: '5.7.2\u001b[31m' }))],
    ['too many items', envelope(goodResult({ items: Array.from({ length: 201 }, () => ({ title: 't', category: 'driver', version: '1', result: 'installed' })) }))],
    ['a string, not an envelope', 'nope'],
  ])('malformed result normalizes: %s', (_label, result) => {
    expect(normalizeOemRun(row({ result }))).toMatchObject({
      outcome: null,
      errorCode: null,
      toolVersion: null,
      rebootRequired: false,
      items: [],
      skippedCategories: [],
    });
  });

  it('a malformed payload gives no trigger and no claim of reboot control', () => {
    expect(normalizeOemRun(row({ payload: null }))).toMatchObject({ trigger: null, rebootControlled: null });
    expect(normalizeOemRun(row({ payload: { trigger: 'nope', rebootControlled: 'yes' } }))).toMatchObject({
      trigger: null,
      rebootControlled: null,
    });
  });

  it('a run with no human behind it has no actor', () => {
    expect(normalizeOemRun(row({ actorId: null, actorName: null, actorEmail: null })).actor).toBeNull();
  });

  it('a scheduled run says so', () => {
    expect(normalizeOemRun(row({ payload: { trigger: 'scheduled', rebootControlled: true } })).trigger).toBe('scheduled');
  });
});

// Observe-first (#11065): observations share the history list as `Observed` rows.
describe('normalizeOemRun: observations', () => {
  const WIRE = path.resolve(__dirname, '../../../../../agent/internal/oemupdates/observe/testdata/wire');
  const golden = (lane: string) => JSON.parse(readFileSync(path.join(WIRE, `${lane}.json`), 'utf8'));
  const observeRow = (result: unknown, overrides: Partial<OemRunRow> = {}) => row({
    type: 'oem_observe',
    payload: { lane: 'lenovo', observeLevel: 'passive', escrowedProtectorIds: [] },
    result,
    ...overrides,
  });

  it('a run row says it is a run', () => {
    expect(normalizeOemRun(row()).kind).toBe('run');
    expect(normalizeOemRun(row()).observation).toBeNull();
  });

  it('summarises an observation: lane, verdict and tools found, nothing else from the device', () => {
    const view = normalizeOemRun(observeRow(envelope(golden('lenovo'))));
    expect(view.kind).toBe('observe');
    expect(view.observation).toEqual({
      lane: 'lenovo',
      verdict: 'observed',
      tools: ['lenovo_system_update'],
      conflicts: ['lenovo_commercial_vantage'],
    });
    expect(view.outcome).toBeNull();
    expect(view.items).toEqual([]);
    expect(view.trigger).toBe('on_demand');
  });

  it('a consumer HP reads as platform unsupported; errors are a verdict, not text', () => {
    expect(normalizeOemRun(observeRow(envelope(golden('hp')))).observation?.verdict).toBe('platform_unsupported');
    const surface = golden('surface');
    surface.errors = [{ step: 'wu_search', code: 'wu_search_failed' }];
    expect(normalizeOemRun(observeRow(envelope(surface))).observation?.verdict).toBe('observed_with_errors');
  });

  it('a scrubbed or unreadable observation is invalid, and a scheduled one has no actor', () => {
    const view = normalizeOemRun(observeRow({ status: 'completed', rejected: 'observation_invalid' }, { actorId: null }));
    expect(view.observation).toEqual({ lane: 'lenovo', verdict: 'invalid', tools: [], conflicts: [] });
    expect(view.trigger).toBe('scheduled');
    expect(view.actor).toBeNull();
  });

  it('a pending observation has no verdict yet', () => {
    expect(normalizeOemRun(observeRow(null, { status: 'pending' })).observation).toBeNull();
  });
});
