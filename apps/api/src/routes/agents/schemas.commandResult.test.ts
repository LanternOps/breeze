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

describe('command_result `result` size cap (#3001)', () => {
  it('pins MAX_COMMAND_RESULT_BYTES to the value the agent mirrors', () => {
    // The agent bounds its payloads against its own copy of this number. If
    // this changes without agent/internal/wire/limits.go changing in the same
    // commit, agents build results to a budget the server no longer honours —
    // which is exactly how #3001 stayed invisible: the agent bounded against a
    // 16 MiB IPC frame while the server enforced 1 MiB here.
    expect(MAX_COMMAND_RESULT_BYTES).toBe(1_048_576);
  });

  it('matches the Go mirror in agent/internal/wire/limits.go', () => {
    const source = readFileSync(GO_LIMITS_PATH, 'utf8');
    // Anchored on `const` so a doc comment containing
    // "MaxCommandResultBytes = <number>" cannot retarget the pin onto prose,
    // letting the real constant drift while this test passes against a sentence.
    const declaration = source.match(/const\s+MaxCommandResultBytes\s*=\s*([0-9*\s]+)/)?.[1];
    if (declaration === undefined) {
      throw new Error(`no \`const MaxCommandResultBytes = <number>\` declaration found in ${GO_LIMITS_PATH}`);
    }

    // The Go side writes it as an arithmetic literal (1024 * 1024).
    const goValue = declaration
      .split('*')
      .map((part) => Number(part.trim()))
      .reduce((a, b) => a * b, 1);

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

  it('rejects a ~2 MB snapshot file index — the shape that reproduced #3001', () => {
    // ~4,000 snapshot entries at ~522 B each is what a 4,000-file backup
    // produced; the terminal result was refused here and the job was reaped as
    // stalled. A 1,200-file run (~0.6 MB) passed, which is why the loss
    // threshold sat between the two.
    const files = Array.from({ length: 4000 }, (_, i) => ({
      sourcePath: `C:\\Users\\jdoe\\AppData\\Local\\Cache\\Cache_Data\\f_${i}${'x'.repeat(60)}`,
      backupPath: `snapshot-1/C_/Users/jdoe/AppData/Local/Cache/Cache_Data/f_${i}${'y'.repeat(60)}`,
      checksum: 'a'.repeat(64),
      size: 4096 + i,
      modTime: '2026-07-14T09:12:33Z',
    }));
    const body = { id: 'job-1', status: 'completed', snapshot: { id: 'snapshot-1', files } };

    expect(commandResultResultByteLength(body)!).toBeGreaterThan(MAX_COMMAND_RESULT_BYTES);
    expect(commandResultSchema.safeParse(validResult({ result: body })).success).toBe(false);

    // ...and the degraded form the agent now sends instead is accepted, with
    // the terminal status intact.
    const degraded = { ...body, snapshot: { id: 'snapshot-1', files: [] } };
    const parsed = commandResultSchema.safeParse(validResult({ result: degraded }));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.status).toBe('completed');
  });

  it('allows an absent or null result body', () => {
    expect(commandResultSchema.safeParse(validResult()).success).toBe(true);
    expect(commandResultSchema.safeParse(validResult({ result: null })).success).toBe(true);
  });

  it('does not apply the result cap to stdout, which has its own 5 MB budget', () => {
    // Guards against a fix that "unifies" the caps by tightening stdout: script
    // output legitimately runs to megabytes and must not start being rejected.
    const parsed = commandResultSchema.safeParse(
      validResult({ stdout: 'x'.repeat(MAX_COMMAND_RESULT_BYTES + 1) })
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
