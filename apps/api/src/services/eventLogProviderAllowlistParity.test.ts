import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APPLICATION_INFO_EVENT_PROVIDERS } from '@breeze/shared';

// #8174 — the agent decides which Application providers ship Information and
// Warning events; the shared copy only drives the save-time warning. If the
// two drift, rules get warned wrongly (or not warned when they should be).
describe('Application info provider allowlist parity (agent ↔ shared)', () => {
  it('the Go allowlist and APPLICATION_INFO_EVENT_PROVIDERS list the same providers', () => {
    const goFile = readFileSync(
      resolve(__dirname, '../../../../agent/internal/collectors/eventlogs_windows_application.go'),
      'utf8',
    );
    const block = goFile.match(/var applicationInfoProviderAllowlist = \[\]string\{([\s\S]*?)\n\}/);
    expect(block, 'applicationInfoProviderAllowlist not found in the Go collector').not.toBeNull();
    const goProviders = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(goProviders.length).toBeGreaterThan(0);
    expect(goProviders).toEqual([...APPLICATION_INFO_EVENT_PROVIDERS]);
  });
});
