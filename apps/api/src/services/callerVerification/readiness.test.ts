import { afterEach, expect, it, vi } from 'vitest';
import { callerVerificationEnabled } from '../../config/env';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '', 'false', '1', 'yes', 'TRUE', 'true'])('exact readiness value %s', (value) => {
  if (value === undefined) delete process.env.CALLER_VERIFICATION_ENABLED;
  else vi.stubEnv('CALLER_VERIFICATION_ENABLED', value);
  expect(callerVerificationEnabled()).toBe(value === 'true');
});
