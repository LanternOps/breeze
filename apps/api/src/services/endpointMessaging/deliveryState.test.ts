import { describe, expect, it } from 'vitest';
import {
  canTransition,
  DELIVERY_TERMINAL_STATUSES,
  allowedFromStatuses,
  deliveryStatusFromCommandResult,
  deliveryStatusFromEvent,
} from './deliveryState';
import { ENDPOINT_MESSAGE_DELIVERY_STATUSES } from '../../db/schema/endpointMessages';

describe('endpoint message delivery state machine', () => {
  it('terminal states are final', () => {
    for (const from of DELIVERY_TERMINAL_STATUSES) {
      for (const to of ENDPOINT_MESSAGE_DELIVERY_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('progress never regresses: acknowledged never returns to delivered, displayed never to delivered', () => {
    expect(canTransition('displayed', 'delivered')).toBe(false);
    expect(canTransition('delivered', 'queued')).toBe(false);
    expect(canTransition('acknowledged', 'delivered')).toBe(false);
  });

  it.each([
    ['queued', 'delivered'],
    ['queued', 'displayed'],
    ['queued', 'acknowledged'],
    ['queued', 'failed'],
    ['queued', 'retracted'],
    ['queued', 'expired'],
    ['delivered', 'displayed'],
    ['delivered', 'dismissed'],
    ['displayed', 'acknowledged'],
    ['displayed', 'retracted'],
    ['displayed', 'expired'],
    ['delivered', 'superseded'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it('a delivery fails only before anything was shown', () => {
    expect(canTransition('queued', 'failed')).toBe(true);
    expect(canTransition('delivered', 'failed')).toBe(false);
    expect(canTransition('displayed', 'failed')).toBe(false);
  });

  it('allowedFromStatuses is the exact inverse of canTransition', () => {
    for (const to of ENDPOINT_MESSAGE_DELIVERY_STATUSES) {
      const from = allowedFromStatuses(to);
      for (const s of ENDPOINT_MESSAGE_DELIVERY_STATUSES) {
        expect(from.includes(s), `${s} -> ${to}`).toBe(canTransition(s, to));
      }
    }
  });

  it('maps events and command results onto statuses', () => {
    expect(deliveryStatusFromEvent('displayed')).toBe('displayed');
    expect(deliveryStatusFromEvent('acknowledged')).toBe('acknowledged');
    expect(deliveryStatusFromEvent('dismissed')).toBe('dismissed');
    expect(deliveryStatusFromEvent('expired')).toBe('expired');
    expect(deliveryStatusFromCommandResult({ status: 'completed', stdout: JSON.stringify({ delivered: true, surface: 'assist' }) }))
      .toEqual({ status: 'delivered', surface: 'assist' });
    expect(deliveryStatusFromCommandResult({ status: 'completed', stdout: JSON.stringify({ delivered: true, surface: 'native' }) }))
      .toEqual({ status: 'delivered', surface: 'native' });
    expect(deliveryStatusFromCommandResult({ status: 'failed', error: 'no user helper connected' }))
      .toEqual({ status: 'failed', errorCode: 'no_helper' });
    expect(deliveryStatusFromCommandResult({ status: 'failed', error: 'unknown command type: notify_user' }))
      .toEqual({ status: 'failed', errorCode: 'agent_unsupported' });
    expect(deliveryStatusFromCommandResult({ status: 'timeout' }))
      .toEqual({ status: 'failed', errorCode: 'undelivered' });
  });
});
