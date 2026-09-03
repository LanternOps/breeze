import { describe, expect, it, vi } from 'vitest';

import { deleteDeviceCascade, type DeviceDeletionTx } from './deviceDeletion';

const sentry = { captureMessage: vi.fn() };
// The service reports through the `services/sentry` WRAPPER (init guard +
// scrubEvent), not raw `@sentry/node`, so that is what has to be mocked —
// mocking the raw SDK here would silently intercept nothing.
vi.mock('./sentry', () => ({
  captureMessage: (...a: unknown[]) => sentry.captureMessage(...a),
}));

/**
 * Captures the SQL this cascade issues, in order, so the lock-ordering
 * regression is testable without a database. Follows the `ops` pattern from
 * the #3739 fix (BREEZE-1S).
 *
 * What this CANNOT prove, and deliberately does not claim: that Postgres
 * actually acquired a row lock, that RLS did not filter the row, or that two
 * concurrent transactions serialize. Those need two real connections and belong
 * in an integration test. What it does prove is the ordering contract — that
 * the lock statement is issued before any child table is touched — which is the
 * part a refactor can silently break.
 */
/**
 * A result shaped the way THIS driver actually returns one.
 *
 * The api runs on drizzle-orm/postgres-js (`db/index.ts`), whose `execute()`
 * resolves to an array-like carrying `.count`. It has no `.rowCount` and no
 * `.rows`. An earlier revision of this mock returned `{ rowCount, rows: [] }` —
 * the node-postgres shape — so the code, the mock and the assertions all agreed
 * with each other and were all wrong about the driver, hiding a read that
 * returned 0 on every call. Keep this faithful: if the mock lies, the test
 * cannot see the bug it exists to catch.
 */
function pgResult(rowCount: number): unknown {
  const rows: Record<string, unknown>[] = Array.from({ length: rowCount }, () => ({
    id: 'device-1',
  }));
  Object.defineProperty(rows, 'count', { value: rowCount, enumerable: false });
  return rows;
}

function captureTx(lockedRowCount = 1) {
  const statements: string[] = [];
  const tx: DeviceDeletionTx = {
    execute: vi.fn().mockImplementation((query: unknown) => {
      const text = JSON.stringify(query);
      statements.push(text);
      if (text.includes('FOR UPDATE')) {
        return Promise.resolve(pgResult(lockedRowCount));
      }
      // The tighten statement reads pg_settings (milliseconds, as an integer)
      // and applies the bound in the SAME statement — postgres-js returns a row
      // array carrying a non-enumerable `.count`.
      if (text.includes('pg_settings')) {
        const row: Record<string, unknown>[] = [{ prior_ms: '7000' }];
        Object.defineProperty(row, 'count', { value: 1, enumerable: false });
        return Promise.resolve(row);
      }
      return Promise.resolve(undefined);
    }),
    delete: vi.fn().mockImplementation(() => {
      statements.push('__DELETE_DEVICES_ROW__');
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
  };
  return { tx, statements };
}

describe('deleteDeviceCascade lock ordering', () => {
  it('locks the devices row BEFORE touching any child table (40P01, cf. #3739)', async () => {
    // FK constraints force children-before-parent for the DELETEs, so the
    // order cannot be inverted to match the rest of the codebase. Every other
    // writer spanning both levels takes the devices row first, so without an
    // explicit parent lock a permanent delete racing a re-enrollment of the
    // same device is a textbook AB-BA deadlock.
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    // Guard against a vacuous order check: the cascade must actually have run
    // past the lock, otherwise "first statement" is trivially satisfied.
    expect(statements.length).toBeGreaterThan(5);
    expect(statements).toContain('__DELETE_DEVICES_ROW__');

    // NOTE ON WHAT THIS CAN AND CANNOT SEE: these assertions prove the ORDER in
    // which statements are emitted, nothing more. The mock has no connection,
    // transaction, savepoint or GUC semantics, so it would still pass if the
    // timeout were '3000s', if is_local were false, or if each statement ran on
    // a different pooled connection. Proving the bound actually fires needs two
    // real connections and belongs in an integration test.
    //
    // Emission order: ONE tighten-and-read statement, take the lock, put it
    // back — all before any child table is touched. This used to be four
    // statements; reading pg_settings and applying the bound now ride together,
    // which is what removes the client-side unit parsing.
    expect(statements[0]).toContain('pg_settings');
    expect(statements[0]).toContain('set_config');
    expect(statements[1]).toContain('FOR UPDATE');
    expect(statements[1]).toContain('devices');
    expect(statements[2]).toContain('set_config');
    expect(statements[2]).toContain('lock_timeout');

    // And nothing touches a child table ahead of it.
    const lockIndex = statements.findIndex((t) => t.includes('FOR UPDATE'));
    expect(lockIndex).toBe(1);
  });

  it('restores the caller lock_timeout immediately after taking the lock', async () => {
    // set_config(..., true) is TRANSACTION-local, not statement-local, and both
    // callers run inside an outer transaction (withDbAccessContext) where a
    // nested db.transaction() is only a SAVEPOINT — releasing which does NOT
    // undo a SET LOCAL. Left in force, this function's 3s bound would govern
    // every child DELETE, the route's link-group dissolution, and every later
    // device in the reaper's pass. It must be handed back at once.
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    const restoreIndex = statements.findIndex(
      (t, i) => i > 1 && t.includes('set_config') && t.includes('lock_timeout')
    );
    expect(restoreIndex).toBe(2);
    // Restored to the caller's value, not blindly reset to a hardcoded default.
    expect(statements[restoreIndex]).toContain('7000ms');

    // Nothing that can block may sit between the lock and the restore.
    const firstChildWrite = statements.findIndex(
      (s) => s.includes('DELETE FROM') || s === '__DELETE_DEVICES_ROW__'
    );
    expect(firstChildWrite).toBeGreaterThan(restoreIndex);
  });

  it('stays bounded, reports, and skips the restore when the prior lock_timeout cannot be read', async () => {
    // This used to assert a throw, then briefly asserted an UNBOUNDED wait —
    // both wrong. Aborting kills a delete whose SELF_UNINSTALL already went out;
    // proceeding unbounded pins a pooled connection, which is the outage class
    // the bound exists to prevent. Applying the bound inside the SQL statement
    // makes the question moot: the timeout is ALREADY tightened by the time the
    // client tries to decode the prior value, so an unreadable result costs
    // only the restore — and skipping that leaves the STRICTER value in force.
    const statements: string[] = [];
    const tx: DeviceDeletionTx = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        const text = JSON.stringify(query);
        statements.push(text);
        // A result the decoder genuinely cannot read: it is neither a
        // postgres-js array nor a node-postgres `{rows}`.
        //
        // This fixture used to BE `{ rows: [{ prior_ms: '7000' }] }`, chosen
        // when the decoder only understood arrays. It now understands `{rows}`
        // too — that shape carries the answer, and treating it as unreadable
        // made a parseable result fail — so simulating "unreadable" needs a
        // shape that really is.
        if (text.includes('pg_settings')) {
          return Promise.resolve({ unexpected: 'shape' });
        }
        // Other statements stay in a readable node-postgres shape: the point
        // here is one undecodable prior value, not a broken driver.
        return Promise.resolve({ rows: [{ id: 'device-1' }], rowCount: 1 });
      }),
      delete: vi.fn().mockImplementation(() => {
        statements.push('__DELETE_DEVICES_ROW__');
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    };

    sentry.captureMessage.mockClear();
    await expect(deleteDeviceCascade(tx, 'device-1')).resolves.toBeUndefined();

    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0]?.[0])).toContain('lock_timeout');
    // The bound WAS applied (it rides on the same statement), so exactly one
    // set_config was issued and none afterwards to undo it.
    expect(statements.filter((t) => t.includes('set_config')).length).toBe(1);
    expect(statements[0]).toContain('pg_settings');
    expect(statements.some((t) => t.includes('FOR UPDATE'))).toBe(true);
    expect(statements).toContain('__DELETE_DEVICES_ROW__');
  });

  it('does not widen a caller that already set a stricter lock_timeout', async () => {
    // The doc comment promises this function will not relax a tighter bound.
    // An unconditional set_config broke that promise: a caller holding 500ms
    // was silently relaxed to 3000ms for the REST of the outer transaction,
    // because SET LOCAL is transaction-scoped, not statement-scoped.
    const statements: string[] = [];
    const tx: DeviceDeletionTx = {
      execute: vi.fn().mockImplementation((query: unknown) => {
        const text = JSON.stringify(query);
        statements.push(text);
        if (text.includes('pg_settings')) {
          const row: Record<string, unknown>[] = [{ prior_ms: '500' }];
          Object.defineProperty(row, 'count', { value: 1, enumerable: false });
          return Promise.resolve(row);
        }
        const empty: Record<string, unknown>[] = [{ id: 'device-1' }];
        Object.defineProperty(empty, 'count', { value: 1, enumerable: false });
        return Promise.resolve(empty);
      }),
      delete: vi.fn().mockImplementation(() => {
        statements.push('__DELETE_DEVICES_ROW__');
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    };

    await deleteDeviceCascade(tx, 'device-1');

    // The SQL CASE keeps the caller's 500ms, and because nothing changed there
    // is no restore statement afterwards — one set_config total, not two.
    expect(statements.filter((t) => t.includes('set_config')).length).toBe(1);

    // Assert the CONDITIONAL is actually in the generated SQL. The mock returns
    // prior_ms=500 whatever it is handed, so a count of set_config calls proves
    // nothing about never-widening: replacing the CASE with an unconditional
    // 3000ms assignment leaves every other assertion in this test green. The
    // decision is made by Postgres, so the only thing observable from here is
    // that the expression was sent.
    const tighten = statements.find((t) => t.includes('pg_settings'))!;
    expect(tighten, 'the never-widen CASE is not in the generated SQL').toContain('CASE WHEN');
    // Pin the COMPARISON, not just that a CASE exists. Flipping `>` to `<`
    // widens a stricter caller and left a `CASE WHEN`/`ELSE` check green: the
    // mock returns prior_ms=500 whatever SQL it is handed, so the direction of
    // the test is invisible from the JS side. Only the operator distinguishes
    // "keep the stricter value" from "replace it".
    expect(tighten, 'the tighten no longer keeps the caller when prior < bound')
      .toContain('prior.ms > ');
    expect(tighten).toContain('ELSE prior.ms END');
    // Still took the lock and still completed under the caller's own bound.
    expect(statements.some((t) => t.includes('FOR UPDATE'))).toBe(true);
    expect(statements).toContain('__DELETE_DEVICES_ROW__');
  });

  it('applies the bound when the caller\'s is looser, and restores exactly what was there', async () => {
    const { tx, statements } = captureTx();
    await deleteDeviceCascade(tx, 'device-1');
    // captureTx reports 7000ms > 3000ms, so the bound genuinely tightens and
    // must be applied — then restored to the caller's ORIGINAL value, not to a
    // hard-coded default.
    const sets = statements.filter((t) => t.includes('set_config'));
    expect(sets.length).toBe(2);
    expect(sets[0]).toContain('3000');
    expect(sets[1]).toContain('7000ms');
  });

  it('deletes the devices row last, after the child tables', async () => {
    // The other half of the contract: the parent lock moves to the front, the
    // parent DELETE stays at the back. A change that "fixed" ordering by
    // moving the delete would violate the FKs.
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    expect(statements[statements.length - 1]).toBe('__DELETE_DEVICES_ROW__');
  });

  // #4371 fixup: agent_rollback_events and pam_actuation_results joined
  // peripheral_policy_delivery_events under the SAME guarded escalation —
  // all three have DELETE fully revoked from breeze_app (see
  // DEVICE_CASCADE_AUDIT_ADMIN_TABLES in deviceDeletion.ts).
  it.each([
    'peripheral_policy_delivery_events',
    'agent_rollback_events',
    'pam_actuation_results',
  ])('uses the guarded audit-retention role for append-only table %s', async (table) => {
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    const rowDelete = statements.findIndex((statement) =>
      statement.includes(table) && statement.includes('DELETE FROM')
    );
    expect(rowDelete, `no DELETE statement found for ${table}`).toBeGreaterThan(0);
    expect(statements[rowDelete - 2]).toContain('SET LOCAL ROLE breeze_audit_admin');
    expect(statements[rowDelete - 1]).toContain('breeze.allow_audit_retention');
    expect(statements[rowDelete + 1]).toContain('RESET ROLE');
  });

  it('does NOT use the audit-admin escalation for ordinary device-cascade tables', async () => {
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    // automation_action_results and device_software_inventory_state keep
    // DELETE granted to breeze_app (only TRUNCATE was revoked, and nothing
    // deletes via TRUNCATE) — they must NOT be routed through the
    // escalation, or the escalation set has silently over-grown.
    for (const table of ['automation_action_results', 'device_software_inventory_state']) {
      const rowDelete = statements.findIndex((statement) =>
        statement.includes(table) && statement.includes('DELETE FROM')
      );
      expect(rowDelete, `no DELETE statement found for ${table}`).toBeGreaterThan(0);
      expect(statements[rowDelete - 1]).not.toContain('breeze_audit_admin');
      expect(statements[rowDelete - 1]).not.toContain('breeze.allow_audit_retention');
    }
  });
});


describe('deleteDeviceCascade link detach (#3952)', () => {
  /** The UPDATE this cascade issues for one linked_device_id table. */
  function detachStatementFor(statements: string[], table: string): string {
    const match = statements.filter(
      (s) => s.includes(table) && s.includes('linked_device_id')
    );
    // Exactly one, or the assertions below could be reading the wrong statement.
    expect(match, `expected one detach UPDATE for ${table}`).toHaveLength(1);
    return match[0]!;
  }

  it('clears link_source in the SAME statement that nulls discovered_assets.linked_device_id', async () => {
    // #3952 — `discovered_assets_link_source_requires_link` (migration
    // 2026-06-27-discovered-asset-link-source.sql) is
    // CHECK (link_source IS NULL OR linked_device_id IS NOT NULL). An
    // auto-linked asset therefore carries link_source='auto', and nulling
    // linked_device_id ALONE leaves "a source without a link" — Postgres
    // raises 23514 and the whole permanent-delete transaction rolls back as a
    // 500. Both columns must be cleared, and in one statement: a second
    // follow-up UPDATE would still leave the row constraint-violating at the
    // moment the first one is applied.
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    const detach = detachStatementFor(statements, 'discovered_assets');
    expect(detach).toContain('link_source');
  });

  it('does not invent a link_source column on the other linked table', async () => {
    // network_change_events also lives in DEVICE_LINKED_DEVICE_ID_TABLES but
    // has no link_source column, so a fix that blanket-appended the assignment
    // to every table in the loop would trade a 23514 for a 42703
    // (undefined_column) — a 500 either way. This is the assertion that
    // distinguishes "clear the columns this table actually has" from
    // "clear link_source everywhere".
    const { tx, statements } = captureTx();

    await deleteDeviceCascade(tx, 'device-1');

    const detach = detachStatementFor(statements, 'network_change_events');
    expect(detach).not.toContain('link_source');
  });
});

describe('deleteDeviceCascade when the parent lock is not acquired', () => {
  it('reports rather than aborting when FOR UPDATE matches no row', async () => {
    // Zero rows means the device is already gone (a re-run, or two reapers
    // racing) or RLS filtered it. Deleting an absent device is legitimately
    // idempotent, so aborting would turn a harmless race into an error — but
    // the cascade below then runs under the OLD child-first ordering, which is
    // exactly the race the lock exists to close. It must be visible, not
    // silently assumed safe.
    sentry.captureMessage.mockClear();
    const { tx, statements } = captureTx(0);

    await expect(deleteDeviceCascade(tx, 'device-gone')).resolves.toBeUndefined();

    expect(sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(String(sentry.captureMessage.mock.calls[0]?.[0])).toContain('without holding');
    // Still idempotent: the cascade completed rather than throwing.
    expect(statements).toContain('__DELETE_DEVICES_ROW__');
  });

  it('stays quiet on the normal path where the row is locked', async () => {
    sentry.captureMessage.mockClear();
    const { tx } = captureTx(1);

    await deleteDeviceCascade(tx, 'device-1');

    expect(sentry.captureMessage).not.toHaveBeenCalled();
  });
});
