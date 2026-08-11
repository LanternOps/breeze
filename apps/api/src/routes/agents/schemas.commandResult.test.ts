import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  commandResultSchema,
  commandResultResultByteLength,
  MAX_COMMAND_RESULT_BYTES,
} from './schemas';

// The Go mirror of the cap. Relative to this file's directory.
const GO_LIMITS_PATH = resolve(__dirname, '../../../../../agent/internal/wire/limits.go');

function validResult(overrides: Record<string, unknown> = {}) {
  return {
    status: 'completed' as const,
    exitCode: 0,
    ...overrides,
  };
}

/**
 * Build a `result` value whose JSON.stringify output is exactly `bytes` long.
 * A single ASCII string field lets the size be dialled precisely, which is what
 * makes the boundary assertions meaningful rather than approximate.
 */
function resultOfExactBytes(bytes: number) {
  // {"p":"<padding>"} => 10 bytes of structure around the padding.
  const structural = JSON.stringify({ p: '' }).length;
  return { p: 'x'.repeat(bytes - structural) };
}

/** A backup run body carrying `count` snapshot file-index entries (~522 B each). */
function snapshotBody(count: number) {
  const files = Array.from({ length: count }, (_, i) => ({
    sourcePath: `C:\\Users\\jdoe\\AppData\\Local\\Cache\\Cache_Data\\f_${i}${'x'.repeat(60)}`,
    backupPath: `snapshot-1/C_/Users/jdoe/AppData/Local/Cache/Cache_Data/f_${i}${'y'.repeat(60)}`,
    checksum: 'a'.repeat(64),
    size: 4096 + i,
    modTime: '2026-07-14T09:12:33Z',
  }));
  return { id: 'job-1', status: 'completed', snapshot: { id: 'snapshot-1', files } };
}

describe('command_result `result` size cap (#3001)', () => {
  it('pins MAX_COMMAND_RESULT_BYTES to the value the agent mirrors', () => {
    // The agent bounds its payloads against its own copy of this number. If
    // this changes without agent/internal/wire/limits.go changing in the same
    // commit, agents build results to a budget the server no longer honours —
    // which is exactly how #3001 stayed invisible: the agent bounded against a
    // 16 MiB IPC frame while the server enforced far less here.
    expect(MAX_COMMAND_RESULT_BYTES).toBe(5_000_000);
  });

  it('equals the stdout/stderr caps in the same schema', () => {
    // The invariant the raise from 1 MiB established, asserted so it cannot
    // erode back. `result`, `stdout` and `stderr` travel in one message from
    // one authenticated agent; the old split between them is what let the
    // backup forwarder inherit a five-times-tighter limit than anyone had
    // reasoned about (#3001). Derived from the schema rather than hardcoded so
    // moving any one of the three without the others fails here.
    const stdoutMax = 'x'.repeat(MAX_COMMAND_RESULT_BYTES);
    expect(commandResultSchema.safeParse(validResult({ stdout: stdoutMax })).success).toBe(true);
    expect(commandResultSchema.safeParse(validResult({ stdout: stdoutMax + 'x' })).success).toBe(false);
    expect(commandResultSchema.safeParse(validResult({ stderr: stdoutMax })).success).toBe(true);
    expect(commandResultSchema.safeParse(validResult({ stderr: stdoutMax + 'x' })).success).toBe(false);
  });

  it('matches the Go mirror in agent/internal/wire/limits.go', () => {
    const source = readFileSync(GO_LIMITS_PATH, 'utf8');
    // Anchored on `const` so a doc comment containing
    // "MaxCommandResultBytes = <number>" cannot retarget the pin onto prose,
    // letting the real constant drift while this test passes against a sentence.
    const declaration = source.match(/const\s+MaxCommandResultBytes\s*=\s*([0-9_*\s]+)/)?.[1];
    if (declaration === undefined) {
      throw new Error(`no \`const MaxCommandResultBytes = <number>\` declaration found in ${GO_LIMITS_PATH}`);
    }

    // Go may write it as a plain literal with digit separators (5_000_000) or
    // as an arithmetic one (1024 * 1024); accept both so the pin survives a
    // reformat of the constant it guards.
    const goValue = declaration
      .split('*')
      .map((part) => Number(part.trim().replace(/_/g, '')))
      .reduce((a, b) => a * b, 1);

    expect(Number.isFinite(goValue)).toBe(true);

    expect(goValue).toBe(MAX_COMMAND_RESULT_BYTES);
  });

  it('accepts a result body exactly at the cap', () => {
    const parsed = commandResultSchema.safeParse(
      validResult({ result: resultOfExactBytes(MAX_COMMAND_RESULT_BYTES) })
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a result body one byte over the cap', () => {
    const parsed = commandResultSchema.safeParse(
      validResult({ result: resultOfExactBytes(MAX_COMMAND_RESULT_BYTES + 1) })
    );
    expect(parsed.success).toBe(false);
    // The message must name the limit and the field, because the WS handler
    // logs these issues verbatim and an operator reads them cold.
    expect(JSON.stringify(parsed.success ? [] : parsed.error.issues)).toContain(
      String(MAX_COMMAND_RESULT_BYTES)
    );
  });

  it('now ACCEPTS the ~2 MB index that reproduced #3001, and still rejects a genuinely oversize one', () => {
    // The whole point of the raise. ~4,000 entries at ~522 B each is what the
    // v0.104.0 QA reproduction produced; under the old 1 MiB cap this was
    // refused and the job was reaped as stalled. It now lands WITH its file
    // index, so those endpoints keep restore browsing instead of degrading.
    const under = snapshotBody(4000);
    expect(commandResultResultByteLength(under)!).toBeGreaterThan(1_048_576);
    expect(commandResultResultByteLength(under)!).toBeLessThan(MAX_COMMAND_RESULT_BYTES);
    const accepted = commandResultSchema.safeParse(validResult({ result: under }));
    expect(accepted.success).toBe(true);
    expect(accepted.success && accepted.data.status).toBe('completed');

    // The cap still exists: a large enough index is refused, which is what the
    // agent's tiered degradation is there to prevent from ever being sent.
    const over = snapshotBody(20000);
    expect(commandResultResultByteLength(over)!).toBeGreaterThan(MAX_COMMAND_RESULT_BYTES);
    expect(commandResultSchema.safeParse(validResult({ result: over })).success).toBe(false);

    // ...and the degraded form the agent sends instead is accepted, with the
    // terminal status intact.
    const degraded = { ...over, snapshot: { id: 'snapshot-1', files: [] } };
    const parsed = commandResultSchema.safeParse(validResult({ result: degraded }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toBe('completed');
  });

  it('allows an absent or null result body', () => {
    expect(commandResultSchema.safeParse(validResult()).success).toBe(true);
    expect(commandResultSchema.safeParse(validResult({ result: null })).success).toBe(true);
  });

  it('applies the result cap to `result` only, not to the sibling text fields', () => {
    // The caps are equal by design, but they must stay INDEPENDENT checks: a
    // message may legitimately carry a full-size stdout AND a full-size result.
    // A refactor that folded them into one shared budget would start rejecting
    // that, so the combination is asserted directly.
    const full = 'x'.repeat(MAX_COMMAND_RESULT_BYTES);
    const parsed = commandResultSchema.safeParse(
      validResult({ stdout: full, result: resultOfExactBytes(MAX_COMMAND_RESULT_BYTES) })
    );
    expect(parsed.success).toBe(true);
  });

});

describe('commandResultResultByteLength', () => {
  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // The pre-#3097 WS copy measured with .length, accepting roughly 3x the
    // intended budget for CJK-heavy output. Keep that fixed.
    const body = { p: '日'.repeat(100) };
    expect(commandResultResultByteLength(body)).toBe(Buffer.byteLength(JSON.stringify(body), 'utf8'));
    expect(commandResultResultByteLength(body)).toBeGreaterThan(JSON.stringify(body).length);
  });

  it('returns 0 for absent bodies', () => {
    expect(commandResultResultByteLength(undefined)).toBe(0);
    expect(commandResultResultByteLength(null)).toBe(0);
  });

  it('returns null for a body that cannot be serialised, and the schema rejects it', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(commandResultResultByteLength(cyclic)).toBeNull();
    expect(commandResultSchema.safeParse(validResult({ result: cyclic })).success).toBe(false);
  });
});
