import { describe, it, expect } from 'vitest';
import { getToolTimeout, withToolTimeout } from './toolTimeouts';

describe('getToolTimeout', () => {
  it('returns the override for a known slow tool', () => {
    expect(getToolTimeout('take_screenshot')).toBe(120_000);
  });
  it('returns the override for command execution tools', () => {
    expect(getToolTimeout('execute_command')).toBe(120_000);
    expect(getToolTimeout('run_script')).toBe(120_000);
  });
  it('returns the override for disk operations', () => {
    expect(getToolTimeout('analyze_disk_usage')).toBe(90_000);
    expect(getToolTimeout('disk_cleanup')).toBe(90_000);
  });
  it('returns the override for security scans', () => {
    expect(getToolTimeout('security_scan')).toBe(120_000);
    expect(getToolTimeout('apply_cis_remediation')).toBe(120_000);
  });
  it('returns the override for patching', () => {
    expect(getToolTimeout('manage_patches')).toBe(180_000);
  });
  it('returns the override for network discovery', () => {
    expect(getToolTimeout('network_discovery')).toBe(120_000);
  });
  it('returns the override for desktop/vision tools', () => {
    expect(getToolTimeout('take_screenshot')).toBe(120_000);
    expect(getToolTimeout('analyze_screen')).toBe(120_000);
    expect(getToolTimeout('computer_control')).toBe(120_000);
  });

  // #3091: analyze_screen timed out at 30s on prod. The table had drifted into
  // giving the three slowest tools the SHORTEST budget in it — shorter even than
  // the default an unlisted tool gets. Assert the invariant, not just the three
  // numbers, so a future override can't silently reintroduce the same shape.
  it('never gives a listed tool less time than the unlisted default', () => {
    const defaultTimeout = getToolTimeout('some_unknown_tool');
    for (const toolName of [
      'execute_command', 'run_script', 'analyze_disk_usage', 'disk_cleanup',
      'security_scan', 'apply_cis_remediation', 'manage_patches',
      'network_discovery', 'take_screenshot', 'analyze_screen',
      'computer_control', 'generate_report',
    ]) {
      expect.soft(getToolTimeout(toolName)).toBeGreaterThanOrEqual(defaultTimeout);
    }
  });

  it('gives the vision tools at least the agent round-trip budget', () => {
    // They do everything execute_command does (agent round-trip) and then
    // WebRTC negotiation, capture, and a vision pass on top.
    const agentRoundTrip = getToolTimeout('execute_command');
    expect(getToolTimeout('take_screenshot')).toBeGreaterThanOrEqual(agentRoundTrip);
    expect(getToolTimeout('analyze_screen')).toBeGreaterThanOrEqual(agentRoundTrip);
    expect(getToolTimeout('computer_control')).toBeGreaterThanOrEqual(agentRoundTrip);
  });
  it('returns the override for report generation', () => {
    expect(getToolTimeout('generate_report')).toBe(90_000);
  });
  it('returns the default for an unlisted tool', () => {
    expect(getToolTimeout('some_unknown_tool')).toBe(60_000); // TOOL_EXECUTION_TIMEOUT_MS
  });
});

describe('withToolTimeout', () => {
  it('resolves when the promise settles first', async () => {
    await expect(withToolTimeout(Promise.resolve('ok'), 1000, 't')).resolves.toBe('ok');
  });
  it('rejects with a timeout error when the promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(() => r('late'), 50));
    await expect(withToolTimeout(slow, 5, 'slowtool')).rejects.toThrow(/timed out after 5ms: slowtool/);
  });
  it('rejects with the original error if the promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('boom'));
    await expect(withToolTimeout(failing, 1000, 't')).rejects.toThrow('boom');
  });
});
