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

  // ─── Fleet tool compaction ──────────────────────────────────────────

  it('compacts oversized manage_policies list output', () => {
    const raw = JSON.stringify({
      policies: Array.from({ length: 80 }).map((_, i) => ({
        id: `policy-${i}`,
        name: `Policy ${i}`,
        enforcement: 'enforce',
        enabled: true,
        compliance: { compliant: 50, total: 60 },
      })),
      total: 80,
    });

    const compacted = compactToolResultForChat('manage_policies', raw + ' '.repeat(5_000));
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(Array.isArray(parsed.policies)).toBe(true);
    expect((parsed.policies as unknown[]).length).toBeLessThanOrEqual(40);
    expect(parsed.policiesDropped).toBeGreaterThan(0);
  });

  it('compacts oversized manage_groups list output', () => {
    const raw = JSON.stringify({
      groups: Array.from({ length: 60 }).map((_, i) => ({
        id: `group-${i}`,
        name: `Group ${i}`,
        type: 'static',
        memberCount: i * 5,
      })),
    });

    const compacted = compactToolResultForChat('manage_groups', raw + ' '.repeat(5_000));
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(Array.isArray(parsed.groups)).toBe(true);
    expect((parsed.groups as unknown[]).length).toBeLessThanOrEqual(40);
    expect(parsed.groupsDropped).toBeGreaterThan(0);
  });

  it('compacts oversized generate_report data output', () => {
    const raw = JSON.stringify({
      data: Array.from({ length: 100 }).map((_, i) => ({
        hostname: `device-${i}`,
        os: 'windows',
        status: 'online',
        lastSeen: '2026-02-13T00:00:00Z',
      })),
      reportType: 'device_inventory',
    });

    const compacted = compactToolResultForChat('generate_report', raw + ' '.repeat(5_000));
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(Array.isArray(parsed.data)).toBe(true);
    expect((parsed.data as unknown[]).length).toBeLessThanOrEqual(40);
    expect(parsed.dataDropped).toBeGreaterThan(0);
  });

  it('compacts oversized manage_deployments devices output', () => {
    const raw = JSON.stringify({
      devices: Array.from({ length: 70 }).map((_, i) => ({
        id: `device-${i}`,
        hostname: `host-${i}`,
        status: i % 3 === 0 ? 'completed' : 'pending',
      })),
    });

    const compacted = compactToolResultForChat('manage_deployments', raw + ' '.repeat(5_000));
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(Array.isArray(parsed.devices)).toBe(true);
    expect((parsed.devices as unknown[]).length).toBeLessThanOrEqual(40);
    expect(parsed.devicesDropped).toBeGreaterThan(0);
  });

  it('does not compact fleet tools when output is under threshold', () => {
    const raw = JSON.stringify({
      policies: [{ id: '1', name: 'Small list' }],
    });

    const compacted = compactToolResultForChat('manage_policies', raw);
    expect(compacted).toBe(raw);
  });

  it('compacts oversized manage_automations runs output', () => {
    const raw = JSON.stringify({
      runs: Array.from({ length: 50 }).map((_, i) => ({
        id: `run-${i}`,
        status: 'completed',
        startedAt: '2026-02-13T00:00:00Z',
        durationMs: 1234,
      })),
    });

    const compacted = compactToolResultForChat('manage_automations', raw + ' '.repeat(5_000));
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(Array.isArray(parsed.runs)).toBe(true);
    expect((parsed.runs as unknown[]).length).toBeLessThanOrEqual(40);
    expect(parsed.runsDropped).toBeGreaterThan(0);
  });
});
