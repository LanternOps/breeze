import { beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Record<string, unknown>[] = [];
const returningMock = vi.fn(async () => [{ id: 'p1', status: 'proposed' }]);
const updateWhereMock = vi.fn(() => ({ returning: async () => [{ id: 'p1' }] }));

vi.mock('../../db', () => ({
  db: {
    insert: () => ({ values: (v: Record<string, unknown>) => { rows.push(v); return { returning: returningMock }; } }),
    update: () => ({ set: () => ({ where: updateWhereMock }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));

import { createScriptProposal } from './proposals';

const auth = { orgId: 'org-1', user: { id: 'u1' } } as never;
const input = {
  language: 'powershell' as const,
  content: 'Restart-Service -Name Spooler',
  goal: 'stuck spooler',
  expectedEffect: 'spooler restarted',
  verification: { kind: 'service_running' as const, name: 'Spooler' },
  deviceIds: ['11111111-1111-4111-8111-111111111111'],
  runAs: 'system' as const,
  timeoutSeconds: 300,
};

beforeEach(() => { rows.length = 0; });

describe('createScriptProposal', () => {
  it('stamps the scan output, the scanner version and a sha256 content digest on the row', async () => {
    const { scan } = await createScriptProposal(auth, input, { kind: 'chat_session', sessionId: 's1' });
    const row = rows[0]!;
    expect(row.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.scannerVersion).toBe(scan.scannerVersion);
    expect(row.touchClasses).toEqual(scan.touchClasses);
    expect(row.touchClasses).toContain('services');
  });

  it('records status scan_rejected without enqueueing anything when a BASIC pattern hits', async () => {
    const { proposal, scan } = await createScriptProposal(
      auth, { ...input, content: 'Format-Volume -DriveLetter D' }, { kind: 'chat_session', sessionId: 's1' });
    expect(scan.basicHits).toEqual(['PowerShell volume format']);
    expect(rows[0]!.status).toBe('scan_rejected');
    expect(proposal).toBeDefined();
  });

  it('records a STRICT hit but leaves the proposal proposed — strict is acknowledgeable, not fatal', async () => {
    const { scan } = await createScriptProposal(
      auth, { ...input, content: 'reg add HKLM\\SOFTWARE\\X /v Y /d 1 /f' }, { kind: 'chat_session', sessionId: 's1' });
    expect(scan.strictHits.length).toBeGreaterThan(0);
    expect(rows[0]!.status).toBe('proposed');
  });

  it('stamps the agent run id and a null session id for an agent author', async () => {
    await createScriptProposal(auth, input, { kind: 'agent_run', agentRunId: 'r1' });
    expect(rows[0]!.authorKind).toBe('agent_run');
    expect(rows[0]!.agentRunId).toBe('r1');
    expect(rows[0]!.sessionId).toBeNull();
  });

  it('sets expiry 24 hours out', async () => {
    await createScriptProposal(auth, input, { kind: 'chat_session', sessionId: 's1' });
    const delta = (rows[0]!.expiresAt as Date).getTime() - Date.now();
    expect(delta).toBeGreaterThan(23 * 3600_000);
    expect(delta).toBeLessThanOrEqual(24 * 3600_000 + 5_000);
  });
});
