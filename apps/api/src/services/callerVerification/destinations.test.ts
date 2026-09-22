import { expect, it } from 'vitest';
import { makeDbMock } from './testing';
import { isEstablished, normalizeDestination, recordDestinationChangeWithExecutor, destinationHash, redactDestination } from './destinations';
import { resolveEffectivePolicy } from './policy';
import type { DestinationRow } from './types';

it('requires age AND human provenance, even after attestation', () => {
  const now = new Date('2026-09-19T00:00:00Z');
  const policy = resolveEffectivePolicy(null, null);
  const d = { setAt: new Date('2026-09-12T00:00:00Z'), supersededAt: null, source: 'import', attestedAt: null } as DestinationRow;
  expect(isEstablished(d, policy, now)).toBe(false);
  expect(isEstablished({ ...d, attestedAt: now }, policy, now)).toBe(true);
  expect(isEstablished({ ...d, source: 'technician', setAt: now }, policy, now)).toBe(false);
  expect(isEstablished({ ...d, source: 'technician' }, { ...policy, requireAttestedDestination: true }, now)).toBe(false);
  expect(isEstablished({ ...d, source: 'technician', supersededAt: now }, policy, now)).toBe(false);
  expect(isEstablished({ ...d, source: 'technician' }, policy, now)).toBe(true);
  expect(normalizeDestination('email', ' A@EXAMPLE.COM ')).toBe('a@example.com');
  expect(normalizeDestination('mobile', '(555) 123-4567')).toBeNull();
  expect(normalizeDestination('mobile', '+1 (555) 123-4567')).toBe('+15551234567');
  expect(normalizeDestination('email', 'not-an-email')).toBeNull();
  expect(redactDestination('email', 'alex@example.com')).toBe('a***@example.com');
  expect(redactDestination('mobile', '+15551234567')).toBe('+***67');
});

it('unchanged normalized values do not renew age; A→B→A creates new rows', async () => {
  const exec = makeDbMock();
  const input = {
    orgId: '11111111-1111-4111-8111-111111111111', contactId: '22222222-2222-4222-8222-222222222222',
    kind: 'email' as const, value: 'a@example.com', source: 'import' as const, userId: null,
  };
  const old = { id: '33333333-3333-4333-8333-333333333333', valueHash: destinationHash('a@example.com') };

  exec.results.push([old]);
  await recordDestinationChangeWithExecutor(exec.db, { ...input, value: ' A@EXAMPLE.COM ' });
  expect(exec.calls.filter((c) => c.name === 'insert' || c.name === 'update')).toEqual([]);
  expect(exec.db.execute).toHaveBeenCalledTimes(1);

  exec.results.push([old], [], []);
  await recordDestinationChangeWithExecutor(exec.db, { ...input, value: 'b@example.com' });
  exec.results.push([{ ...old, valueHash: destinationHash('b@example.com') }], [], []);
  await recordDestinationChangeWithExecutor(exec.db, input);
  const writes = exec.calls.filter((c) => c.name === 'values').map((c) => c.args[0]);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ valueHash: old.valueHash, source: 'import', valueRedacted: 'a***@example.com' });
  expect(writes[1]).not.toHaveProperty('setAt');
  expect(writes[1]).not.toHaveProperty('attestedAt');

  // Clearing supersedes without inserting; a malformed value likewise supersedes but creates no usable destination.
  exec.results.push([old], []);
  await recordDestinationChangeWithExecutor(exec.db, { ...input, value: null });
  exec.results.push([old], []);
  await recordDestinationChangeWithExecutor(exec.db, { ...input, value: 'garbage' });
  expect(exec.calls.filter((c) => c.name === 'insert')).toHaveLength(2);
  expect(exec.calls.filter((c) => c.name === 'update')).toHaveLength(4);

  // No prior row and nothing usable: no-op.
  exec.results.push([]);
  await recordDestinationChangeWithExecutor(exec.db, { ...input, value: null });
  expect(exec.calls.filter((c) => c.name === 'update')).toHaveLength(4);
});
