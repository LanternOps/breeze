import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { findReplace } from './findReplace';

describe('find_replace', () => {
  it('replaces every match across the document body', async () => {
    const mock = getOfficeMock();
    mock.setBody('foo bar foo baz foo');
    const result = (await findReplace({ query: 'foo', replace: 'X' })) as {
      query: string;
      replaced: number;
    };
    expect(result.query).toBe('foo');
    expect(result.replaced).toBe(3);
    expect(mock.bodyText).toBe('X bar X baz X');
  });

  it('defaults replace to empty string (deletes matches)', async () => {
    const mock = getOfficeMock();
    mock.setBody('keepREMOVEkeep');
    const result = (await findReplace({ query: 'REMOVE' })) as { replaced: number };
    expect(result.replaced).toBe(1);
    expect(mock.bodyText).toBe('keepkeep');
  });

  it('honors matchCase', async () => {
    const mock = getOfficeMock();
    mock.setBody('Cat cat CAT');
    const result = (await findReplace({ query: 'cat', replace: 'dog', matchCase: true })) as {
      replaced: number;
    };
    expect(result.replaced).toBe(1);
    expect(mock.bodyText).toBe('Cat dog CAT');
  });

  it('honors matchWholeWord', async () => {
    const mock = getOfficeMock();
    mock.setBody('cat category cat');
    const result = (await findReplace({
      query: 'cat',
      replace: 'dog',
      matchWholeWord: true,
    })) as { replaced: number };
    expect(result.replaced).toBe(2);
    expect(mock.bodyText).toBe('dog category dog');
  });

  it('reports zero replacements when no match', async () => {
    const mock = getOfficeMock();
    mock.setBody('nothing here');
    const result = (await findReplace({ query: 'zzz', replace: 'x' })) as { replaced: number };
    expect(result.replaced).toBe(0);
    expect(mock.bodyText).toBe('nothing here');
  });

  it('rejects a missing query', async () => {
    await expect(findReplace({ replace: 'x' })).rejects.toThrow(/query/);
  });
});
