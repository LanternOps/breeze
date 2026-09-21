import { describe, it, expect } from 'vitest';
import { PERMISSION_GRANTS } from './permissions';

it('exposes the billing_profiles grants', () => {
  expect(PERMISSION_GRANTS.BILLING_PROFILES_READ).toEqual({ resource: 'billing_profiles', action: 'read' });
  expect(PERMISSION_GRANTS.BILLING_PROFILES_WRITE).toEqual({ resource: 'billing_profiles', action: 'write' });
});

describe('PERMISSION_GRANTS topology grants', () => {
  it('exposes topology grants', () => {
    expect(PERMISSION_GRANTS.TOPOLOGY_WRITE).toEqual({ resource: 'topology', action: 'write' });
    expect(PERMISSION_GRANTS.TOPOLOGY_READ).toEqual({ resource: 'topology', action: 'read' });
  });
});

describe('agent rollback grant', () => {
  it('defines the dedicated create capability', () => {
    expect(PERMISSION_GRANTS.AGENT_ROLLBACK_CREATE).toEqual({ resource: 'agent_rollback', action: 'create' });
  });
});

describe('PAM dedicated permissions (pam:approve / pam:manage_policy)', () => {
  it('exposes a dedicated approve capability, distinct from devices:execute', () => {
    expect(PERMISSION_GRANTS.PAM_APPROVE).toEqual({ resource: 'pam', action: 'approve' });
  });

  it('exposes a dedicated policy-management capability, distinct from devices:write', () => {
    expect(PERMISSION_GRANTS.PAM_MANAGE_POLICY).toEqual({ resource: 'pam', action: 'manage_policy' });
  });
});

describe('Accounting dedicated permissions (accounting:read / accounting:manage)', () => {
  it('exposes a dedicated provider-read capability, distinct from partner authority alone', () => {
    expect(PERMISSION_GRANTS.ACCOUNTING_READ).toEqual({ resource: 'accounting', action: 'read' });
  });

  it('exposes a dedicated realm-management capability, distinct from invoices:write', () => {
    expect(PERMISSION_GRANTS.ACCOUNTING_MANAGE).toEqual({ resource: 'accounting', action: 'manage' });
    expect(PERMISSION_GRANTS.ACCOUNTING_MANAGE).not.toEqual(PERMISSION_GRANTS.INVOICES_WRITE);
  });
});

describe('Workspace extension grants', () => {
  it('keeps read, configuration, credentials, and execution as distinct capabilities', () => {
    expect(PERMISSION_GRANTS.WORKSPACE_READ).toEqual({ resource: 'workspace', action: 'read' });
    expect(PERMISSION_GRANTS.WORKSPACE_WRITE).toEqual({ resource: 'workspace', action: 'write' });
    expect(PERMISSION_GRANTS.WORKSPACE_CREDENTIALS).toEqual({ resource: 'workspace', action: 'credentials' });
    expect(PERMISSION_GRANTS.WORKSPACE_EXECUTE).toEqual({ resource: 'workspace', action: 'execute' });
  });
});

describe('documents permission (service deliverables W03)', () => {
  it('declares read and write on the documents resource', () => {
    expect(PERMISSION_GRANTS.DOCUMENTS_READ).toEqual({ resource: 'documents', action: 'read' });
    expect(PERMISSION_GRANTS.DOCUMENTS_WRITE).toEqual({ resource: 'documents', action: 'write' });
  });
});

describe('agreements permission (agreements vocabulary + IA split, W02)', () => {
  it('declares read and write on the agreements resource', () => {
    expect(PERMISSION_GRANTS.AGREEMENTS_READ).toEqual({ resource: 'agreements', action: 'read' });
    expect(PERMISSION_GRANTS.AGREEMENTS_WRITE).toEqual({ resource: 'agreements', action: 'write' });
  });

  // The whole point of the resource: the template library must be reachable
  // without recurring-billing authority, and vice versa.
  it('is a distinct resource from contracts', () => {
    expect(PERMISSION_GRANTS.AGREEMENTS_READ).not.toEqual(PERMISSION_GRANTS.CONTRACTS_READ);
    expect(PERMISSION_GRANTS.AGREEMENTS_WRITE).not.toEqual(PERMISSION_GRANTS.CONTRACTS_WRITE);
  });

  // No `manage`: publish and archive are write operations on a template
  // (spec §4). A third action would be an ungated capability with no gate.
  it('declares no third action', () => {
    const agreementKeys = Object.keys(PERMISSION_GRANTS).filter((k) => k.startsWith('AGREEMENTS_'));
    expect(agreementKeys.sort()).toEqual(['AGREEMENTS_READ', 'AGREEMENTS_WRITE']);
  });
});

describe('quotes:accept permission (accept-on-behalf, 2026-09-21 spec §7)', () => {
  it('declares a dedicated accept capability, distinct from quotes:send', () => {
    expect(PERMISSION_GRANTS.QUOTES_ACCEPT).toEqual({ resource: 'quotes', action: 'accept' });
    expect(PERMISSION_GRANTS.QUOTES_ACCEPT).not.toEqual(PERMISSION_GRANTS.QUOTES_SEND);
  });
});
