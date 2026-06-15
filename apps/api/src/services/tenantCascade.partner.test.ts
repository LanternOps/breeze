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
    vi.spyOn(mod, 'cascadeDeleteOrg').mockImplementation(cascadeDeleteOrgMock);
    vi.spyOn(mod, 'topologicalCascadeOrder').mockResolvedValue(['scripts', 'users']);

    execMock
      .mockResolvedValueOnce([{ id: 'org-1' }])
      .mockResolvedValueOnce([{ table_name: 'scripts' }, { table_name: 'users' }])
      .mockResolvedValue([]);

    await mod.cascadeDeletePartner('partner-1', 'synthetic-test-cleanup');

    expect(cascadeDeleteOrgMock).toHaveBeenCalledWith('org-1', 'synthetic-test-cleanup');
    const lastCall = execMock.mock.calls.at(-1)![0];
    expect(JSON.stringify(lastCall)).toContain('partners');
  });
});
