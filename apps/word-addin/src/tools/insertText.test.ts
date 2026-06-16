import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { insertText } from './insertText';

describe('insert_text', () => {
  it('replaces the selection at the Replace location', async () => {
    const mock = getOfficeMock();
    mock.setBody('Hello OLD world');
    const a = 'Hello '.length;
    mock.select(a, a + 'OLD'.length);
    await expect(insertText({ text: 'NEW', location: 'Replace' })).resolves.toEqual({
      inserted: true,
      location: 'Replace',
      charactersInserted: 3,
    });
    expect(mock.bodyText).toBe('Hello NEW world');
  });

  it('inserts at the End of the selection', async () => {
    const mock = getOfficeMock();
    mock.setBody('abc');
    mock.select(0, 3);
    await insertText({ text: '!', location: 'End' });
    expect(mock.bodyText).toBe('abc!');
  });

  it('passes a validated PascalCase location straight through as a Word.InsertLocation value', async () => {
    const mock = getOfficeMock();
    mock.setBody('xy');
    mock.select(0, 0);
    await insertText({ text: 'Z', location: 'Start' });
    expect(mock.bodyText).toBe('Zxy');
  });

  it('rejects a location outside the 5-value enum', async () => {
    const mock = getOfficeMock();
    mock.setBody('abc');
    mock.select(0, 3);
    await expect(insertText({ text: 'x', location: 'Sideways' })).rejects.toThrow(/location/);
  });

  it('rejects a missing/empty text', async () => {
    await expect(insertText({ location: 'End' })).rejects.toThrow(/text/);
  });
});
