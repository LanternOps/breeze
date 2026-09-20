import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('offline detector legacy entrypoint closure', () => {
  it('does not expose the unused triggerOfflineAlerts execution path', () => {
    const source = readFileSync(new URL('./offlineDetector.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/export\s+async\s+function\s+triggerOfflineAlerts\b/);
  });
});
