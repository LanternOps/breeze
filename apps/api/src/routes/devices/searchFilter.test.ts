import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { deviceSearchCondition } from './searchFilter';

function render(term: string) {
  const q = new PgDialect().sqlToQuery(deviceSearchCondition(term));
  return { sql: q.sql, params: q.params };
}

// The Wisp entity picker (W08) promises "Search by name or number" and sends
// the typed text to GET /devices?search=. The filter was a case-sensitive LIKE
// on hostname only: "macOS" found nothing although the device's display name is
// "E2E macOS Test Device" and its hostname is e2e-macos.local.
describe('deviceSearchCondition', () => {
  it('matches hostname OR display name, case-insensitively', () => {
    const { sql, params } = render('macOS');
    expect(sql).toMatch(/"hostname" ilike/);
    expect(sql).toMatch(/"display_name" ilike/);
    expect(sql).toMatch(/ or /);
    expect(params).toEqual(['%macOS%', '%macOS%']);
  });

  it('escapes LIKE wildcards in the typed text', () => {
    const { params } = render('100%_done');
    expect(params[0]).toBe('%100\\%\\_done%');
  });
});
