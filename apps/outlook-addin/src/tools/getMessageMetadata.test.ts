import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { getMessageMetadata } from './getMessageMetadata';

describe('get_message_metadata', () => {
  it('returns the message headers AND packs them into cells for DLP parity', async () => {
    const mock = getOfficeMock();
    mock.setItem(
      {
        subject: 'Invoice #42',
        from: { displayName: 'Bob', emailAddress: 'bob@example.com' },
        to: [{ displayName: 'Me', emailAddress: 'me@example.com' }],
        cc: [{ displayName: 'Cara', emailAddress: 'cara@example.com' }],
        dateTimeCreated: new Date('2026-06-14T12:00:00.000Z'),
      },
      'read',
    );
    const result = (await getMessageMetadata({})) as {
      subject: string;
      from: string;
      to: string[];
      cc: string[];
      date: string;
      cells: string[][];
    };
    expect(result.subject).toBe('Invoice #42');
    expect(result.from).toBe('bob@example.com');
    expect(result.to).toEqual(['me@example.com']);
    expect(result.cc).toEqual(['cara@example.com']);
    expect(result.date).toBe('2026-06-14T12:00:00.000Z');
    // Every header value must also appear under cells so the per-cell DLP scan fires.
    const flat = result.cells.flat();
    expect(flat).toContain('Invoice #42');
    expect(flat).toContain('bob@example.com');
    expect(flat).toContain('me@example.com');
    expect(flat).toContain('cara@example.com');
  });

  it('handles empty recipient lists', async () => {
    const mock = getOfficeMock();
    mock.setItem({ subject: 'No recipients', body: '' }, 'read');
    const result = (await getMessageMetadata({})) as {
      to: string[];
      cc: string[];
      cells: string[][];
    };
    expect(result.to).toEqual([]);
    expect(result.cc).toEqual([]);
    expect(Array.isArray(result.cells)).toBe(true);
  });
});
