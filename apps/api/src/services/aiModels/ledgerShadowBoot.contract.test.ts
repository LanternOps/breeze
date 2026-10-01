import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

describe('invocation ledger shadow is registered in every process that records AI cost (#7600 W02)', () => {
  it.each(['index.ts', 'worker.ts'])('%s registers the listener', (file) => {
    expect(src(file)).toMatch(/registerInvocationLedgerShadow\(\)/);
  });
});
