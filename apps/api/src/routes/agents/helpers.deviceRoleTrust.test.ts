import { describe, expect, it } from 'vitest';
import { shouldAutoApplyAgentReportedDeviceRole } from './helpers';

describe('shouldAutoApplyAgentReportedDeviceRole', () => {
  it('auto-applies a flip between two non-privileged roles', () => {
    expect(shouldAutoApplyAgentReportedDeviceRole('workstation', 'nas')).toBe(true);
  });

  it('auto-applies the unchanged steady-state re-report', () => {
    expect(shouldAutoApplyAgentReportedDeviceRole('workstation', 'workstation')).toBe(true);
  });

  it('withholds an agent-reported flip from a non-privileged role into a privileged one', () => {
    expect(shouldAutoApplyAgentReportedDeviceRole('workstation', 'server')).toBe(false);
  });

  it('withholds an agent-reported flip from unknown into a privileged one', () => {
    expect(shouldAutoApplyAgentReportedDeviceRole('unknown', 'server')).toBe(false);
  });

  it('still applies a re-report of an already-privileged role (no elevation happening)', () => {
    expect(shouldAutoApplyAgentReportedDeviceRole('server', 'server')).toBe(true);
  });
});
