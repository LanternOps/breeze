import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { extractActionItems } from './extractActionItems';

describe('extract_action_items', () => {
  it('returns subject and the body paragraphs under cells (one per row)', async () => {
    const mock = getOfficeMock();
    mock.setItem(
      {
        subject: 'Action needed',
        body: 'Please review the doc.\nSend feedback by Friday.',
      },
      'read',
    );
    const result = (await extractActionItems({})) as { subject: string; cells: string[][] };
    expect(result.subject).toBe('Action needed');
    expect(result.cells).toEqual([
      ['Please review the doc.'],
      ['Send feedback by Friday.'],
    ]);
  });

  it('reads the body through getAsync', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'x', body: 'one' }, 'read');
    await extractActionItems({});
    expect(mock.bodyGetCalls.length).toBe(1);
  });

  it('handles an empty body with an empty cells matrix', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'Empty', body: '' }, 'read');
    const result = (await extractActionItems({})) as { cells: string[][] };
    expect(result.cells).toEqual([]);
  });
});
