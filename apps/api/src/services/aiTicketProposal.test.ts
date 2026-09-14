import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows: unknown[] = [];
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }),
    },
  };
});

import { getLatestTicketProposal } from './aiTicketProposal';

describe('getLatestTicketProposal (#4211)', () => {
  beforeEach(() => { rows.length = 0; });

  it('returns null when the ticket has no finished triage run', async () => {
    expect(await getLatestTicketProposal('11111111-1111-1111-1111-111111111111')).toBeNull();
  });

  it('projects the newest finished triage run outcome through the run-trace mapper', async () => {
    rows.push({
      id: 'run-1',
      finishedAt: new Date('2026-09-13T00:00:00Z'),
      intentIds: [],
      outcome: { ticketProposal: { version: 1, summary: 'Printer spooler wedged; restarted.' } },
    });
    const got = await getLatestTicketProposal('11111111-1111-1111-1111-111111111111');
    expect(got?.runId).toBe('run-1');
    expect(got?.proposal.summary).toBe('Printer spooler wedged; restarted.');
  });

  it('returns null when the newest finished triage run produced no proposal', async () => {
    rows.push({ id: 'run-2', finishedAt: new Date(), intentIds: [], outcome: {} });
    expect(await getLatestTicketProposal('11111111-1111-1111-1111-111111111111')).toBeNull();
  });

  it('passes the run\'s own ticketTriageSkipped through, same as the run-detail page (#4211 review)', async () => {
    rows.push({
      id: 'run-3',
      finishedAt: new Date('2026-09-13T00:00:00Z'),
      intentIds: [],
      outcome: {
        ticketProposal: { version: 1, summary: 'Spooler wedged.' },
        ticketTriageSkipped: [{ item: 'note', reason: 'human_set' }],
      },
    });
    const got = await getLatestTicketProposal('11111111-1111-1111-1111-111111111111');
    expect(got?.proposal.skipped).toEqual([{ item: 'note', reason: 'human_set' }]);
  });
});
