import { describe, expect, it } from 'vitest';
import { __testOnly } from './automationActionResults';

const pending = {
  status: 'pending' as const,
  terminalSource: null,
  commandId: null,
  scriptExecutionId: null,
  deploymentResultId: null,
};

describe('automation action-result state machine', () => {
  it.each([
    ['pending', 'queued'],
    ['pending', 'delivered'],
    ['pending', 'running'],
    ['queued', 'delivered'],
    ['queued', 'running'],
    ['delivered', 'running'],
  ] as const)('allows monotonic dispatch %s -> %s', (from, to) => {
    expect(__testOnly.decideDispatchTransition({ ...pending, status: from }, { status: to }))
      .toMatchObject({ status: to });
  });

  it('terminalizes a synchronous action through the dispatch identity', () => {
    expect(__testOnly.decideDispatchTransition(pending, { status: 'succeeded' }))
      .toMatchObject({ status: 'succeeded', terminalSource: 'dispatch' });
  });

  it.each([
    ['queued', 'pending'],
    ['delivered', 'pending'],
    ['delivered', 'queued'],
    ['running', 'queued'],
    ['running', 'delivered'],
  ] as const)('rejects reordered dispatch %s -> %s', (from, to) => {
    expect(__testOnly.decideDispatchTransition({ ...pending, status: from }, { status: to })).toBeNull();
  });

  it.each(
    (['pending', 'queued', 'delivered', 'running'] as const).flatMap((from) =>
      (['succeeded', 'failed', 'skipped', 'timed_out', 'cancelled'] as const)
        .map((status) => [from, status] as const)),
  )(
    'terminalizes %s as %s',
    (from, status) => {
      expect(__testOnly.decideTerminalTransition(
        { ...pending, status: from },
        {
          source: status === 'skipped' ? 'cancellation' : 'command',
          terminalStatus: status,
          output: null,
          error: null,
          completedAt: new Date('2026-08-24T12:00:00Z'),
        },
      )).toMatchObject({ status });
    },
  );

  it('keeps terminal rows immutable except for real evidence replacing a provisional reaper timeout', () => {
    const provisional = { ...pending, status: 'timed_out' as const, terminalSource: 'reaper' as const };
    const real = {
      source: 'script_execution' as const,
      terminalStatus: 'succeeded' as const,
      output: 'redacted output',
      error: null,
      completedAt: new Date('2026-08-24T12:01:00Z'),
    };
    expect(__testOnly.decideTerminalTransition(provisional, real)).toMatchObject({
      status: 'succeeded',
      terminalSource: 'script_execution',
    });
    expect(__testOnly.decideTerminalTransition(
      { ...provisional, terminalSource: 'timeout' },
      real,
    )).toBeNull();
    expect(__testOnly.decideTerminalTransition(
      { ...provisional, status: 'failed', terminalSource: 'command' },
      real,
    )).toBeNull();
  });

  it('treats exact duplicates as no-ops and rejects correlation replacement', () => {
    const commandId = '00000000-0000-4000-8000-000000000001';
    const row = { ...pending, status: 'queued' as const, commandId };
    expect(__testOnly.decideDispatchTransition(row, { status: 'queued', commandId })).toBeNull();
    expect(__testOnly.decideDispatchTransition(row, {
      status: 'delivered',
      commandId: '00000000-0000-4000-8000-000000000002',
    })).toBeNull();
    expect(__testOnly.decideDispatchTransition(row, {
      status: 'delivered',
      commandId,
    })).toMatchObject({ status: 'delivered' });
  });

  it('derives device outcomes without counting skipped as success or failure', () => {
    expect(__testOnly.aggregateActionStatuses(['pending', 'queued'])).toEqual({ status: 'running' });
    expect(__testOnly.aggregateActionStatuses(['pending'])).toEqual({ status: 'pending' });
    expect(__testOnly.aggregateActionStatuses(['skipped', 'skipped'])).toEqual({ status: 'skipped' });
    expect(__testOnly.aggregateActionStatuses(['succeeded', 'skipped'])).toEqual({ status: 'success' });
    expect(__testOnly.aggregateActionStatuses(['succeeded', 'timed_out'])).toEqual({ status: 'failed' });
  });

  it('derives terminal run counters absolutely and leaves any in-flight run running', () => {
    expect(__testOnly.aggregateDeviceStatuses(['success', 'pending', 'failed'])).toEqual({
      status: 'running',
      devicesSucceeded: 1,
      devicesFailed: 1,
    });
    expect(__testOnly.aggregateDeviceStatuses(['skipped', 'skipped'])).toEqual({
      status: 'completed',
      devicesSucceeded: 0,
      devicesFailed: 0,
    });
    expect(__testOnly.aggregateDeviceStatuses(['success', 'failed', 'skipped'])).toEqual({
      status: 'partial',
      devicesSucceeded: 1,
      devicesFailed: 1,
    });
    expect(__testOnly.aggregateDeviceStatuses(['failed', 'skipped'])).toEqual({
      status: 'failed',
      devicesSucceeded: 0,
      devicesFailed: 1,
    });
  });

  it('rolls ordered action messages and the first failure into the device result', () => {
    expect(__testOnly.aggregateActionDetails([
      { actionIndex: 1, status: 'failed', message: 'Device is offline', output: null, error: null },
      { actionIndex: 0, status: 'succeeded', message: 'Alert created', output: null, error: null },
    ])).toEqual({
      output: 'Alert created\nDevice is offline',
      error: 'Device is offline',
    });
  });
});
