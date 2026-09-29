import { describe, expect, it } from 'vitest';
import { buildEnrollmentResponseBody, type EnrollmentResponseFields } from './enrollmentResponse';

const fields: EnrollmentResponseFields = {
  agentId: 'agent-1',
  deviceId: 'device-1',
  authToken: 'brz_agent',
  watchdogAuthToken: 'brz_watchdog',
  helperAuthToken: 'brz_helper',
  orgId: 'org-1',
  siteId: 'site-1',
  backupServerUrl: 'https://backup.example',
  config: { heartbeatIntervalSeconds: 60, metricsCollectionIntervalSeconds: 30 },
  mtls: { certificate: 'cert', privateKey: 'key', expiresAt: '2027-01-01T00:00:00.000Z', serialNumber: 'AB' },
  manifestTrustKeys: [{ keyId: 'k-1', publicKeyB64: 'AAA=', validFrom: '2026-01-01T00:00:00.000Z' }] as never,
  manifestKeyDelegations: [{ keyId: 'k-2' }] as never,
};

describe('buildEnrollmentResponseBody', () => {
  it('returns every field unchanged, in the established order, for a regular enrollment', () => {
    const body = buildEnrollmentResponseBody(fields, { preAssignment: false });

    expect(body).toEqual(fields);
    expect(Object.keys(body)).toEqual([
      'agentId',
      'deviceId',
      'authToken',
      'watchdogAuthToken',
      'helperAuthToken',
      'orgId',
      'siteId',
      'backupServerUrl',
      'config',
      'mtls',
      'manifestTrustKeys',
      'manifestKeyDelegations',
    ]);
  });

  it('omits backup and trust material for a pre-assignment enrollment and keeps identity', () => {
    const body = buildEnrollmentResponseBody(fields, { preAssignment: true });

    expect(body).not.toHaveProperty('backupServerUrl');
    expect(body).not.toHaveProperty('manifestTrustKeys');
    expect(body).not.toHaveProperty('manifestKeyDelegations');
    expect(body).toEqual({
      agentId: 'agent-1',
      deviceId: 'device-1',
      authToken: 'brz_agent',
      watchdogAuthToken: 'brz_watchdog',
      helperAuthToken: 'brz_helper',
      orgId: 'org-1',
      siteId: 'site-1',
      config: fields.config,
      mtls: fields.mtls,
    });
  });

  it('keeps a null mTLS certificate and an absent backup URL as they are', () => {
    const body = buildEnrollmentResponseBody(
      { ...fields, mtls: null, backupServerUrl: undefined },
      { preAssignment: false },
    );

    expect(body.mtls).toBeNull();
    expect((body as EnrollmentResponseFields).backupServerUrl).toBeUndefined();
    expect(body).toHaveProperty('manifestTrustKeys');
  });
});
