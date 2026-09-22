import { afterEach, expect, it, vi } from 'vitest';
import { callerVerificationEnabled } from '../../config/env';

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, '', 'false', '1', 'yes', 'TRUE', 'true'])('exact readiness value %s', (value) => {
  if (value === undefined) delete process.env.CALLER_VERIFICATION_ENABLED;
  else vi.stubEnv('CALLER_VERIFICATION_ENABLED', value);
  expect(callerVerificationEnabled()).toBe(value === 'true');
});

it('exports every fixed cross-wave service entry point', async () => {
  const api = await import('./index');
  for (const name of [
    'resolveEffectivePolicy', 'getEffectivePolicy', 'resolveTargetBinding', 'bindingsForContact', 'upsertDirectorySyncBinding',
    'attestBinding', 'observeLogin', 'revokeBinding', 'recordDestinationChange', 'currentDestination', 'isEstablished',
    'attestDestination', 'computeTier', 'start', 'createAdministrative', 'cancel', 'attest', 'get', 'listForContact',
    'methodsForContact', 'freshForTicket', 'applyDecision', 'requireCallerVerification', 'isCallerVerificationEnabled',
    'handleRejection', 'fenceOverride', 'withSubjectLocks',
  ]) {
    expect(typeof api[name as keyof typeof api], name).toBe('function');
  }
  // The barrel pulls the whole service graph (db, schema, ticketService); a
  // cold import on a loaded runner exceeds the default 5s.
}, 60_000);
