import { describe, expect, it } from 'vitest';
import { shouldSkipAgentAuth } from './index';

const SKIPPED: Array<[string, string]> = [
  ['/agents/enroll', 'enroll'],
  ['/agents/renew-cert', 'renew-cert'],
  ['/agents/quarantined', 'quarantined'],
  ['/agents/org/123/settings', 'org'],
  ['/agents/download/agent.msi', 'download'],
  ['/agents/dev-123/approve', 'dev-123'],
  ['/agents/dev-123/deny', 'dev-123'],
];
const ENFORCED: Array<[string, string]> = [
  ['/agents/dev-123/heartbeat', 'dev-123'],
  ['/agents/dev-123/inventory', 'dev-123'],
  ['/agents/dev-123/commands', 'dev-123'],
  ['/agents/dev-123/logs', 'dev-123'],
  // Regression guards: nested paths ending in approve/deny MUST still enforce.
  ['/agents/dev-123/scripts/s-1/approve', 'dev-123'],
  ['/agents/dev-123/scripts/s-1/deny', 'dev-123'],
  // Substring foot-guns must enforce.
  ['/agents/dev-123/approveX', 'dev-123'],
  ['/agents/dev-123/predeny', 'dev-123'],
];

describe('agent-auth skip carve-out', () => {
  it.each(SKIPPED)('SKIPS for %s', (path, id) => {
    expect(shouldSkipAgentAuth(path, id)).toBe(true);
  });
  it.each(ENFORCED)('ENFORCES for %s', (path, id) => {
    expect(shouldSkipAgentAuth(path, id)).toBe(false);
  });
});
