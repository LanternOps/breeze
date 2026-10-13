import { describe, expect, it } from 'vitest';
import { groupExecutionsByScript, outputExcerpt } from './scriptLatestResults';

describe('groupExecutionsByScript (#7413)', () => {
  it('orders runs newest-first regardless of input order, and groups by latest run', () => {
    const groups = groupExecutionsByScript(
      [
        { scriptId: 'a', startedAt: '2026-01-01T00:00:00Z' },
        { scriptId: 'b', startedAt: '2026-01-03T00:00:00Z' },
        { scriptId: 'a', startedAt: '2026-01-02T00:00:00Z' },
      ],
    );
    expect(groups.map(g => g.key)).toEqual(['b', 'a']);
    expect(groups[1]!.runs.map(r => r.startedAt)).toEqual(['2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z']);
    expect(groups[1]!.latest).toBe(groups[1]!.runs[0]);
  });

  it('never merges runs that carry no script identity', () => {
    const groups = groupExecutionsByScript([
      { id: 'x', startedAt: '2026-01-02T00:00:00Z' },
      { id: 'y', startedAt: '2026-01-01T00:00:00Z' },
    ]);
    expect(groups.map(g => g.key)).toEqual(['run:x', 'run:y']);
  });

  it('keeps API order for runs without a usable timestamp', () => {
    const groups = groupExecutionsByScript([{ scriptId: 'a', stdout: 'first' }, { scriptId: 'a', stdout: 'second' }]);
    expect(groups[0]!.latest.stdout).toBe('first');
  });
});

describe('outputExcerpt (#7413)', () => {
  it('uses the last non-empty stdout line', () => {
    expect(outputExcerpt({ stdout: 'a\nb\n\n' })).toBe('b');
  });

  it('handles double-serialized literal \\n sequences', () => {
    expect(outputExcerpt({ stdout: 'a\\nlast' })).toBe('last');
  });

  it('falls back to the error message, then stderr', () => {
    expect(outputExcerpt({ stdout: '', errorMessage: 'boom', stderr: 'x' })).toBe('boom');
    expect(outputExcerpt({ stderr: 'e1\ne2' })).toBe('e2');
    expect(outputExcerpt({})).toBe('');
  });

  it('truncates long lines with an ellipsis', () => {
    const out = outputExcerpt({ stdout: 'x'.repeat(500) });
    expect(out.length).toBe(140);
    expect(out.endsWith('…')).toBe(true);
  });
});
