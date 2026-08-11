import { describe, expect, it } from 'vitest';
import { compactToolResultForChat, redactSensitiveToolInput } from './aiToolOutput';

// SR5-16: tool_input is persisted UNCONDITIONALLY to the transcript (even for
// denied calls). Sensitive keys must be masked at that chokepoint.
describe('redactSensitiveToolInput', () => {
  const REDACTED = '[REDACTED]';

  it('masks known-sensitive keys (accessKey/secretKey/password/token/apiKey/clientSecret/privateKey/connectionString)', () => {
    const out = redactSensitiveToolInput({
      accessKey: 'AKIAIOSFODNN7EXAMPLE',
      secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      password: 'hunter2',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      apiKey: 'sk-ant-super-secret',
      clientSecret: 'cs-value',
      privateKey: '-----BEGIN PRIVATE KEY-----',
      connectionString: 'Server=db;Password=p;',
    });

    for (const key of Object.keys(out)) {
      expect(out[key]).toBe(REDACTED);
    }
  });

  it('masks sensitive keys nested inside providerConfig (manage_backup_configs shape)', () => {
    const out = redactSensitiveToolInput({
      provider: 's3',
      providerConfig: {
        region: 'us-east-1',
        bucket: 'backups',
        accessKey: 'AKIA...',
        secretKey: 'super-secret',
      },
    });

    const cfg = out.providerConfig as Record<string, unknown>;
    // Non-sensitive fields survive so the transcript stays useful.
    expect(cfg.region).toBe('us-east-1');
    expect(cfg.bucket).toBe('backups');
    // Secrets are masked.
    expect(cfg.accessKey).toBe(REDACTED);
    expect(cfg.secretKey).toBe(REDACTED);
    expect(out.provider).toBe('s3');
  });

  it('leaves inputs with no sensitive keys untouched', () => {
    const input = { deviceId: 'dev-1', command: 'restart', count: 3, enabled: true };
    expect(redactSensitiveToolInput(input)).toEqual(input);
  });

  it('scrubs inline secret assignments embedded in string values', () => {
    const out = redactSensitiveToolInput({ note: 'use password=hunter2 to connect' });
    expect(out.note).not.toContain('hunter2');
  });
});

describe('compactToolResultForChat', () => {
  it('returns compact JSON preview for oversized non-JSON output', () => {
    const raw = 'x'.repeat(9_500);
    const compacted = compactToolResultForChat('execute_command', raw);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect((parsed._chat as Record<string, unknown>).outputCompacted).toBe(true);
    expect((parsed._chat as Record<string, unknown>).nonJsonOutput).toBe(true);
    expect(typeof parsed.preview).toBe('string');
    expect(parsed.summarized).toBe(true);
  });

  describe('summarized discriminator (#3329)', () => {
    // A row-less digest is HTTP 200 with no error field. Without an explicit
    // marker a programmatic consumer cannot tell it from a record and stores it
    // as data. `_chat` alone is not that marker — it also rides along with
    // payloads whose rows are intact.
    it('marks the row-less digest that replaces an unshrinkable payload', () => {
      // Synthetic worst case for the branch, not a realistic log page: string
      // leaves are budgeted on RAW length while the ceiling is enforced on the
      // JSON-SERIALIZED length, so all-escapable fields double in size after
      // every compaction tier has run and the payload still overflows.
      const escapeDense = '"\n\t'.repeat(400);
      const raw = JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 40 }).map((_, idx) => [`field${idx}`, escapeDense]),
        ),
      );

      const parsed = JSON.parse(compactToolResultForChat('search_logs', raw)) as Record<string, unknown>;

      expect(parsed.summarized).toBe(true);
      expect(parsed.logs).toBeUndefined();
      expect((parsed.summary as Record<string, unknown>).toolName).toBe('search_logs');
    });

    it('does NOT mark a compacted payload whose rows survived', () => {
      const raw = JSON.stringify({
        total: 2_000,
        alerts: Array.from({ length: 500 }).map((_, idx) => ({
          id: `alert-${idx}`,
          title: `Disk usage high on host-${idx}`,
          severity: 'high',
        })),
      });

      const parsed = JSON.parse(compactToolResultForChat('manage_alerts', raw)) as Record<string, unknown>;

      // This is the shape the reporter flagged as ambiguous: `_chat` present,
      // but the rows are real and must still be read.
      expect(parsed._chat).toBeDefined();
      expect(Array.isArray(parsed.alerts)).toBe(true);
      expect((parsed.alerts as unknown[]).length).toBeGreaterThan(0);
      expect(parsed.summarized).toBeUndefined();
    });

    it('does NOT mark a payload that fit without compaction', () => {
      const raw = JSON.stringify({ logs: [{ id: 'log-1', message: 'ok' }] });
      const parsed = JSON.parse(compactToolResultForChat('search_logs', raw)) as Record<string, unknown>;

      expect(parsed.summarized).toBeUndefined();
      expect((parsed.logs as unknown[]).length).toBe(1);
    });
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

  // ─── #3093: structured stdout survives compaction ───────────────────

  it('keeps plain-text stdout up to 6K chars without truncation', () => {
    const stdout = 'log line about nothing sensitive\n'.repeat(150); // ~4,950 chars, non-JSON
    const raw = JSON.stringify({ status: 'completed', exitCode: 0, stdout });

    const compacted = compactToolResultForChat('execute_command', raw);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(parsed.stdout).toBe(stdout);
    expect((parsed.stdout as string).includes('[truncated')).toBe(false);
  });

  it('compacts JSON file_list stdout structurally, preserving the envelope and paging guidance (#3093)', () => {
    const fileListResponse = {
      path: 'C:\\Program Files',
      entries: Array.from({ length: 200 }).map((_, idx) => ({
        name: `app-${idx}`,
        path: `C:\\Program Files\\app-${idx}`,
        type: 'directory',
        size: 4096,
        modified: '2026-08-01T00:00:00Z',
        permissions: 'drwxr-xr-x',
      })),
      limit: 1000,
      truncated: false,
    };
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify(fileListResponse),
      durationMs: 42,
    });

    const compacted = compactToolResultForChat('execute_command', raw);
    expect(compacted.length).toBeLessThanOrEqual(8_000);
    // The whole result must still be valid JSON — the old char-cut broke it mid-string.
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const stdout = parsed.stdout as Record<string, unknown>;

    expect(parsed.status).toBe('completed');
    // Envelope fields survive (the old cut destroyed the trailing limit/truncated keys).
    expect(stdout.path).toBe('C:\\Program Files');
    expect(stdout.limit).toBe(1000);
    expect(Array.isArray(stdout.entries)).toBe(true);
    expect((stdout.entries as unknown[]).length).toBeGreaterThan(0);
    expect((stdout.entries as unknown[]).length).toBeLessThan(200);
    // Explicit, actionable truncation marker.
    const truncation = parsed.stdoutTruncation as Record<string, unknown>;
    expect(truncation.itemsDropped).toBeGreaterThan(0);
    expect(String(truncation.note)).toContain('file_list');
    expect((parsed._chat as Record<string, unknown>).outputCompacted).toBe(true);
  });

  it('compacts JSON list_processes stdout structurally, preserving pagination fields (#3093)', () => {
    const processResponse = {
      processes: Array.from({ length: 120 }).map((_, idx) => ({
        pid: 1000 + idx,
        name: `service-host-${idx}.exe`,
        user: 'SYSTEM',
        cpuPercent: 0.5,
        memoryMb: 128.25,
        status: 'running',
      })),
      total: 312,
      page: 1,
      limit: 120,
      totalPages: 3,
    };
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify(processResponse),
    });

    const compacted = compactToolResultForChat('execute_command', raw);
    expect(compacted.length).toBeLessThanOrEqual(8_000);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const stdout = parsed.stdout as Record<string, unknown>;

    expect(stdout.total).toBe(312);
    expect(stdout.totalPages).toBe(3);
    expect(Array.isArray(stdout.processes)).toBe(true);
    // 120 in → capped at 50 (or tighter): the compaction must actually fire.
    expect((stdout.processes as unknown[]).length).toBeLessThanOrEqual(50);
    expect((parsed.stdoutTruncation as Record<string, unknown>).itemsDropped).toBeGreaterThanOrEqual(70);
    expect(parsed.stdoutChars).toBeGreaterThan(2_000);
  });

  it('lands long-string event-log stdout as valid JSON via the tighter tiers, never the raw preview cut (#3093)', () => {
    const eventLogResponse = {
      logName: 'System',
      events: Array.from({ length: 300 }).map((_, idx) => ({
        recordId: 90_000 + idx,
        level: 'Information',
        source: 'Service Control Manager',
        message: `M${'x'.repeat(899)}`,
      })),
      total: 3_000,
      page: 1,
      limit: 300,
      totalPages: 10,
    };
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify(eventLogResponse),
    });

    const compacted = compactToolResultForChat('execute_command', raw);
    expect(compacted.length).toBeLessThanOrEqual(8_000);
    // Must be structurally valid — this shape used to fall through to the
    // final fallback's mid-string preview slice.
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const stdout = parsed.stdout as Record<string, unknown>;

    expect(parsed._chat).toBeDefined();
    expect((parsed._chat as Record<string, unknown>).reason).toBeUndefined();
    expect(stdout.logName).toBe('System');
    expect(stdout.total).toBe(3_000);
    expect(Array.isArray(stdout.events)).toBe(true);
    expect((stdout.events as unknown[]).length).toBeGreaterThan(0);
    const truncation = parsed.stdoutTruncation as Record<string, unknown>;
    expect(truncation.itemsDropped).toBe(300 - (stdout.events as unknown[]).length);
    expect(String(truncation.note)).toContain('event_logs_query');
  });

  it('redacts key-form secrets inside JSON stdout before it reaches the model', () => {
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify({
        services: [
          { name: 'svc', password: 'hunter2-super-secret', apiKey: 'plain-key-value-123', token: 'tok_zzz' },
        ],
      }),
    });

    const compacted = compactToolResultForChat('execute_command', raw);

    expect(compacted).not.toContain('hunter2-super-secret');
    expect(compacted).not.toContain('plain-key-value-123');
    expect(compacted).not.toContain('tok_zzz');
    expect(compacted).toContain('[REDACTED]');
    // The non-secret sibling survives redaction.
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const services = (parsed.stdout as Record<string, unknown>).services as Record<string, unknown>[];
    expect(services[0]?.name).toBe('svc');
  });

  it('reports cumulative truncation on long string leaves and steers away from useless paging', () => {
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify({ report: 'x'.repeat(3_000) }),
    });

    const compacted = compactToolResultForChat('execute_command', raw);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const stdout = parsed.stdout as Record<string, unknown>;

    // The marker must report the true omitted count (1500), not the marker's
    // own overhang from a second truncation pass (the old "26 chars" bug).
    expect(stdout.report).toMatch(/\[truncated 1500 chars\]$/);
    expect((parsed._chat as Record<string, unknown>).stringsTruncated).toBe(1);
    // Nothing pageable was dropped — the note must NOT tell the model to page.
    const truncation = parsed.stdoutTruncation as Record<string, unknown>;
    expect(truncation.itemsDropped).toBe(0);
    expect(String(truncation.note)).toContain('narrower command');
  });

  it('keeps the truncation marker accurate when only a tighter tier drops items', () => {
    // 45 chunky processes: under the 50-item first-tier cap, but too big to
    // serialize — the tighter tier drops to 20 and the marker must say so
    // (this case used to ship with NO stdoutTruncation at all).
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify({
        processes: Array.from({ length: 45 }).map((_, idx) => ({
          pid: 2_000 + idx,
          name: `chunky-${idx}.exe`,
          commandLine: `--flag=${'v'.repeat(280)}`,
        })),
        total: 45,
      }),
    });

    const compacted = compactToolResultForChat('execute_command', raw);
    expect(compacted.length).toBeLessThanOrEqual(8_000);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const stdout = parsed.stdout as Record<string, unknown>;
    const kept = (stdout.processes as unknown[]).length;

    expect(kept).toBeLessThan(45);
    const truncation = parsed.stdoutTruncation as Record<string, unknown>;
    expect(truncation.itemsDropped).toBe(45 - kept);
  });

  it('returns small JSON stdout as a parsed object without truncation metadata', () => {
    const raw = JSON.stringify({
      status: 'completed',
      exitCode: 0,
      stdout: JSON.stringify({ path: '/tmp', entries: [{ name: 'a.txt', type: 'file', size: 12 }], truncated: false }),
    });

    const compacted = compactToolResultForChat('execute_command', raw);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;
    const stdout = parsed.stdout as Record<string, unknown>;

    expect(stdout.path).toBe('/tmp');
    expect(parsed.stdoutTruncation).toBeUndefined();
    expect(parsed._chat).toBeUndefined();
  });

  // ─── Fleet tool compaction ──────────────────────────────────────────

  it('compacts oversized list_configuration_policies output', () => {
    const raw = JSON.stringify({
      policies: Array.from({ length: 80 }).map((_, i) => ({
        id: `policy-${i}`,
        name: `Policy ${i}`,
        status: 'active',
        featureTypes: ['patch', 'alert_rule'],
      })),
      showing: 80,
    });

    const compacted = compactToolResultForChat('list_configuration_policies', raw + ' '.repeat(5_000));
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

    const compacted = compactToolResultForChat('list_configuration_policies', raw);
    expect(compacted).toBe(raw);
  });

  it('redacts secrets even when raw output is below the compaction threshold', () => {
    const raw = JSON.stringify({
      status: 'completed',
      stdout: 'login ok token=abc123 password=hunter2',
      nested: { apiKey: 'sk-ant-supersecret000000000000' },
    });

    const compacted = compactToolResultForChat('execute_command', raw);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(JSON.stringify(parsed)).not.toContain('abc123');
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    expect(JSON.stringify(parsed)).not.toContain('sk-ant');
    expect(parsed.stdout).toContain('[REDACTED]');
  });

  it('omits script content from get_script_details output', () => {
    const script = 'param($Token)\nWrite-Host "secret=$Token"\n'.repeat(20);
    const raw = JSON.stringify({
      id: 'script-1',
      name: 'Reset service',
      content: script,
      parameters: [{ name: 'Token', defaultValue: 'token=abc123' }],
    });

    const compacted = compactToolResultForChat('get_script_details', raw);
    const parsed = JSON.parse(compacted) as Record<string, unknown>;

    expect(parsed.content).toBeUndefined();
    expect(parsed.contentOmitted).toBe(true);
    expect(parsed.contentChars).toBe(script.length);
    expect(JSON.stringify(parsed)).not.toContain('Write-Host');
    expect(JSON.stringify(parsed)).not.toContain('abc123');
    expect((parsed._chat as Record<string, unknown>).sensitiveFieldsOmitted).toBe(1);
  });

  it('redacts small non-JSON output before returning it to chat', () => {
    const compacted = compactToolResultForChat(
      'execute_command',
      'Authorization: Bearer raw-token\naws key AKIA1234567890ABCDEF',
    );

    expect(compacted).not.toContain('raw-token');
    expect(compacted).not.toContain('AKIA1234567890ABCDEF');
    expect(compacted).toContain('[REDACTED]');
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
