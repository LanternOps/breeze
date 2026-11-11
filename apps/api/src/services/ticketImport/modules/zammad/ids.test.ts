import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedTicket } from '../../moduleContract';
import { clearZammadDirectoryCache } from './directory';
import { FakeZammad, zammadTestHandle } from './fakeZammad.fixtures';
import { articleIdOf, isZammadSourceArticleId, storeIdOf, zammadIds } from './ids';
import { loadZammad, zammadRow } from './reading';
import type { ZammadLoadedData } from './shapes';

/** The id grammar of spec 2026-10-19 §6.5 and `isSourceArticleId` (§5.2, §5.3 item 3). */

afterEach(() => clearZammadDirectoryCache());

function loaded(stateType: string, articleIds: number[]): LoadedTicket {
  const data = {
    baseUrl: 'https://zammad.example.test',
    ticket: { id: 7 },
    articles: articleIds.map((id) => ({ id })),
    tags: [],
    state: { id: 2, name: stateType, type: stateType },
    priorityName: null,
    merge: null,
    people: {},
  } as unknown as ZammadLoadedData;
  return { row: { key: '7', version: 'v', orgKey: null, summary: {} }, data };
}

describe('the id grammar (§6.5)', () => {
  it('builds every id of the table', () => {
    expect(zammadIds.ticket(31)).toBe('31');
    expect(zammadIds.article(1001)).toBe('article:1001');
    expect(zammadIds.articleFiles(1004)).toBe('article-files:1004');
    expect(zammadIds.ownerNote(103, 5)).toBe('note:103:owner:5');
    expect(zammadIds.pendingNote(103, 3, '2026-11-20T09:00:00.000Z')).toBe('note:103:pending:3:2026-11-20T09:00:00.000Z');
    expect(zammadIds.pendingNote(103, 3, null)).toBe('note:103:pending:3:none');
    expect(zammadIds.mergeNote(105, 106)).toBe('note:105:merged:106');
    expect(zammadIds.mergeNote(105, null)).toBe('note:105:merged:none');
    expect(zammadIds.timeNote(102, '45')).toBe('note:102:time:45');
    expect(zammadIds.attachment(5001)).toBe('attachment:5001');
  });

  it('parses only the ids it minted', () => {
    expect(articleIdOf('article:1001')).toBe(1001);
    expect(articleIdOf('article-files:1001')).toBeNull();
    expect(articleIdOf('article:0')).toBeNull();
    expect(articleIdOf('article:12x')).toBeNull();
    expect(articleIdOf(' article:12')).toBeNull();
    expect(storeIdOf('attachment:5001')).toBe(5001);
    expect(storeIdOf('attachment:')).toBeNull();
    expect(storeIdOf('file:5001')).toBeNull();
  });
});

describe('isSourceArticleId', () => {
  it('is true for a source article and false for every id the module composes', () => {
    expect(isZammadSourceArticleId('article:1001')).toBe(true);
    for (const id of ['article-files:1004', 'note:103:owner:5', 'note:103:pending:3:none', 'note:105:merged:106', 'note:102:time:45', 'attachment:5001', '101', 'article:']) {
      expect(isZammadSourceArticleId(id)).toBe(false);
    }
  });

  it('with the loaded ticket: true only for an article the conversion makes a comment, or one the ticket lost (review 10)', async () => {
    const fake = new FakeZammad();
    const ticket103 = zammadRow(fake.data.tickets.find((t) => t.id === 103) as never);
    const skip = await loadZammad(zammadTestHandle(fake), ticket103);
    // 1008 is a comment: compared, and counted missing if it disappears.
    expect(isZammadSourceArticleId('article:1008', skip)).toBe(true);
    // 1006 is the description and 1007 a System article the options skip: never compared or missing.
    expect(isZammadSourceArticleId('article:1006', skip)).toBe(false);
    expect(isZammadSourceArticleId('article:1007', skip)).toBe(false);
    // Kept as an internal note, the System article is a comment like any other.
    const kept = await loadZammad(zammadTestHandle(fake, { options: { systemArticles: 'internal_note' } }), ticket103);
    expect(isZammadSourceArticleId('article:1007', kept)).toBe(true);
    // An article the ticket no longer holds was deleted in the source.
    expect(isZammadSourceArticleId('article:9999', skip)).toBe(true);
    // Every note the module composes is module output.
    expect(isZammadSourceArticleId('note:103:owner:5', skip)).toBe(false);
    expect(isZammadSourceArticleId('note:103:pending:3:2026-11-20T09:00:00.000Z', skip)).toBe(false);
  });

  it('with the loaded ticket: no article of a merged ticket was deleted, the source moved them all (Z9, W0)', () => {
    const merged = loaded('merged', [1041]);
    expect(isZammadSourceArticleId('article:1025', merged)).toBe(false);
    expect(isZammadSourceArticleId('article:1026', merged)).toBe(false);
    expect(isZammadSourceArticleId('note:113:time:5', merged)).toBe(false);
  });

  it('a loaded ticket that is not this module\'s shape is ignored', () => {
    expect(isZammadSourceArticleId('article:1', { row: { key: '1', version: 'v', orgKey: null, summary: {} }, data: { other: true } })).toBe(true);
  });
});
