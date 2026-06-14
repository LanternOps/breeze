import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { summarizeThread } from './summarizeThread';

describe('summarize_thread', () => {
  it('returns subject, from and the body paragraphs under cells (one per row)', async () => {
    const mock = getOfficeMock();
    mock.setItem(
      {
        subject: 'Q3 budget',
        from: { displayName: 'Alice', emailAddress: 'alice@example.com' },
        body: 'First paragraph.\nSecond paragraph.\nThird paragraph.',
      },
      'read',
    );
    const result = (await summarizeThread({})) as {
      subject: string;
      from: string;
      cells: string[][];
    };
    expect(result.subject).toBe('Q3 budget');
    expect(result.from).toBe('alice@example.com');
    // Text MUST live under cells so the server's per-cell DLP scan fires.
    expect(result.cells).toEqual([
      ['First paragraph.'],
      ['Second paragraph.'],
      ['Third paragraph.'],
    ]);
  });

  it('reads through the live getter (records a body.getAsync call)', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Hi', body: 'Only line' }, 'read');
    await summarizeThread({});
    expect(mock.bodyGetCalls.length).toBe(1);
    expect(mock.bodyGetCalls[0].coercionType).toBe('text');
  });

  it('handles an empty body with an empty cells matrix', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Empty', body: '' }, 'read');
    const result = (await summarizeThread({})) as { cells: string[][] };
    expect(result.cells).toEqual([]);
  });

  it('rejects when body.getAsync fails (does not summarize an unread body)', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Unreadable', body: 'secret' }, 'read');
    mock.failBodyGet = true;
    // getAsync failed → readBodyText must reject rather than collapse to '' and
    // hand the model an empty body to summarize.
    await expect(summarizeThread({})).rejects.toThrow(/getAsync failed/);
  });
});
