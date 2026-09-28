import { Hono, type Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { AccountingImportError } from '../../services/accounting/accountingCustomerImport';
import { AccountingMappingError } from '../../services/accounting/accountingMappingService';
import { AccountingProviderError } from '../../services/accounting/accountingProviderError';
import { handleImportError, handleMappingError } from './routeErrors';

function appThrowing(err: unknown, handler: (c: Context, err: unknown) => Response) {
  const app = new Hono();
  app.get('/', (c) => handler(c, err));
  app.onError((e, c) => c.json({ rethrown: e.message }, 500));
  return app;
}

describe('handleMappingError', () => {
  it('passes details through when the error carries them', async () => {
    const res = await appThrowing(new AccountingMappingError('duplicate_name', 409, 'dup', { details: { remoteName: 'Acme' } }), handleMappingError).request('/');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'dup', code: 'duplicate_name', details: { remoteName: 'Acme' } });
  });
  it('keeps the old body exactly when there are no details', async () => {
    const res = await appThrowing(new AccountingMappingError('mapping_conflict', 409, 'x'), handleMappingError).request('/');
    expect(await res.json()).toEqual({ error: 'x', code: 'mapping_conflict' });
  });
});

describe('handleMappingError — raw provider refusals (remote-candidates calls the provider directly)', () => {
  it('maps a raw insufficient_scope to 409 provider_permission instead of a 500', async () => {
    const err = new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'Xero contact list', providerCode: 'insufficient_scope', httpStatus: 401 });
    const res = await appThrowing(err, handleMappingError).request('/');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Xero did not grant Breeze access to this data — reconnect Xero and approve every requested permission',
      code: 'provider_permission',
    });
  });
  it('still rethrows any other raw provider refusal', async () => {
    const err = new AccountingProviderError({ kind: 'validation', provider: 'xero', operation: 'Xero contact list', providerCode: 'duplicate_name', httpStatus: 400 });
    const res = await appThrowing(err, handleMappingError).request('/');
    expect(res.status).toBe(500);
  });
});

// The 429 / Retry-After / daily_budget_low cases need Task 6's AccountingImportError
// changes and are added there (controller ruling P3).
describe('handleImportError', () => {
  it('answers an AccountingImportError with its own status and { error, code }', async () => {
    const res = await appThrowing(new AccountingImportError('Xero needs to be reconnected', 'reauth_required', 409), handleImportError).request('/');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Xero needs to be reconnected', code: 'reauth_required' });
  });
  it('rethrows anything else', async () => {
    const res = await appThrowing(new Error('boom'), handleImportError).request('/');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ rethrown: 'boom' });
  });
});
