import { describe, expect, it, vi } from 'vitest';

// Many suites mock the redactor modules wholesale. Diagnostic-read redaction
// must keep working under those mocks, so it reads its rules from the leaf
// module (../redactionPatterns) rather than from the redactors.
vi.mock('../aiToolOutput', () => ({}));
vi.mock('../secretRedaction', () => ({}));
vi.mock('../logRedaction', () => ({}));

import { redactDiagnosticWindow } from './contentRedaction';

describe('contentRedaction under mocked redactor modules', () => {
  it('still loads and redacts', () => {
    const window = Buffer.from('ok\npassword=Hunter2Hunter2\naws AKIAABCDEFGHIJKLMNOP\n');
    const r = redactDiagnosticWindow(window, 0, window.length);
    expect(r.redacted).toBe(true);
    expect(r.bytes.toString()).not.toMatch(/Hunter2|AKIAABCDEFGHIJKLMNOP/);
  });
});
