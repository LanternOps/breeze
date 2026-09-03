import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const {
  selectMock,
  runOutsideDbContextMock,
  withSystemDbAccessContextMock,
  captureExceptionMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(),
  withSystemDbAccessContextMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../../services/sentry', () => ({ captureException: captureExceptionMock }));

import { withAlertActorNames } from './actorNames';

const ADMIN_ID = '9cea2f85-2da1-445d-88cc-7c404d7504c4';
const TECH_ID = '1f0e3f2c-9a2b-4c7d-9f10-8f6a2b3c4d5e';

let capturedWhere: SQL | undefined;
let capturedColumns: Record<string, unknown> | undefined;

function mockUsersQuery(rows: { id: string; name: string }[]) {
  capturedWhere = undefined;
  capturedColumns = undefined;
  selectMock.mockImplementation((columns: Record<string, unknown>) => {
    capturedColumns = columns;
    return {
      from: vi.fn(() => ({
        where: vi.fn((where: SQL) => {
          capturedWhere = where;
          return Promise.resolve(rows);
        }),
      })),
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Passthroughs so the test observes that the lookup was wrapped, without
  // needing a real DB context.
  runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  withSystemDbAccessContextMock.mockImplementation(async (fn: () => unknown) => fn());
});

// resolveUserDisplayNames is intentionally module-private (#3983): it's an
// RLS-bypassing name oracle and withAlertActorNames is its only legitimate
// caller. Exercise its behavior only through that public entry point so a
// future contributor can't reach for it directly off a passing test.
describe('resolveUserDisplayNames (via withAlertActorNames)', () => {
  it('does not touch the database when no row carries a resolvable actor id', async () => {
    mockUsersQuery([]);

    const [alert] = await withAlertActorNames([
      { id: 'alert-1', acknowledgedBy: null, resolvedBy: undefined, dismissedBy: '' },
    ]);

    expect(alert).toEqual(
      expect.objectContaining({
        acknowledgedByName: null,
        resolvedByName: null,
        dismissedByName: null,
      })
    );
    expect(selectMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('selects only id + name and filters on the distinct actor ids', async () => {
    mockUsersQuery([{ id: ADMIN_ID, name: 'Breeze Admin' }]);

    // ADMIN_ID appears three times across these rows — the query must ask for
    // it once.
    const enriched = await withAlertActorNames([
      { id: 'alert-1', acknowledgedBy: ADMIN_ID, resolvedBy: null },
      { id: 'alert-2', acknowledgedBy: ADMIN_ID, resolvedBy: ADMIN_ID },
    ]);

    expect(enriched.map((row) => row.acknowledgedByName)).toEqual([
      'Breeze Admin',
      'Breeze Admin',
    ]);

    // Assert the compiled SQL, not just that `where` was called: a mock-only
    // assertion would pass on an empty or wrong-column predicate.
    const compiled = new PgDialect().sqlToQuery(capturedWhere!);
    expect(compiled.sql).toContain('"users"."id" in');
    expect(compiled.params).toEqual([ADMIN_ID]);

    // Only display fields leave the system-context block — no email, no tenancy
    // columns.
    expect(Object.keys(capturedColumns ?? {}).sort()).toEqual(['id', 'name']);
  });

  it('reads users in a system DB context, outside any request context', async () => {
    mockUsersQuery([{ id: ADMIN_ID, name: 'Breeze Admin' }]);

    await withAlertActorNames([{ id: 'alert-1', acknowledgedBy: ADMIN_ID }]);

    // `users` RLS hides partner-level staff (org_id NULL) from org-scoped
    // callers, so the lookup must escape the request context or the name comes
    // back null for exactly the common MSP case.
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });
});

describe('withAlertActorNames', () => {
  it('attaches display names for every actor id field present on the row', async () => {
    mockUsersQuery([
      { id: ADMIN_ID, name: 'Breeze Admin' },
      { id: TECH_ID, name: 'Dana Tech' },
    ]);

    const [alert] = await withAlertActorNames([
      { id: 'alert-1', acknowledgedBy: ADMIN_ID, resolvedBy: TECH_ID },
    ]);

    expect(alert).toEqual(
      expect.objectContaining({
        acknowledgedBy: ADMIN_ID,
        acknowledgedByName: 'Breeze Admin',
        resolvedBy: TECH_ID,
        resolvedByName: 'Dana Tech',
      })
    );
    // Batched: one round trip for the whole page of alerts.
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('yields a null name (never the raw id) when the user no longer exists', async () => {
    mockUsersQuery([]);

    const [alert] = await withAlertActorNames([{ id: 'alert-1', acknowledgedBy: ADMIN_ID }]);

    expect(alert!.acknowledgedByName).toBeNull();
  });

  it('leaves out the name key for an actor field the caller did not select', async () => {
    mockUsersQuery([{ id: ADMIN_ID, name: 'Breeze Admin' }]);

    const [alert] = await withAlertActorNames([
      { id: 'alert-1', acknowledgedBy: ADMIN_ID } as { id: string; acknowledgedBy: string },
    ]);

    expect(alert).not.toHaveProperty('resolvedByName');
    expect(alert).not.toHaveProperty('dismissedByName');
  });

  it('reports a null name for an unset actor id without querying for it', async () => {
    mockUsersQuery([]);

    const [alert] = await withAlertActorNames([
      { id: 'alert-1', acknowledgedBy: null, resolvedBy: null },
    ]);

    expect(alert).toEqual(
      expect.objectContaining({ acknowledgedByName: null, resolvedByName: null })
    );
    expect(selectMock).not.toHaveBeenCalled();
  });

  it('resolves a technician who acknowledged several alerts with ONE query', async () => {
    // The realistic MSP page: one tech acked three alerts. The id must be
    // deduped into a single round trip, and every row still gets the name.
    mockUsersQuery([{ id: ADMIN_ID, name: 'Breeze Admin' }]);

    const enriched = await withAlertActorNames([
      { id: 'alert-1', acknowledgedBy: ADMIN_ID, resolvedBy: null },
      { id: 'alert-2', acknowledgedBy: ADMIN_ID, resolvedBy: null },
      { id: 'alert-3', acknowledgedBy: ADMIN_ID, resolvedBy: ADMIN_ID },
    ]);

    expect(selectMock).toHaveBeenCalledTimes(1);
    const compiled = new PgDialect().sqlToQuery(capturedWhere!);
    expect(compiled.params).toEqual([ADMIN_ID]);
    expect(enriched.map((row) => row.acknowledgedByName)).toEqual([
      'Breeze Admin',
      'Breeze Admin',
      'Breeze Admin',
    ]);
    expect(enriched[2]!.resolvedByName).toBe('Breeze Admin');
  });

  it('returns the alerts unenriched — never throws — when the lookup fails', async () => {
    // Names are cosmetic. A users-table blip must not 500 the whole Alerts
    // page, but it must be reported: a silent degradation here is
    // indistinguishable from "that technician was deleted".
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('connection terminated unexpectedly');
    selectMock.mockImplementation(() => ({
      from: vi.fn(() => ({ where: vi.fn(() => Promise.reject(boom)) })),
    }));

    const enriched = await withAlertActorNames([
      { id: 'alert-1', acknowledgedBy: ADMIN_ID },
    ]);

    expect(enriched).toEqual([{ id: 'alert-1', acknowledgedBy: ADMIN_ID }]);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      boom,
      undefined,
      expect.objectContaining({ stage: 'actor-name-resolution' })
    );
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('short-circuits on an empty page of alerts', async () => {
    mockUsersQuery([]);

    await expect(withAlertActorNames([])).resolves.toEqual([]);
    expect(selectMock).not.toHaveBeenCalled();
  });

  // #4445 — the alerts route runs a second withAlertActorNames call on
  // pseudo-rows built from live verdicts (`{ id: verdict.id, feedbackBy }`)
  // so the verdict badge can show who already voted. Same generic mechanism
  // as acknowledgedBy/resolvedBy/dismissedBy, just a different id field.
  it('resolves feedbackBy to feedbackByName for a verdict pseudo-row', async () => {
    mockUsersQuery([{ id: TECH_ID, name: 'Dana Tech' }]);

    const [row] = await withAlertActorNames([
      { id: 'verdict-1', feedbackBy: TECH_ID },
    ]);

    expect(row).toEqual(
      expect.objectContaining({ feedbackBy: TECH_ID, feedbackByName: 'Dana Tech' })
    );
  });
});
