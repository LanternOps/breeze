import { describe, expect, it } from 'vitest';
import { createConnectionSchema } from './schemas';

const GUID = '11111111-1111-1111-1111-111111111111';

describe('createConnectionSchema tenantId validation', () => {
  it('accepts a Microsoft 365 manual connection with a GUID tenantId', () => {
    const result = createConnectionSchema.safeParse({
      provider: 'microsoft_365',
      displayName: 'M365',
      tenantId: GUID,
      clientId: 'client-id',
      clientSecret: 'client-secret',
      authMethod: 'manual',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a Microsoft 365 connection with a non-GUID tenantId', () => {
    const result = createConnectionSchema.safeParse({
      provider: 'microsoft_365',
      displayName: 'M365',
      tenantId: 'not-a-guid',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      authMethod: 'manual',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('tenantId'))).toBe(true);
    }
  });

  // tenantId is shared across providers; Google Workspace must not be forced
  // into the Entra GUID shape.
  it('allows a non-GUID tenantId for google_workspace', () => {
    const result = createConnectionSchema.safeParse({
      provider: 'google_workspace',
      displayName: 'Workspace',
      tenantId: 'example.com',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      authMethod: 'manual',
    });
    expect(result.success).toBe(true);
  });

  it('allows an omitted tenantId for Microsoft 365', () => {
    const result = createConnectionSchema.safeParse({
      provider: 'microsoft_365',
      displayName: 'M365',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      authMethod: 'manual',
    });
    expect(result.success).toBe(true);
  });
});
