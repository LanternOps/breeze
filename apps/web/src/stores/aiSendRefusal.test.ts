import { describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));

import { classifySendRefusal } from './aiSendRefusal';

describe('classifySendRefusal', () => {
  it.each([
    [409, 'turn_in_progress', 'attach'],
    [409, null, 'attach'], // older API: an uncoded 409 can only mean another turn
    [409, 'continuation_required', 'continuation'],
    [409, 'model_unavailable', 'choose_model'],
    [409, 'tools_unsupported', 'choose_model'],
    [409, 'topology_model_changed', 'choose_model'],
    [409, 'turn_limit_reached', 'turn_limit'],
    [409, 'something_else', 'error'],
    [402, 'insufficient_credits', 'credits'],
    [402, null, 'error'],
    [500, null, 'error'],
    [429, 'turn_in_progress', 'error'],
    [400, 'model_unavailable', 'error'],
  ] as const)('%s %s -> %s', (status, code, expected) => {
    expect(classifySendRefusal(status, code)).toBe(expected);
  });
});
