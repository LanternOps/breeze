import { describe, it, expect } from 'vitest';
import { EXECUTION_STATUSES, CANCEL_STATES } from '@breeze/shared';
import {
  executionRowStatusConfig,
  executionDetailStatusConfig,
  resolveExecutionStatusLabel,
  resolveExecutionStatusDescription,
} from './executionStatus';

describe('every execution status resolves in both status maps', () => {
  it.each(EXECUTION_STATUSES)('row config has label, color and icon for %s', (status) => {
    const entry = executionRowStatusConfig[status];
    expect(entry).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.color).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(EXECUTION_STATUSES)('detail config has label, color, bgColor and icon for %s', (status) => {
    const entry = executionDetailStatusConfig[status];
    expect(entry).toBeDefined();
    expect(entry.label).toBeTruthy();
    expect(entry.color).toBeTruthy();
    expect(entry.bgColor).toBeTruthy();
    expect(entry.icon).toBeTruthy();
  });

  it.each(EXECUTION_STATUSES)('label resolution never returns empty for %s with no cancel state', (status) => {
    expect(resolveExecutionStatusLabel(status, null)).toBeTruthy();
  });

  it('an unconfirmed cancel gets its own label, distinct from a confirmed one', () => {
    expect(resolveExecutionStatusLabel('cancelled', 'confirmed'))
      .not.toBe(resolveExecutionStatusLabel('completed', 'unconfirmed'));
    expect(resolveExecutionStatusLabel('completed', 'unconfirmed'))
      .toBe('status.completedCancelTooLate');
  });

  it('a failed cancel attempt on a terminal, non-cancelled status reports cancelFailed', () => {
    expect(resolveExecutionStatusLabel('completed', 'failed')).toBe('status.cancelFailed');
  });

  it('cancelled always wins over a failed cancel_state — the process did stop', () => {
    expect(resolveExecutionStatusLabel('cancelled', 'failed')).toBe('status.cancelled');
  });

  it.each(['pending', 'queued', 'running', 'cancelling'] as const)(
    'a non-terminal status %s ignores cancel_state and keeps its base label',
    (status) => {
      expect(resolveExecutionStatusLabel(status, 'confirmed')).toBe(executionRowStatusConfig[status].label);
      expect(resolveExecutionStatusLabel(status, 'unconfirmed')).toBe(executionRowStatusConfig[status].label);
      expect(resolveExecutionStatusLabel(status, 'failed')).toBe(executionRowStatusConfig[status].label);
    },
  );

  it.each(CANCEL_STATES)('every cancel state resolves a label against a terminal status: %s', (cancelState) => {
    expect(resolveExecutionStatusLabel('completed', cancelState)).toBeTruthy();
  });

  // #9563 — `queued` only means the command was not delivered (no live agent
  // session). It does NOT prove the device is offline: a device can report
  // Online with no agent session. So the default label is the neutral
  // "awaiting pickup", and "Queued — device offline" (#5128 W2) is reserved for
  // when the device's own status says offline.
  it('queued defaults to the neutral awaiting-pickup label in both status maps', () => {
    expect(executionRowStatusConfig.queued.label).toBe('status.queuedAwaitingPickup');
    expect(executionDetailStatusConfig.queued.label).toBe('status.queuedAwaitingPickup');
    expect(resolveExecutionStatusLabel('queued', null)).toBe('status.queuedAwaitingPickup');
  });

  it('queued on an online device is awaiting pickup, not offline', () => {
    expect(resolveExecutionStatusLabel('queued', null, 'online')).toBe('status.queuedAwaitingPickup');
  });

  it('queued on an offline device keeps the device-offline label', () => {
    expect(resolveExecutionStatusLabel('queued', null, 'offline')).toBe('status.queuedOffline');
  });

  it('device status never changes a non-queued label', () => {
    expect(resolveExecutionStatusLabel('pending', null, 'offline')).toBe('status.pending');
    expect(resolveExecutionStatusLabel('completed', 'unconfirmed', 'offline')).toBe('status.completedCancelTooLate');
  });
});

describe('resolveExecutionStatusDescription (#9563)', () => {
  it.each(EXECUTION_STATUSES)('resolves a description key for %s', (status) => {
    expect(resolveExecutionStatusDescription(status)).toMatch(/^statusDescription\./);
  });

  it('queued with an online or unknown device describes awaiting agent pickup', () => {
    expect(resolveExecutionStatusDescription('queued', 'online')).toBe('statusDescription.queuedAwaitingPickup');
    expect(resolveExecutionStatusDescription('queued')).toBe('statusDescription.queuedAwaitingPickup');
  });

  it.each(['pending', 'queued'] as const)('%s on an offline device says the device is offline', (status) => {
    expect(resolveExecutionStatusDescription(status, 'offline')).toBe('statusDescription.deviceOffline');
  });

  it('pending on an online device keeps its own description', () => {
    expect(resolveExecutionStatusDescription('pending', 'online')).toBe('statusDescription.pending');
  });

  it('a terminal status ignores device status', () => {
    expect(resolveExecutionStatusDescription('completed', 'offline')).toBe('statusDescription.completed');
  });
});
