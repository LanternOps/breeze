import { describe, it, expect } from 'vitest';
import { PERMISSION_GRANTS } from './permissions';

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
