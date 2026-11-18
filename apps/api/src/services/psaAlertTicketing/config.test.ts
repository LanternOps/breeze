import { describe, expect, it } from 'vitest';
import {
  alertTicketingCredentialState,
  psaInstanceKey,
  resolveAlertTicketingConfig,
  type AlertTicketingConnectionRow,
} from './config';

const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';
const PARTNER_ID = '22222222-2222-4222-8222-222222222222';

const credentials = { baseUrl: 'https://api-na.example-psa.test/v4_6_release/apis/3.0', companyId: 'msp' };
const instanceKey = psaInstanceKey('connectwise', credentials)!;

const enabledConfig = {
  enabled: true,
  boardId: 12,
  openStatusId: 101,
  closedStatusId: 109,
  companyLinksConfirmedFor: instanceKey,
};

function connection(overrides: Partial<AlertTicketingConnectionRow> = {}): AlertTicketingConnectionRow {
  return {
    id: CONNECTION_ID,
    partnerId: PARTNER_ID,
    provider: 'connectwise',
    alertTicketing: enabledConfig,
    alertTicketingRev: 4,
    alertTicketingPausedReason: null,
    ...overrides,
  };
}

const bound = { serviceManagementMode: 'external' as const, serviceManagementPsaConnectionId: CONNECTION_ID };
const usable = (key: string | null) => ({ usable: true, instanceKey: key });

describe('resolveAlertTicketingConfig', () => {
  it('is active for the bound partner connection in external mode with a confirmed instance', () => {
    const resolved = resolveAlertTicketingConfig(connection(), bound, usable(instanceKey));
    expect(resolved).toEqual({
      active: true,
      rev: 4,
      config: expect.objectContaining({ enabled: true, boardId: 12, minSeverity: 'low', hourlyCreateCap: 100 }),
    });
  });

  it.each([
    ['unsupported_provider', connection({ provider: 'autotask' }), bound, instanceKey],
    ['not_external', connection(), { serviceManagementMode: 'native' as const, serviceManagementPsaConnectionId: null }, instanceKey],
    ['not_external', connection(), { serviceManagementMode: 'off' as const, serviceManagementPsaConnectionId: null }, instanceKey],
    ['not_bound', connection(), { serviceManagementMode: 'external' as const, serviceManagementPsaConnectionId: '33333333-3333-4333-8333-333333333333' }, instanceKey],
    ['not_bound', connection({ partnerId: null }), bound, instanceKey],
    ['disabled', connection({ alertTicketing: null }), bound, instanceKey],
    ['disabled', connection({ alertTicketing: { enabled: false, boardId: 7 } }), bound, instanceKey],
    ['invalid_config', connection({ alertTicketing: { enabled: true, boardId: 'x' } }), bound, instanceKey],
    ['invalid_config', connection({ alertTicketing: { ...enabledConfig, password: 'hunter2' } }), bound, instanceKey],
    ['paused', connection({ alertTicketingPausedReason: 'auth' }), bound, instanceKey],
    ['company_links_unverified', connection({ alertTicketing: { ...enabledConfig, companyLinksConfirmedFor: undefined } }), bound, instanceKey],
    ['company_links_unverified', connection(), bound, psaInstanceKey('connectwise', { ...credentials, baseUrl: 'https://other.example-psa.test' })],
    ['company_links_unverified', connection(), bound, null],
  ])('reports %s', (reason, row, partner, key) => {
    const resolved = resolveAlertTicketingConfig(row, partner, usable(key));
    expect(resolved).toMatchObject({ active: false, reason });
  });

  it('returns the parsed config with an inactive reason so the card can preview it', () => {
    const resolved = resolveAlertTicketingConfig(connection({ alertTicketing: { enabled: false, boardId: 7 } }), bound, usable(instanceKey));
    expect(resolved).toEqual({
      active: false,
      reason: 'disabled',
      rev: 4,
      config: expect.objectContaining({ enabled: false, boardId: 7, closeOnResolve: false }),
    });
  });

  it('never returns a config it could not parse', () => {
    const resolved = resolveAlertTicketingConfig(connection({ alertTicketing: 'garbage' }), bound, usable(instanceKey));
    expect(resolved).toEqual({ active: false, reason: 'invalid_config', rev: 4, config: null });
  });
});

describe('credentials', () => {
  it('reports credentials_unusable for missing or undecryptable credentials, even with a confirmed instance', () => {
    const resolved = resolveAlertTicketingConfig(connection(), bound, { usable: false, instanceKey });
    expect(resolved).toMatchObject({ active: false, reason: 'credentials_unusable' });
  });

  it('alertTicketingCredentialState validates the full provider credential set', () => {
    expect(alertTicketingCredentialState('connectwise', { ...credentials, publicKey: 'p', privateKey: 's' }))
      .toEqual({ usable: true, instanceKey });
    // baseUrl alone fingerprints the instance but cannot authenticate.
    expect(alertTicketingCredentialState('connectwise', credentials)).toEqual({ usable: false, instanceKey });
    expect(alertTicketingCredentialState('connectwise', null)).toEqual({ usable: false, instanceKey: null });
  });
});

describe('psaInstanceKey', () => {
  it('is a keyed fingerprint: it never embeds the base URL host or company id', () => {
    expect(instanceKey).toMatch(/^fp1:[^:]+:[0-9a-f]{64}$/);
    expect(instanceKey).not.toContain('example-psa');
    expect(instanceKey).not.toContain('msp');
  });

  it('is not the unkeyed SHA-256 of its inputs (an org reader cannot confirm a guessed host)', async () => {
    const { createHash } = await import('node:crypto');
    const hex = instanceKey.split(':').pop();
    for (const input of ['connectwise\napi-na.example-psa.test\nmsp', 'psa-instance\nconnectwise\napi-na.example-psa.test\nmsp']) {
      expect(hex).not.toBe(createHash('sha256').update(input).digest('hex'));
    }
  });

  it('ignores the path, scheme case and host case, but not the host or company', () => {
    expect(psaInstanceKey('connectwise', { baseUrl: 'HTTPS://API-NA.example-psa.test/other', companyId: 'MSP' })).toBe(instanceKey);
    expect(psaInstanceKey('connectwise', { ...credentials, companyId: 'other' })).not.toBe(instanceKey);
    expect(psaInstanceKey('connectwise', { ...credentials, baseUrl: 'https://eu.example-psa.test' })).not.toBe(instanceKey);
    expect(psaInstanceKey('autotask', credentials)).not.toBe(instanceKey);
  });

  it('is null without a parseable base URL', () => {
    expect(psaInstanceKey('connectwise', { companyId: 'msp' })).toBeNull();
    expect(psaInstanceKey('connectwise', { baseUrl: 'not a url', companyId: 'msp' })).toBeNull();
    expect(psaInstanceKey('connectwise', null)).toBeNull();
  });
});
