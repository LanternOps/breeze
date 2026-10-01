import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
const path = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../docs/src/content/docs/features/time-sync.mdx',
);
it('explains opt-in attachment, independent subjects, freshness and evidence limits', () => {
  const doc = readFileSync(path, 'utf8');
  for (const text of [
    '## Alerts',
    'time_source_problem',
    'time_sync_stale',
    'timezone_mismatch',
    'not attached by default',
    'accepted snapshots',
    'unknown does not resolve',
    '90 minutes',
    '## Evidence exports',
    '400',
    'UTC',
    'Observed synchronization reported by the Breeze agent; days without a report are listed as gaps.',
    'not an attestation',
    'current device population',
    'deleted with the device',
  ])
    expect(doc).toContain(text);
});
