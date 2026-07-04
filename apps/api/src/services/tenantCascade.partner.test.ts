import { describe, it, expect, vi, beforeEach } from 'vitest';

const execMock = vi.fn();
const cascadeDeleteOrgMock = vi.fn();

vi.mock('../db', () => ({
  db: { execute: (...a: unknown[]) => execMock(...a) },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('./auditService', () => ({ createAuditLog: vi.fn() }));

describe('cascadeDeletePartner', () => {
  beforeEach(() => {
    execMock.mockReset();
    cascadeDeleteOrgMock.mockReset();
  });

  it('cascades each child org, sweeps partner-axis tables, then deletes the partner row', async () => {
    const mod = await import('./tenantCascade');
    // cascadeDeletePartner now reads `.totalRowsDeleted` off each org's stats.
    cascadeDeleteOrgMock.mockResolvedValue({ totalRowsDeleted: 0 });
    vi.spyOn(mod, 'cascadeDeleteOrg').mockImplementation(cascadeDeleteOrgMock);
    vi.spyOn(mod, 'topologicalCascadeOrder').mockResolvedValue(['scripts', 'users']);

    execMock
      .mockResolvedValueOnce([{ id: 'org-1' }])
      // SSO FK-child pre-clears (#2195): user_sso_identities, then sso_sessions
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ table_name: 'scripts' }, { table_name: 'users' }])
      .mockResolvedValue([]);

    await mod.cascadeDeletePartner('partner-1', 'synthetic-test-cleanup');

    expect(cascadeDeleteOrgMock).toHaveBeenCalledWith('org-1', 'synthetic-test-cleanup');
    const lastCall = execMock.mock.calls.at(-1)![0];
    expect(JSON.stringify(lastCall)).toContain('partners');

    // topo sort received the discovered partner tables
    expect(mod.topologicalCascadeOrder).toHaveBeenCalledWith(['scripts', 'users']);

    const calls = execMock.mock.calls.map((c) => JSON.stringify(c[0]));

    // SSO FK children with no partner_id column are pre-cleared BEFORE the
    // partner-axis sweep (#2195) — without this, a canary partner that
    // exercised SSO fails the sweep on sso_providers/users FK violations.
    const identityClearIdx = calls.findIndex((c) => c.includes('user_sso_identities'));
    const sessionsClearIdx = calls.findIndex((c) => c.includes('sso_sessions'));
    const firstSweepIdx = calls.findIndex((c) => c.includes('scripts'));
    expect(identityClearIdx).toBeGreaterThan(-1);
    expect(sessionsClearIdx).toBeGreaterThan(-1);
    expect(firstSweepIdx).toBeGreaterThan(-1);
    expect(identityClearIdx).toBeLessThan(firstSweepIdx);
    expect(sessionsClearIdx).toBeLessThan(firstSweepIdx);

    // exactly one partners delete, and it is the LAST execute() call
    expect(calls.filter((c) => c.includes('partners')).length).toBe(1);

    // audit event emitted with the right action and details shape
    const { createAuditLog } = await import('./auditService');
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'test.synthetic_partner.purged',
        details: expect.objectContaining({ orgsDeleted: 1 }),
      }),
    );
  });
});
