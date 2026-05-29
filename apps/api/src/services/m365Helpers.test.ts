import { describe, it, expect } from 'vitest';
import { authorizeConnection, formatResultForLlm, errorString } from './m365Helpers';

describe('authorizeConnection', () => {
  it('rejects a connection from another org', () => {
    const conn = { id: 'c1', orgId: 'org-A', status: 'active' } as any;
    const out = authorizeConnection(conn, 'org-B');
    expect(out.ok).toBe(false);
  });
  it('accepts a connection in the same org', () => {
    const conn = { id: 'c1', orgId: 'org-A', status: 'active' } as any;
    const out = authorizeConnection(conn, 'org-A');
    expect(out.ok).toBe(true);
  });
  it('rejects a null connection', () => {
    expect(authorizeConnection(null, 'org-A').ok).toBe(false);
  });
  it('rejects an inactive connection', () => {
    const conn = { id: 'c1', orgId: 'org-A', status: 'disconnected' } as any;
    expect(authorizeConnection(conn, 'org-A').ok).toBe(false);
  });
});

describe('formatResultForLlm', () => {
  it('renders ok via the success template', () => {
    const s = formatResultForLlm(
      { kind: 'ok', data: { temporaryPassword: 'Temp123!' } },
      { successTemplate: (d: any) => `pw=${d.temporaryPassword}`, errorTemplate: (e) => `err=${e.message}` },
    );
    expect(s).toBe('pw=Temp123!');
  });
  it('renders error via the error template', () => {
    const s = formatResultForLlm(
      { kind: 'error', code: 'delegant_unreachable', message: 'down' },
      { successTemplate: () => 'ok', errorTemplate: (e) => `err=${e.message}` },
    );
    expect(s).toBe('err=down');
  });
});

describe('errorString', () => {
  it('produces a JSON error string the LLM can read', () => {
    const s = errorString('no_customer_selected', 'pick a customer');
    expect(JSON.parse(s)).toEqual({ error: 'no_customer_selected', message: 'pick a customer' });
  });
});
