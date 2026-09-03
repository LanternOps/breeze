import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUSTOM_ORG_REWRITE_TABLES } from '../routes/devices/core';
import {
  applyTicketChildLockOrder,
  TICKET_CHILD_ORG_REWRITE_LOCK_ORDER,
  TICKET_ORG_DENORMALIZED_TABLES,
} from './ticketOrgMoveLockOrder';

/**
 * Cross-axis lock-order contract (#4657).
 *
 * `moveTicketOrg` (ticket axis) and `POST /devices/:id/move-org` (device axis)
 * both re-stamp `org_id` on the same ticket-linked child tables, and their row
 * sets genuinely overlap. Taking those locks in opposite orders is a live
 * AB-BA deadlock (40P01), which is what these assertions exist to prevent from
 * reappearing.
 *
 * This file only pins the two LISTS against the canonical order. The device
 * path's real statement sequence is pinned to `CUSTOM_ORG_REWRITE_TABLES` by
 * moveOrg.test.ts ('moves the device and writes audit on both orgs' asserts
 * `updatedTables` equals the spread of that array), and the ticket path
 * iterates `TICKET_ORG_DENORMALIZED_TABLES` literally — so list agreement here
 * plus that behavior test covers both axes end to end.
 *
 * Both imports are deliberately light: `routes/devices/core.ts` and
 * `ticketOrgMoveLockOrder.ts` are pure data, so this suite runs in the unit
 * job with no database and no module mocking. That is the reason the ticket
 * list lives in its own module instead of inside ticketService.ts, which pulls
 * a live `db` pool at import time.
 */

/** Relative order of `subject`'s entries, restricted to `keep`. */
const project = (subject: readonly string[], keep: ReadonlySet<string>): string[] =>
  subject.filter((t) => keep.has(t));

const canonical = [...TICKET_CHILD_ORG_REWRITE_LOCK_ORDER];
const canonicalSet = new Set<string>(canonical);
const deviceAxis = [...CUSTOM_ORG_REWRITE_TABLES] as string[];
const ticketAxis = [...TICKET_ORG_DENORMALIZED_TABLES] as string[];

describe('ticket child-table org-rewrite lock order (#4657)', () => {
  it('the ticket-move and device-move paths agree on every table they share', () => {
    // The load-bearing assertion. Anything both movers can lock must be
    // ordered identically by both; nothing else about either list matters
    // here. Computed from the intersection rather than from the canonical
    // constant so a table added to BOTH lists is covered even if someone
    // forgets to extend TICKET_CHILD_ORG_REWRITE_LOCK_ORDER.
    const shared = new Set(deviceAxis.filter((t) => ticketAxis.includes(t)));
    expect(shared.size).toBeGreaterThan(0);
    expect(
      project(ticketAxis, shared),
      `moveTicketOrg (TICKET_ORG_DENORMALIZED_TABLES) and the device move ` +
        `(CUSTOM_ORG_REWRITE_TABLES) must lock their shared tables in the same ` +
        `order or a concurrent ticket-move and device-move over the same rows ` +
        `deadlock with 40P01 (#4657). Reorder one to match the other and update ` +
        `TICKET_CHILD_ORG_REWRITE_LOCK_ORDER, which documents the agreed order.`,
    ).toEqual(project(deviceAxis, shared));
  });

  it('ticket_alert_links is locked AFTER time_entries and ticket_parts on both axes', () => {
    // The specific inversion #4657 was filed for, named so a regression says
    // what broke rather than just "arrays differ". The direction is fixed by
    // the shared currency guard, which takes time_entries then ticket_parts
    // FOR UPDATE on both axes and cannot be moved later.
    for (const [axis, tables] of [
      ['ticket axis (moveTicketOrg)', ticketAxis],
      ['device axis (POST /devices/:id/move-org)', deviceAxis],
    ] as const) {
      const links = tables.indexOf('ticket_alert_links');
      const time = tables.indexOf('time_entries');
      const parts = tables.indexOf('ticket_parts');
      expect(links, `${axis} no longer rewrites ticket_alert_links`).toBeGreaterThanOrEqual(0);
      expect(time, `${axis} no longer rewrites time_entries`).toBeGreaterThanOrEqual(0);
      expect(parts, `${axis} no longer rewrites ticket_parts`).toBeGreaterThanOrEqual(0);
      expect(links, `${axis}: ticket_alert_links must follow time_entries`).toBeGreaterThan(time);
      expect(links, `${axis}: ticket_alert_links must follow ticket_parts`).toBeGreaterThan(parts);
    }
  });

  it('both movers order their shared tables exactly as TICKET_CHILD_ORG_REWRITE_LOCK_ORDER documents', () => {
    // Keeps the documented order honest: it must describe what the code does,
    // not what someone once intended. Projects rather than compares directly
    // so a list may still hold extra tables the other axis doesn't reach,
    // even though as of #4643 both axes reach the same six.
    expect(project(ticketAxis, canonicalSet)).toEqual(canonical);
    expect(project(deviceAxis, canonicalSet)).toEqual(canonical);
  });

  it('documents no table that neither mover actually rewrites', () => {
    const orphans = canonical.filter(
      (t) => !deviceAxis.includes(t) && !ticketAxis.includes(t),
    );
    expect(
      orphans,
      'TICKET_CHILD_ORG_REWRITE_LOCK_ORDER names a table no mover touches — ' +
        'drop it, or add the missing rewrite.',
    ).toEqual([]);
  });

  it('lists each table once per axis', () => {
    // A duplicate would make "the position of X" ambiguous and silently
    // weaken every ordering assertion above.
    for (const [axis, tables] of [
      ['TICKET_ORG_DENORMALIZED_TABLES', ticketAxis],
      ['CUSTOM_ORG_REWRITE_TABLES', deviceAxis],
      ['TICKET_CHILD_ORG_REWRITE_LOCK_ORDER', canonical],
    ] as const) {
      expect(new Set(tables).size, `${axis} contains a duplicate entry`).toBe(tables.length);
    }
  });
});

/**
 * Org-merge third-walker contract (#4748).
 *
 * `orgMerge.ts` computes its table walk from `topologicalCascadeOrder()`
 * (tenantCascade.ts) reversed. That function ties on alphabetical order for
 * tables with no FK between them, and the six tables above are exactly such
 * a set (see the FK note in ticketOrgMoveLockOrder.ts) — so left alone, the
 * merge visits them in reverse-alphabetical order, which disagrees with the
 * canonical lock order the two movers share. `fenceLoser()`'s app-layer fence
 * is the only thing keeping a merge and an in-flight move apart; a move that
 * starts before the fence lands can still contend under AB-BA ordering
 * (40P01).
 *
 * `applyTicketChildLockOrder` is the fix: given any walk order, it leaves
 * every other table's position untouched and permutes only the ticket child
 * tables' own slots into canonical relative order. These tests pin its
 * behavior directly (no DB needed — it's a pure array transform) and then
 * grep orgMerge.ts's source to prove both of its walk-order computations
 * actually call it, so a future edit that reintroduces a bare
 * `[...(await topologicalCascadeOrder())].reverse()` fails here rather than
 * only under Integration Tests.
 */
describe('org-merge walk order honors the canonical ticket child-table lock order (#4748)', () => {
  it('demonstrates the gap: naive reverse-alphabetical tie-break disagrees with canonical order', () => {
    // This is exactly what topologicalCascadeOrder() reversed produces for a
    // set of siblings with no FK between them (alphabetical tie-break,
    // reversed) — see the SCOPE note in ticketOrgMoveLockOrder.ts. It must
    // NOT equal the canonical order, or this whole fix would be moot.
    const naiveMergeOrder = [...canonical].sort().reverse();
    expect(naiveMergeOrder).not.toEqual(canonical);
  });

  it('reorders only the ticket child tables, in place, to canonical order', () => {
    const walkOrder = [
      'organizations',
      'tickets',
      'unrelated_table',
      'time_entries',
      'ticket_parts',
      'ticket_outbox',
      'ticket_email_links',
      'ticket_attachments',
      'ticket_alert_links',
      'users',
    ];
    const fixed = applyTicketChildLockOrder(walkOrder);

    // Every non-ticket-child table stays at its original index.
    expect(fixed[0]).toBe('organizations');
    expect(fixed[1]).toBe('tickets');
    expect(fixed[2]).toBe('unrelated_table');
    expect(fixed[9]).toBe('users');

    // The six ticket-child slots (indices 3-8) now read out in canonical
    // relative order.
    expect(fixed.slice(3, 9)).toEqual(canonical);

    // Same multiset of tables — nothing added, nothing dropped.
    expect([...fixed].sort()).toEqual([...walkOrder].sort());
  });

  it('is a no-op when the ticket child tables are already in canonical order', () => {
    const walkOrder = ['tickets', ...canonical, 'users'];
    expect(applyTicketChildLockOrder(walkOrder)).toEqual(walkOrder);
  });

  it('handles a subset of the ticket child tables without touching the rest', () => {
    const walkOrder = ['tickets', 'ticket_alert_links', 'time_entries', 'users'];
    // Only time_entries and ticket_alert_links present; canonical says
    // time_entries comes first.
    expect(applyTicketChildLockOrder(walkOrder)).toEqual([
      'tickets',
      'time_entries',
      'ticket_alert_links',
      'users',
    ]);
  });

  it('orgMerge.ts routes BOTH of its walk-order computations through applyTicketChildLockOrder', () => {
    // Static contract, not a behavior test: if a future edit adds a second
    // raw computation site or has a walk-order consumer bypass
    // getOrgMergeWalkOrder(), this fails in the unit job instead of only
    // manifesting as a live 40P01 under load.
    const source = readFileSync(new URL('./orgMerge.ts', import.meta.url), 'utf8');
    const bareReverse = /\[\.\.\.\(await topologicalCascadeOrder\(\)\)\]\.reverse\(\)/g;
    expect(
      source.match(bareReverse) ?? [],
      'expected exactly ONE raw `[...(await topologicalCascadeOrder())].reverse()` in ' +
        'orgMerge.ts — the single definition inside getOrgMergeWalkOrder(). A second raw ' +
        'occurrence means a walk-order consumer bypassed the applyTicketChildLockOrder fix (#4748).',
    ).toHaveLength(1);

    const walkOrderCalls = source.match(/await getOrgMergeWalkOrder\(\)/g) ?? [];
    expect(
      walkOrderCalls.length,
      'expected orgMerge.ts to compute its walk order via getOrgMergeWalkOrder() at both ' +
        'consumption sites (the main merge transaction and the preview) — a different count ' +
        'means one of them reverted to a raw topologicalCascadeOrder().reverse() (#4748).',
    ).toBe(2);

    expect(
      source.includes('applyTicketChildLockOrder('),
      'getOrgMergeWalkOrder() no longer calls applyTicketChildLockOrder — the #4748 fix was removed.',
    ).toBe(true);
  });
});
