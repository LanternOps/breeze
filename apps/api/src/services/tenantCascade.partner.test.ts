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
      // FK-child pre-clears, in list order: user_sso_identities and
      // sso_sessions (#2195), then psa_ticket_mappings (epic #2135 — it has no
      // partner_id column, so the sweep below cannot reach it, yet its
      // connection_id FK into psa_connections is NO ACTION).
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // Software chain pre-clears (#3600), in list order: deployment_results,
      // software_deployments, software_versions. software_versions has no
      // tenancy column and its catalog_id FK is NO ACTION, so the sweep's
      // `DELETE FROM software_catalog WHERE partner_id = ...` aborts with
      // 23503 without them.
      .mockResolvedValueOnce([])
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

    // psa_ticket_mappings (epic #2135): same shape — no partner_id column, so
    // it MUST be pre-cleared before `DELETE FROM psa_connections WHERE
    // partner_id = ...` or the sweep aborts with 23503.
    const psaClearIdx = calls.findIndex((c) => c.includes('psa_ticket_mappings'));
    expect(psaClearIdx).toBeGreaterThan(-1);
    expect(psaClearIdx).toBeLessThan(firstSweepIdx);

    // Software chain (#3600): same no-tenancy-column shape, and the three
    // pre-clears are order-dependent among themselves as well as being before
    // the sweep. Markers are DELETE-prefixed because every one of these
    // statements NAMES the other two tables in its subqueries.
    const resultsIdx = calls.findIndex((c) => c.includes('DELETE FROM deployment_results'));
    const deploymentsIdx = calls.findIndex((c) => c.includes('DELETE FROM software_deployments'));
    const versionsIdx = calls.findIndex((c) => c.includes('DELETE FROM software_versions'));
    expect(resultsIdx).toBeGreaterThan(-1);
    expect(deploymentsIdx).toBeGreaterThan(resultsIdx);
    expect(versionsIdx).toBeGreaterThan(deploymentsIdx);
    expect(versionsIdx).toBeLessThan(firstSweepIdx);

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
