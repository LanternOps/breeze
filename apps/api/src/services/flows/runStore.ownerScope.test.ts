import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which runs the owner caps count (runStore.ts): every run of an org flow;
 * for a partner-wide flow, only the runs in the new run's organization. The
 * counting queries are recorded and their WHERE clause rendered to SQL; the
 * `flows` subquery that names the owner's flows is a real query builder so it
 * renders too. The same counts run against Postgres in
 * flowRunLease.integration.test.ts.
 */
const { recorded } = vi.hoisted(() => ({ recorded: [] as unknown[] }));

vi.mock('../../db', async () => {
  const { QueryBuilder } = await import('drizzle-orm/pg-core');
  const { flows } = await import('../../db/schema/flows');
  const qb = new QueryBuilder();
  const select = (fields?: Record<string, unknown>) => ({
    from: (table: unknown) => {
      if (table === flows) return qb.select(fields as never).from(flows);
      const chain: Record<string, unknown> = {};
      chain.where = (clause: unknown) => {
        recorded.push(clause);
        return chain;
      };
      chain.limit = () => chain;
      chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([{ n: 0 }]).then(resolve);
      return chain;
    },
  });
  return { db: { select } };
});

import { renderSql } from '../../__tests__/helpers/tableKeyedDb';
import { countActiveRunsForOwner, loadSlotSnapshot } from './runStore';

const PARTNER = 'dddddddd-0000-4000-8000-000000000001';
const ORG_A = 'cccccccc-0000-4000-8000-00000000000a';
const ORG_B = 'cccccccc-0000-4000-8000-00000000000b';
const RUN = { id: 'bbbbbbbb-0000-4000-8000-000000000001', flowId: 'eeeeeeee-0000-4000-8000-000000000001', orgId: ORG_A };

/** True when the rendered clause filters flow_runs.org_id on `orgId`. */
function filtersRunOrg(clause: unknown, orgId: string): boolean {
  const { sql, params } = renderSql(clause);
  const placeholders = [...sql.matchAll(/"flow_runs"\."org_id" = \$(\d+)/g)].map((m) => Number(m[1]));
  return placeholders.some((n) => params[n - 1] === orgId);
}

beforeEach(() => {
  recorded.length = 0;
});

describe('owner run counts', () => {
  it('a partner-wide flow counts active runs in the run organization only', async () => {
    await countActiveRunsForOwner({ orgId: null, partnerId: PARTNER }, ORG_B);
    expect(recorded).toHaveLength(1);
    expect(filtersRunOrg(recorded[0], ORG_B)).toBe(true);
  });

  it('an organization flow counts all its active runs (no extra organization filter)', async () => {
    await countActiveRunsForOwner({ orgId: ORG_A, partnerId: PARTNER }, ORG_A);
    expect(renderSql(recorded[0]).sql).not.toMatch(/"flow_runs"\."org_id"/);
  });

  it('a partner-wide flow counts running runs in the run organization only', async () => {
    await loadSlotSnapshot(RUN, { orgId: null, partnerId: PARTNER });
    // self, other running run of the same (flow, org), then the owner count.
    expect(recorded).toHaveLength(3);
    expect(filtersRunOrg(recorded[2], ORG_A)).toBe(true);
  });

  it('an organization flow counts all its running runs', async () => {
    await loadSlotSnapshot(RUN, { orgId: ORG_A, partnerId: PARTNER });
    expect(renderSql(recorded[2]).sql).not.toMatch(/"flow_runs"\."org_id"/);
  });
});
