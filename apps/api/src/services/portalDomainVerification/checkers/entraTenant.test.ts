import { beforeEach, describe, expect, it, vi } from 'vitest';

const { proofMocks, readMocks } = vi.hoisted(() => ({
  proofMocks: { findProvenEntraTenantForOrg: vi.fn() },
  readMocks: { readM365OrganizationForVerification: vi.fn() },
}));

vi.mock('../../portalEntraTenantProof', () => ({
  findProvenEntraTenantForOrg: proofMocks.findProvenEntraTenantForOrg,
}));
vi.mock('../../m365ControlPlane/readActionService', () => ({
  readM365OrganizationForVerification: readMocks.readM365OrganizationForVerification,
}));

import { entraTenantChecker } from './entraTenant';
import type { DomainCheckTarget } from '../types';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const TENANT = '44444444-4444-4444-8444-444444444444';
const CONNECTION_ID = '11111111-1111-4111-8111-111111111111';

function target(domain = 'acme.example'): DomainCheckTarget {
  return { rowId: 'row-1', orgId: ORG_ID, partnerId: 'p-1', domain, verificationToken: null };
}
function directory(domains: Array<{ name: string; isInitial?: boolean }>, tenantId = TENANT) {
  return {
    ok: true,
    tenantId,
    connectionId: CONNECTION_ID,
    verifiedDomains: domains.map((d) => ({ name: d.name, isInitial: d.isInitial ?? false })),
  };
}

describe('entraTenantChecker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    proofMocks.findProvenEntraTenantForOrg.mockResolvedValue({ tenantId: TENANT, provenAt: new Date() });
  });

  it('declares the entra_tenant method', () => {
    expect(entraTenantChecker.method).toBe('entra_tenant');
  });

  it('fails tenant_not_proven when the org has an unproven mapping only', async () => {
    proofMocks.findProvenEntraTenantForOrg.mockResolvedValue(null);
    expect(await entraTenantChecker.check(target())).toEqual({ status: 'fail', reason: 'tenant_not_proven' });
    expect(readMocks.readM365OrganizationForVerification).not.toHaveBeenCalled();
  });

  it('fails connection_missing for a tenant proven by proof run with no M365 connection', async () => {
    readMocks.readM365OrganizationForVerification.mockResolvedValue({ ok: false, code: 'no_connection' });
    expect(await entraTenantChecker.check(target())).toEqual({ status: 'fail', reason: 'connection_missing' });
    expect(readMocks.readM365OrganizationForVerification).toHaveBeenCalledWith(ORG_ID, TENANT);
  });

  it('passes when the domain is in verifiedDomains, case-insensitively', async () => {
    readMocks.readM365OrganizationForVerification.mockResolvedValue(
      directory([{ name: 'acme.example' }], TENANT.toUpperCase()),
    );
    expect(await entraTenantChecker.check(target('acme.example'))).toEqual({
      status: 'pass',
      evidence: { via: 'entra_tenant', tenantId: TENANT, connectionId: CONNECTION_ID },
    });
  });

  it('fails not_in_directory for a subdomain of a verified domain', async () => {
    readMocks.readM365OrganizationForVerification.mockResolvedValue(directory([{ name: 'acme.example' }]));
    expect(await entraTenantChecker.check(target('mail.acme.example'))).toEqual({ status: 'fail', reason: 'not_in_directory' });
  });

  it("fails not_in_directory for the tenant's initial *.onmicrosoft.com domain even though it is in verifiedDomains", async () => {
    readMocks.readM365OrganizationForVerification.mockResolvedValue(
      directory([{ name: 'acme.onmicrosoft.com', isInitial: true }, { name: 'acme.example' }]),
    );
    expect(await entraTenantChecker.check(target('acme.onmicrosoft.com'))).toEqual({ status: 'fail', reason: 'not_in_directory' });
    readMocks.readM365OrganizationForVerification.mockResolvedValue(
      directory([{ name: 'acme.onmicrosoft.com', isInitial: false }]),
    );
    expect(await entraTenantChecker.check(target('acme.onmicrosoft.com'))).toEqual({ status: 'fail', reason: 'not_in_directory' });
  });

  it('is unavailable graph_tenant_mismatch when /organization returns another tenant id', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    readMocks.readM365OrganizationForVerification.mockResolvedValue(
      directory([{ name: 'acme.example' }], '99999999-9999-4999-8999-999999999999'),
    );
    expect(await entraTenantChecker.check(target())).toEqual({ status: 'unavailable', reason: 'graph_tenant_mismatch' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is unavailable on executor error and on timeout', async () => {
    readMocks.readM365OrganizationForVerification.mockResolvedValue({ ok: false, code: 'executor_error' });
    expect(await entraTenantChecker.check(target())).toEqual({ status: 'unavailable', reason: 'graph_unavailable' });
    readMocks.readM365OrganizationForVerification.mockResolvedValue({ ok: false, code: 'connection_not_ready' });
    expect(await entraTenantChecker.check(target())).toEqual({ status: 'unavailable', reason: 'graph_unavailable' });
    readMocks.readM365OrganizationForVerification.mockResolvedValue({ ok: false, code: 'timeout' });
    expect(await entraTenantChecker.check(target())).toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('never throws', async () => {
    readMocks.readM365OrganizationForVerification.mockRejectedValue(new Error('boom'));
    expect(await entraTenantChecker.check(target())).toEqual({ status: 'unavailable', reason: 'graph_unavailable' });
  });
});
