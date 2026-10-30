/**
 * The report-only detail of a resume (#8313 W0; spec 2026-10-19 §5.3 item 3,
 * §5.9), without a database: what `sourceChanges` reports from the plan's
 * read. The same fields run against Postgres in ticketImport.integration.test.ts.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(() => undefined),
  withDbAccessContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
  runOutsideDbContext: vi.fn(),
}));

import type { ImportedTicket } from './importedTicket';
import { noSourceChanges, sourceChanges, type StoredImportedComment } from './sourceChanges';

const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const CONTACT = '55555555-5555-4555-8555-555555555555';
const OTHER_CONTACT = '56565656-5656-4565-8565-565656565656';
const T0 = new Date('2021-03-04T09:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function comment(sourceId: string, content: string, isPublic = true): ImportedTicket['comments'][number] {
  return { sourceId, createdAt: at(10), isPublic, author: { kind: 'staff', name: 'Tess' }, content };
}

function ticket(overrides: Partial<ImportedTicket> = {}): ImportedTicket {
  return {
    sourceId: 'zammad-41023', orgId: ORG, createdAt: T0, updatedAt: at(300), subject: 'Printer jams', description: '',
    priority: 'normal', source: 'email', requester: { name: 'Maya', email: 'maya@customer.example' }, finalStatus: 'open',
    comments: [], ...overrides,
  };
}

function storedComment(sourceId: string, content: string, isPublic = true, extra: Partial<StoredImportedComment> = {}): StoredImportedComment {
  return { sourceId, isPublic, contentHash: sha256(content), edited: false, deleted: false, mergedIn: false, ...extra };
}

const stored = (overrides: Partial<{ orgId: string; requesterContactId: string | null; submitterEmail: string | null }> = {}) => ({
  orgId: ORG, requesterContactId: null, submitterEmail: 'maya@customer.example', ...overrides,
});

describe('sourceChanges — what a resume reports and does not apply', () => {
  it('reports nothing for an unchanged ticket, and a first import reports nothing at all', () => {
    const t = ticket({ comments: [comment('a1', 'Hi'), comment('a2', 'Note', false)] });
    expect(sourceChanges(stored(), [storedComment('a1', 'Hi'), storedComment('a2', 'Note', false)], t, () => true))
      .toEqual(noSourceChanges());
    expect(noSourceChanges()).toEqual({ requesterChanged: false, orgChanged: false, commentsChangedInSource: [], commentsMissingInSource: [] });
    // A fresh object each time: one result's lists are never another's.
    expect(noSourceChanges().commentsChangedInSource).not.toBe(noSourceChanges().commentsChangedInSource);
  });

  // Review finding 8: the SQL strips a trailing skip note from the stored
  // content; the input side gets the same normalization.
  it('a source body that itself ends in a skip-note line is not reported as changed', () => {
    const body = 'Forwarded.\n\n[Attachments not imported: a.zip (over the 10 MB limit)]';
    // What the SQL hashes for the stored comment: the content without the trailing note.
    const storedRow = { ...storedComment('a1', 'Forwarded.'), contentHash: sha256('Forwarded.') };
    expect(sourceChanges(stored(), [storedRow], ticket({ comments: [comment('a1', body)] })).commentsChangedInSource).toEqual([]);
    // A real edit is still seen.
    expect(sourceChanges(stored(), [storedRow], ticket({ comments: [comment('a1', 'Forwarded, edited.')] })).commentsChangedInSource)
      .toEqual([{ sourceId: 'a1', contentChanged: true, visibility: null }]);
  });

  describe('requesterChanged', () => {
    it('compares a display-only email trimmed and case-insensitively, and never the name', () => {
      expect(sourceChanges(stored(), [], ticket({ requester: { name: 'Maya R.', email: 'Maya@Customer.Example' } })).requesterChanged).toBe(false);
      expect(sourceChanges(stored({ submitterEmail: ' maya@customer.example ' }), [], ticket()).requesterChanged).toBe(false);
      expect(sourceChanges(stored(), [], ticket({ requester: { name: 'Maya', email: 'other@customer.example' } })).requesterChanged).toBe(true);
    });

    it('treats no email on both sides as equal, and an email gained or lost as a change', () => {
      expect(sourceChanges(stored({ submitterEmail: null }), [], ticket({ requester: { name: 'Walk-in' } })).requesterChanged).toBe(false);
      expect(sourceChanges(stored({ submitterEmail: '  ' }), [], ticket({ requester: { name: 'Walk-in' } })).requesterChanged).toBe(false);
      expect(sourceChanges(stored({ submitterEmail: null }), [], ticket()).requesterChanged).toBe(true);
      expect(sourceChanges(stored(), [], ticket({ requester: { name: 'Maya' } })).requesterChanged).toBe(true);
    });

    it('compares contacts by id', () => {
      expect(sourceChanges(stored({ requesterContactId: CONTACT }), [], ticket({ requester: { contactId: CONTACT } })).requesterChanged).toBe(false);
      expect(sourceChanges(stored({ requesterContactId: CONTACT }), [], ticket({ requester: { contactId: OTHER_CONTACT } })).requesterChanged).toBe(true);
      // A display-only ticket that now matches a contact.
      expect(sourceChanges(stored(), [], ticket({ requester: { contactId: CONTACT } })).requesterChanged).toBe(true);
      // A contact-linked ticket whose input fell back to display-only keeps its snapshot email: the same person.
      expect(sourceChanges(stored({ requesterContactId: CONTACT }), [], ticket()).requesterChanged).toBe(false);
    });
  });

  it('orgChanged: the input names another org than the ticket is in', () => {
    expect(sourceChanges(stored(), [], ticket({ orgId: OTHER_ORG })).orgChanged).toBe(true);
    expect(sourceChanges(stored(), [], ticket()).orgChanged).toBe(false);
  });

  describe('commentsChangedInSource', () => {
    it('lists, in source order, an edited comment and each direction of a flipped internal flag', () => {
      const t = ticket({ comments: [comment('a1', 'Edited in Zammad'), comment('a2', 'Same', false), comment('a3', 'Same'), comment('a4', 'Both', false)] });
      const rows = [storedComment('a1', 'Original'), storedComment('a2', 'Same'), storedComment('a3', 'Same', false), storedComment('a4', 'Original')];
      expect(sourceChanges(stored(), rows, t).commentsChangedInSource).toEqual([
        { sourceId: 'a1', contentChanged: true, visibility: null },
        { sourceId: 'a2', contentChanged: false, visibility: 'made_internal' },
        { sourceId: 'a3', contentChanged: false, visibility: 'made_public' },
        { sourceId: 'a4', contentChanged: true, visibility: 'made_internal' },
      ]);
    });

    it('hashes UTF-8 bytes, so an unchanged non-ASCII comment is not reported', () => {
      const text = 'Impressora não imprime — €5, 日本';
      expect(sourceChanges(stored(), [storedComment('a1', text)], ticket({ comments: [comment('a1', text)] })).commentsChangedInSource).toEqual([]);
    });

    it('compares only the visibility of a comment a Breeze user edited, and skips one a Breeze user deleted', () => {
      const t = ticket({ comments: [comment('a1', 'Source text'), comment('a2', 'Source text', false), comment('a3', 'Changed')] });
      const rows = [
        storedComment('a1', 'Edited in Breeze', true, { edited: true }),
        storedComment('a2', 'Edited in Breeze', true, { edited: true }),
        storedComment('a3', 'Original', true, { deleted: true }),
      ];
      expect(sourceChanges(stored(), rows, t).commentsChangedInSource).toEqual([
        { sourceId: 'a2', contentChanged: false, visibility: 'made_internal' },
      ]);
    });

    it('ignores input comments the ticket does not hold (new ones, or held elsewhere)', () => {
      expect(sourceChanges(stored(), [], ticket({ comments: [comment('new', 'x')] })).commentsChangedInSource).toEqual([]);
    });
  });

  describe('commentsMissingInSource', () => {
    const rows = [
      storedComment('article-1', 'a'),
      // Not in the input: the read hashes only the input's comments.
      storedComment('article-2', 'b', true, { contentHash: null }),
      storedComment('zammad-41023:time-accounting', 'Time: 3h'),
      storedComment('article-9', 'moved here by a Breeze merge', true, { mergedIn: true }),
      storedComment('article-3', 'deleted in Breeze', true, { deleted: true }),
    ];
    const isArticle = (id: string) => id.startsWith('article-');

    it('lists the stored source articles the input no longer has', () => {
      expect(sourceChanges(stored(), rows, ticket({ comments: [comment('article-1', 'a')] }), isArticle).commentsMissingInSource)
        .toEqual(['article-2']);
    });

    it('never counts a composed note, a comment a Breeze merge moved in, or one a Breeze user deleted', () => {
      const missing = sourceChanges(stored(), rows, ticket(), isArticle).commentsMissingInSource;
      expect(missing).toEqual(['article-1', 'article-2']);
    });

    it('counts nothing without isSourceArticleId', () => {
      expect(sourceChanges(stored(), rows, ticket()).commentsMissingInSource).toEqual([]);
    });
  });
});
