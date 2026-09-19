import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// #6098 — boot used to wrap `syncBinaries()` in `runWithSystemDbAccess`,
// holding a pooled connection idle-in-transaction across syncBinaries()'s
// GitHub release/manifest fetch phase for the whole boot (verified: 2.7s
// hold, the #1105 safeFetch tripwire fired x10). The real fix lives in
// binarySync.ts (every DB read/write there now opens its own short
// `withSystemDbAccessContext`, per binarySync.test.ts's "#6098" case) — this
// is the structural half: the boot call site must not re-introduce an ambient
// wrap around it. `index.ts`'s boot sequence isn't otherwise unit-testable
// (it runs as a side effect of import), so this asserts on the source text —
// the same pattern index.pam-actuation-worker.test.ts uses for adjacent boot
// ordering.
describe('boot-time binary sync (#6098)', () => {
  it('does not wrap syncBinaries() in an ambient DB access context', () => {
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

    const callIdx = indexSource.indexOf('await syncBinaries();');
    expect(callIdx).toBeGreaterThan(-1);

    // Look at a small window of source immediately preceding the call: any
    // context-opening wrapper (runWithSystemDbAccess / withSystemDbAccessContext
    // / withDbAccessContext) would appear here if the call were re-wrapped.
    const precedingWindow = indexSource.slice(Math.max(0, callIdx - 200), callIdx);
    expect(precedingWindow).not.toMatch(
      /(runWithSystemDbAccess|withSystemDbAccessContext|withDbAccessContext)\(\s*async\s*\(\s*\)\s*=>\s*\{\s*$/,
    );
  });
});
