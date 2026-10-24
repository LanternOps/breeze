import { describe, expect, it, vi } from 'vitest';
import { resolveBusinessCalendar } from './resolve';

/** Flattens a drizzle sql`` to its static text (bound params dropped). */
function sqlText(q: unknown): string {
  if (q == null) return '';
  if (typeof q === 'string') return q;
  const obj = q as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(obj.queryChunks)) return obj.queryChunks.map(sqlText).join(' ');
  if (Array.isArray(obj.value)) return (obj.value as string[]).join('');
  return '';
}
function sqlParams(q: unknown, out: unknown[] = []): unknown[] {
  const obj = q as { queryChunks?: unknown[]; value?: unknown };
  if (obj && Array.isArray(obj.queryChunks)) {
    for (const c of obj.queryChunks) {
      if (c && typeof c === 'object' && ('queryChunks' in c || ('value' in c && Array.isArray((c as { value: unknown }).value)))) sqlParams(c, out);
      else if (c && typeof c === 'object' && 'value' in c) out.push((c as { value: unknown }).value);
      else if (typeof c !== 'object') out.push(c);
    }
  }
  return out;
}

const owner = { partnerId: 'p-1', orgId: 'o-1' };
const dbReturning = (rows: unknown[]) => ({ execute: vi.fn().mockResolvedValue(rows) });

describe('resolveBusinessCalendar', () => {
  it('returns the org override when one applies', async () => {
    const db = dbReturning([{ calendar_id: 'c-org', source: 'org', revision_id: 'r-org' }]);
    expect(await resolveBusinessCalendar(db as never, owner)).toEqual({ calendarId: 'c-org', revisionId: 'r-org', source: 'org' });
  });

  it('falls through to the partner default', async () => {
    const db = dbReturning([{ calendar_id: 'c-p', source: 'partner', revision_id: 'r-p' }]);
    expect(await resolveBusinessCalendar(db as never, owner)).toEqual({ calendarId: 'c-p', revisionId: 'r-p', source: 'partner' });
  });

  it('is none (24×7) when nothing applies', async () => {
    const db = dbReturning([]);
    expect(await resolveBusinessCalendar(db as never, owner)).toEqual({ calendarId: null, revisionId: null, source: 'none' });
  });

  it('a calendar with no revision resolves to none rather than a dangling id', async () => {
    const db = dbReturning([{ calendar_id: 'c-p', source: 'partner', revision_id: null }]);
    expect(await resolveBusinessCalendar(db as never, owner)).toEqual({ calendarId: null, revisionId: null, source: 'none' });
  });

  it('reads ONE query on the caller connection with explicit owner filters: archived overrides fall through, org rows never cross orgs', async () => {
    const db = dbReturning([]);
    await resolveBusinessCalendar(db as never, owner);
    expect(db.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(db.execute.mock.calls[0]![0]).replace(/\s+/g, ' ');
    // Org override: archived skipped; org-owned only for THIS org, partner-wide only for THIS partner.
    expect(text).toContain('FROM org_ticket_settings s JOIN business_calendars c ON c.id = s.business_calendar_id');
    expect(text).toContain('c.archived_at IS NULL');
    expect(text).toMatch(/c\.org_id = .* OR \( ?c\.org_id IS NULL AND c\.partner_id = /);
    // Partner default.
    expect(text).toContain('c.is_partner_default');
    expect(text).toContain('ORDER BY rank');
    expect(text).toContain('ORDER BY r.revision DESC');
    const params = sqlParams(db.execute.mock.calls[0]![0]);
    expect(params).toContain('o-1');
    expect(params).toContain('p-1');
  });
});
