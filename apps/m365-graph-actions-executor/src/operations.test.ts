import { describe, it, expect, vi } from 'vitest';
import { executeActionOperation, type ExecutorOperationDependencies } from './operations';
import type { MicrosoftGraphClient } from './microsoft/graphClient';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER_ID = '11111111-1111-4111-8111-111111111111';

function deps(over: Partial<ExecutorOperationDependencies> = {}): ExecutorOperationDependencies {
  const cert = { certificatePem: 'C', privateKeyPem: 'K' };
  const graphClient = {
    probeTenant: vi.fn(),
    readResource: vi.fn().mockResolvedValue({ id: USER_ID }),
    readCollection: vi.fn(),
    patch: vi.fn().mockResolvedValue(undefined),
  } as unknown as MicrosoftGraphClient;
  return {
    clientId: '33333333-3333-4333-8333-333333333333',
    certificateProvider: { getConfiguredCertificate: vi.fn().mockResolvedValue(cert) },
    createTokenClient: () => ({ acquireGraphAppToken: vi.fn().mockResolvedValue('access-token') } as never),
    graphClient,
    ...over,
  } as ExecutorOperationDependencies;
}

describe('executeActionOperation', () => {
  it('rejects a non-canonical tenantId with tenant_mismatch', async () => {
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: 'not-a-uuid', idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      deps(),
    );
    expect(result).toEqual({ success: false, errorCode: 'tenant_mismatch' });
  });

  it('mints a token and runs the mutation on the happy path', async () => {
    const d = deps();
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: TENANT, idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      d,
    );
    expect(result).toEqual({ success: true, action: 'm365.user.disable', userId: USER_ID });
  });

  it('returns credential_unavailable when the cert provider throws', async () => {
    const d = deps({ certificateProvider: { getConfiguredCertificate: vi.fn().mockRejectedValue(new Error('vault down')) } });
    const result = await executeActionOperation(
      { correlationId: '00000000-0000-4000-8000-000000000001', tenantId: TENANT, idempotencyKey: 'i',
        action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' } },
      d,
    );
    expect(result).toEqual({ success: false, errorCode: 'credential_unavailable' });
  });
});
