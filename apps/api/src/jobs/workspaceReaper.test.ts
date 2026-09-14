import { beforeEach, describe, expect, it, vi } from 'vitest';

const { destroy, execute, update, captureException } = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  execute: vi.fn(),
  update: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    execute: (...args: unknown[]) => execute(...args),
    update: (...args: unknown[]) => update(...args),
  },
  withSystemDbAccessContext: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock('../services/sentry', () => ({ captureException }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/workspace/sandboxBackend', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSandboxBackendByName: vi.fn(() => ({ name: 'fake', destroy })),
}));

import { getSandboxBackendByName } from '../services/workspace/sandboxBackend';
import { reapExpiredWorkspaces } from './workspaceReaper';

function claimReturns(rows: Array<Record<string, unknown>>) {
  execute.mockResolvedValueOnce({ rows });
}

function setBuilder() {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  update.mockReturnValueOnce({ set });
  return { set, where };
}

describe('reapExpiredWorkspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    destroy.mockResolvedValue(undefined);
  });

  it('claims nothing and destroys nothing when no row is overdue', async () => {
    claimReturns([]);
    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 0, failed: 0 });
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys an overdue sandbox by its OWN backend and marks it destroyed', async () => {
    claimReturns([
      { id: 'w1', org_id: 'o1', run_id: 'r1', backend: 'vercel', provider_ref: 'breeze-eu-1', region: 'eu' },
    ]);
    const marked = setBuilder();

    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 1, failed: 0 });

    // Dispatched per ROW, not by the process-wide AI_WORKSPACE_BACKEND: a row
    // written before an env flip must still be destroyable.
    expect(getSandboxBackendByName).toHaveBeenCalledWith('vercel');
    expect(destroy).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'vercel', providerRef: 'breeze-eu-1', region: 'eu' }),
    );
    expect(marked.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'destroyed', destroyedAt: expect.any(Date) }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it('marks destroy_failed, records the error, pages, and keeps going', async () => {
    claimReturns([
      { id: 'w1', org_id: 'o1', run_id: 'r1', backend: 'vercel', provider_ref: 'a', region: 'eu' },
      { id: 'w2', org_id: 'o1', run_id: 'r2', backend: 'vercel', provider_ref: 'b', region: 'eu' },
    ]);
    destroy.mockRejectedValueOnce(new Error('vendor 500'));
    const failedUpdate = setBuilder();
    const okUpdate = setBuilder();

    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 1, failed: 1 });

    expect(failedUpdate.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'destroy_failed', lastError: expect.stringContaining('vendor 500') }),
    );
    expect(okUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'destroyed' }));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('never throws out of a single bad row', async () => {
    claimReturns([{ id: 'w1', org_id: 'o1', run_id: 'r1', backend: 'nope', provider_ref: 'c', region: 'eu' }]);
    (getSandboxBackendByName as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('No SandboxBackend implementation for "nope"');
    });
    setBuilder();
    await expect(reapExpiredWorkspaces()).resolves.toEqual({ destroyed: 0, failed: 1 });
  });

  it('claims with a 120-second grace and skips rows another instance holds', async () => {
    claimReturns([]);
    await reapExpiredWorkspaces();
    const sqlText = JSON.stringify(execute.mock.calls[0]?.[0] ?? '');
    expect(sqlText).toContain('120 seconds');
    expect(sqlText).toContain('FOR UPDATE SKIP LOCKED');
    expect(sqlText).toContain("'destroying'");
  });

  it('keeps the SQL literal and the documented grace constant in step', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./workspaceReaper.ts', import.meta.url), 'utf8'));
    const constant = /REAP_GRACE_SECONDS = (\d+)/.exec(source)?.[1];
    expect(source).toContain(`interval '${constant} seconds'`);
    // Same trap for the stalled-claim window: the SQL uses a literal (so the
    // planner can prove the partial-index predicate), which means the constant
    // and the literal are two copies of one number.
    const stall = /DESTROYING_STALL_SECONDS = (\d+)/.exec(source)?.[1];
    expect(stall, 'DESTROYING_STALL_SECONDS must exist').toBeDefined();
    expect(source).toContain(`interval '${stall} seconds'`);
  });
});
