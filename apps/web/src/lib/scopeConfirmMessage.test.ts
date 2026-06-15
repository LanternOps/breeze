// apps/web/src/lib/scopeConfirmMessage.test.ts
import { describe, it, expect } from 'vitest';
import { scopeConfirmMessage } from './scopeConfirmMessage';

describe('scopeConfirmMessage', () => {
  it('names a single org and device count', () => {
    expect(scopeConfirmMessage({ action: 'Install 12 patches', deviceCount: 142, orgNames: ['Acme Corp'] }))
      .toBe('Install 12 patches on 142 devices in Acme Corp?');
  });
  it('warns when the action spans multiple organizations', () => {
    expect(scopeConfirmMessage({ action: 'Scan for patches', deviceCount: 300, orgNames: ['Acme Corp', 'Globex', 'Initech'] }))
      .toBe('Scan for patches on 300 devices across 3 organizations (Acme Corp, Globex, Initech)?');
  });
});
