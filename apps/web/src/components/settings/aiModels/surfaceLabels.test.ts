import { describe, it, expect } from 'vitest';
import { isBaseUrlRefusal } from './surfaceLabels';

describe('isBaseUrlRefusal (#7803)', () => {
  it.each([
    [400, 'endpoint_unreachable', true],
    [400, 'egress_blocked', true],
    [400, 'invalid_url', true],
    [400, 'invalid', false],
    [409, 'registry_busy', false],
    [502, 'egress_blocked', false],
    [400, undefined, false],
  ] as const)('status %s code %s → %s', (status, code, expected) => {
    expect(isBaseUrlRefusal(status, code)).toBe(expected);
  });
});
