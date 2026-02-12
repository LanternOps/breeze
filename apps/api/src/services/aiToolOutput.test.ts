import { describe, expect, it } from 'vitest';
import { compactToolResultForChat } from './aiToolOutput';

describe('compactToolResultForChat', () => {
  it('returns compact JSON preview for oversized non-JSON output', () => {
    const raw = 'x'.repeat(9_500);
    const compacted = compactToolResultForChat('execute_command', raw);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect((parsed._chat as Record<string, unknown>).outputCompacted).toBe(true);
    expect((parsed._chat as Record<string, unknown>).nonJsonOutput).toBe(true);
    expect(typeof parsed.preview).toBe('string');
  });

  it('truncates disk cleanup candidates and reports counts', () => {
    const raw = JSON.stringify({
      action: 'preview',
      candidateCount: 120,
      candidates: Array.from({ length: 120 }).map((_, idx) => ({
        path: `/tmp/file-${idx}`,
        category: 'temp_files',
        sizeBytes: 1024 + idx,
      })),
    });

    const compacted = compactToolResultForChat('disk_cleanup', raw + ' '.repeat(9_000));
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect((parsed.candidates as unknown[]).length).toBeLessThanOrEqual(60);
    expect(parsed.truncatedCandidateCount).toBeGreaterThan(0);
  });

  it('truncates oversized stdout from command-style payloads', () => {
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: 'line\n'.repeat(3_000),
      data: {
        entries: Array.from({ length: 200 }).map((_, idx) => ({ id: idx, name: `item-${idx}` })),
      },
    });

    const compacted = compactToolResultForChat('execute_command', raw + ' '.repeat(9_000));
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(parsed.status).toBe('completed');
    expect(typeof parsed.stdout).toBe('string');
    expect((parsed.stdout as string).includes('[truncated')).toBe(true);
    expect((parsed._chat as Record<string, unknown>).outputCompacted).toBe(true);
  });
});
