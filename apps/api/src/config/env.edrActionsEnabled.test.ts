import { afterEach, describe, expect, it } from 'vitest';
import { edrActionsEnabled } from './env';

/**
 * BREEZE_EDR_ACTIONS_ENABLED (#8167 W03): the server-wide kill switch for EDR
 * response actions. Default ON (the per-connection `actions_enabled` opt-in,
 * default OFF, is the real gate); read at CALL time so flipping it needs no
 * module reload.
 */
describe('edrActionsEnabled', () => {
  const original = process.env.BREEZE_EDR_ACTIONS_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.BREEZE_EDR_ACTIONS_ENABLED;
    else process.env.BREEZE_EDR_ACTIONS_ENABLED = original;
  });

  it('defaults ON when unset or empty', () => {
    delete process.env.BREEZE_EDR_ACTIONS_ENABLED;
    expect(edrActionsEnabled()).toBe(true);
    process.env.BREEZE_EDR_ACTIONS_ENABLED = '';
    expect(edrActionsEnabled()).toBe(true);
  });

  it.each(['false', '0', 'off', 'no', ' FALSE '])('%j disables', (v) => {
    process.env.BREEZE_EDR_ACTIONS_ENABLED = v;
    expect(edrActionsEnabled()).toBe(false);
  });

  it.each(['true', '1', 'on', 'yes'])('%j enables', (v) => {
    process.env.BREEZE_EDR_ACTIONS_ENABLED = v;
    expect(edrActionsEnabled()).toBe(true);
  });

  it('an unrecognized value fails CLOSED (an operator who set it meant to change something)', () => {
    process.env.BREEZE_EDR_ACTIONS_ENABLED = 'disabled-please';
    expect(edrActionsEnabled()).toBe(false);
  });

  it('is re-read on every call (set after import is honoured)', () => {
    process.env.BREEZE_EDR_ACTIONS_ENABLED = 'true';
    expect(edrActionsEnabled()).toBe(true);
    process.env.BREEZE_EDR_ACTIONS_ENABLED = 'false';
    expect(edrActionsEnabled()).toBe(false);
  });
});
