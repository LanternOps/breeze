import { describe, expect, it } from 'vitest';
import { ACT_ELIGIBLE_TOOL_NAMES, ACT_MANIFEST, resolveActOperation } from './actManifest';

const RUN_DEVICE_ID = 'device-aaaa-1111';
const OTHER_DEVICE_ID = 'device-bbbb-2222';

describe('ACT_MANIFEST frozen key set', () => {
  it('contains EXACTLY the six locked keys, in the locked order — a literal frozen-list assertion', () => {
    // Deliberately NOT `.sort()`'d and NOT a `Set` comparison: growing,
    // shrinking, renaming, or reordering this manifest is a quorum decision
    // (plan header), so this assertion must break on any of those, not just
    // membership changes.
    expect(ACT_MANIFEST.map((op) => op.key)).toEqual([
      'manage_services.restart',
      'disk_cleanup.execute',
      'manage_processes.kill',
      'run_script',
      'execute_playbook',
      'remediation_suggestion',
    ]);
  });

  it('never contains an execute_command entry — no manifest key, ever, without a quorum decision', () => {
    expect(ACT_MANIFEST.some((op) => op.toolName === 'execute_command')).toBe(false);
    expect(ACT_MANIFEST.some((op) => op.key === 'execute_command')).toBe(false);
  });

  it('ACT_ELIGIBLE_TOOL_NAMES tracks the manifest but excludes the virtual remediation_suggestion sentinel (Task 6)', () => {
    expect([...ACT_ELIGIBLE_TOOL_NAMES].sort()).toEqual([
      'disk_cleanup',
      'execute_playbook',
      'manage_processes',
      'manage_services',
      'run_script',
    ]);
    expect(ACT_ELIGIBLE_TOOL_NAMES).not.toContain('remediation_suggestion');
    expect(ACT_ELIGIBLE_TOOL_NAMES).not.toContain('execute_command');
  });

  it('resolveActOperation never resolves execute_command regardless of input shape', () => {
    expect(resolveActOperation('execute_command', { action: 'restart' })).toBeNull();
    expect(resolveActOperation('execute_command', { commandType: 'restart_service' })).toBeNull();
    expect(resolveActOperation('execute_command', {})).toBeNull();
  });
});

describe('resolveActOperation — manage_services', () => {
  it('matches restart', () => {
    const op = resolveActOperation('manage_services', { deviceId: RUN_DEVICE_ID, action: 'restart', serviceName: 'spooler' });
    expect(op?.key).toBe('manage_services.restart');
  });

  it.each(['start', 'stop', 'list'])('does NOT match %s — start/stop/list stay proposal-only', (action) => {
    expect(resolveActOperation('manage_services', { deviceId: RUN_DEVICE_ID, action, serviceName: 'spooler' })).toBeNull();
  });

  it('does not match a missing action', () => {
    expect(resolveActOperation('manage_services', { deviceId: RUN_DEVICE_ID, serviceName: 'spooler' })).toBeNull();
  });
});

describe('resolveActOperation — disk_cleanup', () => {
  it('matches execute', () => {
    const op = resolveActOperation('disk_cleanup', { deviceId: RUN_DEVICE_ID, action: 'execute', paths: ['/tmp/a'] });
    expect(op?.key).toBe('disk_cleanup.execute');
  });

  it('does not match preview', () => {
    expect(resolveActOperation('disk_cleanup', { deviceId: RUN_DEVICE_ID, action: 'preview' })).toBeNull();
  });
});

describe('resolveActOperation — manage_processes', () => {
  it('matches kill', () => {
    const op = resolveActOperation('manage_processes', { deviceId: RUN_DEVICE_ID, action: 'kill', processId: '4242', processName: 'notepad.exe' });
    expect(op?.key).toBe('manage_processes.kill');
  });

  it('does not match list', () => {
    expect(resolveActOperation('manage_processes', { deviceId: RUN_DEVICE_ID, action: 'list' })).toBeNull();
  });
});

describe('resolveActOperation — run_script', () => {
  it('matches a saved-script call', () => {
    const op = resolveActOperation('run_script', { scriptId: 'script-1', deviceIds: [RUN_DEVICE_ID] });
    expect(op?.key).toBe('run_script');
  });

  it('does not match a call with no scriptId', () => {
    expect(resolveActOperation('run_script', { deviceIds: [RUN_DEVICE_ID] })).toBeNull();
  });
});

describe('resolveActOperation — execute_playbook', () => {
  it('matches a call with playbookId + deviceId (built-in-ness is decided downstream, with I/O)', () => {
    const op = resolveActOperation('execute_playbook', { playbookId: 'pb-1', deviceId: RUN_DEVICE_ID });
    expect(op?.key).toBe('execute_playbook');
  });

  it('does not match without a deviceId', () => {
    expect(resolveActOperation('execute_playbook', { playbookId: 'pb-1' })).toBeNull();
  });
});

describe('resolveActOperation — remediation_suggestion is unreachable via raw tool dispatch', () => {
  it('never resolves for any input — it is matched only by the Task 7 resolver', () => {
    expect(resolveActOperation('remediation_suggestion', { suggestionId: 'sugg-1' })).toBeNull();
    expect(ACT_MANIFEST.find((op) => op.key === 'remediation_suggestion')?.matches({ suggestionId: 'sugg-1' })).toBe(false);
  });
});

describe('normalizeTarget — device-arg pinning (single-device act mode is fail-closed)', () => {
  it('manage_services.restart rejects a deviceId that does not match the run device', () => {
    const op = resolveActOperation('manage_services', { deviceId: OTHER_DEVICE_ID, action: 'restart', serviceName: 'spooler' });
    expect(op).not.toBeNull();
    const result = op!.normalizeTarget({ deviceId: OTHER_DEVICE_ID, action: 'restart', serviceName: 'spooler' }, RUN_DEVICE_ID);
    expect(result.ok).toBe(false);
    expect((result as { deviceMismatch?: boolean }).deviceMismatch).toBe(true);
  });

  it('manage_services.restart accepts a matching deviceId and extracts the service target', () => {
    const op = resolveActOperation('manage_services', { deviceId: RUN_DEVICE_ID, action: 'restart', serviceName: 'spooler' });
    const result = op!.normalizeTarget({ deviceId: RUN_DEVICE_ID, action: 'restart', serviceName: 'spooler' }, RUN_DEVICE_ID);
    expect(result).toEqual({ ok: true, target: { kind: 'service', serviceName: 'spooler' } });
  });

  it('disk_cleanup.execute rejects a mismatched device', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'disk_cleanup.execute')!;
    const result = op.normalizeTarget({ deviceId: OTHER_DEVICE_ID, action: 'execute', paths: ['/tmp/a'] }, RUN_DEVICE_ID);
    expect(result.ok).toBe(false);
    expect((result as { deviceMismatch?: boolean }).deviceMismatch).toBe(true);
  });

  it('disk_cleanup.execute rejects empty paths', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'disk_cleanup.execute')!;
    const result = op.normalizeTarget({ deviceId: RUN_DEVICE_ID, action: 'execute', paths: [] }, RUN_DEVICE_ID);
    expect(result.ok).toBe(false);
    expect((result as { deviceMismatch?: boolean }).deviceMismatch).toBeFalsy();
  });

  it('manage_processes.kill rejects a mismatched device', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'manage_processes.kill')!;
    const result = op.normalizeTarget(
      { deviceId: OTHER_DEVICE_ID, action: 'kill', processId: '4242', processName: 'notepad.exe' },
      RUN_DEVICE_ID,
    );
    expect(result.ok).toBe(false);
    expect((result as { deviceMismatch?: boolean }).deviceMismatch).toBe(true);
  });

  it('manage_processes.kill rejects a bare pid with no processName — identity revalidation, not bare PID', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'manage_processes.kill')!;
    const result = op.normalizeTarget({ deviceId: RUN_DEVICE_ID, action: 'kill', processId: '4242' }, RUN_DEVICE_ID);
    expect(result.ok).toBe(false);
    // Review fix (#3826 final-review): missing processName is a
    // missing-identity-field failure, NOT a device mismatch — it must not
    // carry `deviceMismatch: true`, or actRevalidation.ts would hard-deny it
    // instead of downgrading to a proposal (a narrower approval surface than
    // shadow mode gives the exact same call).
    expect((result as { deviceMismatch?: boolean }).deviceMismatch).toBeFalsy();
  });

  it('manage_processes.kill accepts pid + processName on the matching device', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'manage_processes.kill')!;
    const result = op.normalizeTarget(
      { deviceId: RUN_DEVICE_ID, action: 'kill', processId: '4242', processName: 'notepad.exe' },
      RUN_DEVICE_ID,
    );
    expect(result).toEqual({ ok: true, target: { kind: 'process', pid: '4242', processName: 'notepad.exe' } });
  });

  it('run_script rejects deviceIds that do not equal exactly [runDeviceId] — the plan\'s literal requirement', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'run_script')!;
    for (const input of [
      { scriptId: 's-1', deviceIds: [OTHER_DEVICE_ID] },
      { scriptId: 's-1', deviceIds: [RUN_DEVICE_ID, OTHER_DEVICE_ID] },
      { scriptId: 's-1', deviceIds: [] },
      { scriptId: 's-1' },
    ]) {
      const result = op.normalizeTarget(input, RUN_DEVICE_ID);
      expect(result.ok).toBe(false);
      // A sibling/extra/missing device arg is treated as a device-mismatch
      // safety boundary, not a soft identity gap — actRevalidation.ts must
      // hard-deny it, exactly as the plan's "sibling-device arg → deny"
      // Task 3 contract requires (final-review fix, #3826).
      expect((result as { deviceMismatch?: boolean }).deviceMismatch).toBe(true);
    }
  });

  it('run_script accepts deviceIds === [runDeviceId] exactly', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'run_script')!;
    const result = op.normalizeTarget({ scriptId: 's-1', deviceIds: [RUN_DEVICE_ID] }, RUN_DEVICE_ID);
    expect(result).toEqual({ ok: true, target: { kind: 'script', scriptId: 's-1' } });
  });

  it('execute_playbook rejects a mismatched device', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'execute_playbook')!;
    const result = op.normalizeTarget({ deviceId: OTHER_DEVICE_ID, playbookId: 'pb-1' }, RUN_DEVICE_ID);
    expect(result.ok).toBe(false);
    expect((result as { deviceMismatch?: boolean }).deviceMismatch).toBe(true);
  });

  it('execute_playbook accepts a matching device', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'execute_playbook')!;
    const result = op.normalizeTarget({ deviceId: RUN_DEVICE_ID, playbookId: 'pb-1' }, RUN_DEVICE_ID);
    expect(result).toEqual({ ok: true, target: { kind: 'playbook', playbookId: 'pb-1' } });
  });

  it('remediation_suggestion.normalizeTarget always fails — it is never called through the real pipeline', () => {
    const op = ACT_MANIFEST.find((o) => o.key === 'remediation_suggestion')!;
    expect(op.normalizeTarget({}, RUN_DEVICE_ID).ok).toBe(false);
  });
});
