import { expect, it } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '@breeze/shared';
import { applyStreaks } from './applyStreaks';
it('initializes every code including the reserved policy findings', () => {
  const result = applyStreaks({}, ['sync_stale']);
  expect(Object.keys(result)).toEqual([...TIME_SYNC_FINDING_CODES]);
  for (const code of TIME_SYNC_FINDING_CODES)
    expect(result[code]).toEqual(
      code === 'sync_stale'
        ? { present: 1, absent: 0 }
        : { present: 0, absent: 1 },
    );
});
it('counts observations once, resets the opposite counter, and preserves input', () => {
  const first = applyStreaks(null, ['sync_stale', 'sync_stale']);
  const before = structuredClone(first);
  const second = applyStreaks(first, ['sync_stale']);
  expect(first).toEqual(before);
  expect(second.sync_stale).toEqual({ present: 2, absent: 0 });
  const clear = applyStreaks(second, []);
  expect(clear.sync_stale).toEqual({ present: 0, absent: 1 });
  expect(applyStreaks(clear, []).sync_stale).toEqual({ present: 0, absent: 2 });
  expect(applyStreaks(clear, ['sync_stale']).sync_stale).toEqual({
    present: 1,
    absent: 0,
  });
});
it('uses the ingest-time timezone result', () => {
  expect(
    applyStreaks(applyStreaks(undefined, ['timezone_mismatch']), [])
      .timezone_mismatch,
  ).toEqual({ present: 0, absent: 1 });
});
