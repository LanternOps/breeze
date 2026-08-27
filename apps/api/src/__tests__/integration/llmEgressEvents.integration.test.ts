/**
 * `llm_egress_events` schema contracts against real Postgres (#3922 phase 2).
 *
 * Two constraints on this table are declared in TWO places that nothing forces
 * to agree, which is exactly the shape of bug a unit test cannot see:
 *
 *  1. **Surface drift.** `LLM_EGRESS_SURFACES` (db/schema/llmEgressEvents.ts)
 *     and the `llm_egress_events_surface_chk` CHECK in
 *     `2026-09-13-c-llm-egress-events.sql` are hand-mirrored. Adding a surface
 *     to the TS union alone compiles, passes every mocked test, and then fails
 *     at runtime with a 23514 on the audit write — which the recorder swallows
 *     by design, so the row is lost SILENTLY. Inserting one row per declared
 *     surface is the only thing that catches it.
 *  2. **Dual-axis integrity.** The composite `(org_id, partner_id)` FK is what
 *     stops a row billing one partner for another partner's org. A plain
 *     `org_id` FK would still accept that row.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  LLM_EGRESS_SURFACES,
  llmEgressEvents,
  type LlmEgressSurface,
} from '../../db/schema/llmEgressEvents';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('llm_egress_events schema contracts', () => {
  runDb('accepts a real row for EVERY surface the TypeScript union declares', async () => {
    const { org, partner } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { org, partner };
    });

    // One insert per surface, not one insert with all of them: the failure we
    // are hunting is per-value, and a batch would stop at the first bad one.
    for (const surface of LLM_EGRESS_SURFACES) {
      await withSystemDbAccessContext(() =>
        db.insert(llmEgressEvents).values({
          orgId: org.id,
          partnerId: partner.id,
          surface,
          host: `${surface}.provider.test`,
          resolvedIp: '203.0.113.10',
          blocked: false,
        }),
      );
    }

    const stored = await withSystemDbAccessContext(() =>
      db
        .select({ surface: llmEgressEvents.surface })
        .from(llmEgressEvents)
        .where(eq(llmEgressEvents.orgId, org.id)),
    );

    expect(stored.map((row) => row.surface).sort()).toEqual([...LLM_EGRESS_SURFACES].sort());
  });

  runDb('rejects a surface the CHECK constraint does not know about', async () => {
    const { org, partner } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { org, partner };
    });

    // The cast is the point: this is precisely what a drifted TS union would
    // hand the database, and 23514 is precisely what it would get back.
    await expect(
      withSystemDbAccessContext(() =>
        db.insert(llmEgressEvents).values({
          orgId: org.id,
          partnerId: partner.id,
          surface: 'definitely_not_a_declared_surface' as LlmEgressSurface,
          host: 'openrouter.ai',
          resolvedIp: null,
          blocked: true,
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'llm_egress_events_surface_chk' },
    });
  });

  runDb('rejects a row whose org belongs to a different partner than it names', async () => {
    const { org, otherPartner } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const otherPartner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { org, otherPartner };
    });

    await expect(
      withSystemDbAccessContext(() =>
        db.insert(llmEgressEvents).values({
          orgId: org.id,
          // A real org id and a real partner id — individually valid, together
          // a mis-attributed audit row. Only the COMPOSITE FK catches this.
          partnerId: otherPartner.id,
          surface: 'one_shot_probe',
          host: 'openrouter.ai',
          resolvedIp: '203.0.113.10',
          blocked: false,
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint_name: 'llm_egress_events_org_partner_fk' },
    });
  });

  runDb('does not grant the app role UPDATE on an audit row', async () => {
    const { org, partner } = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      return { org, partner };
    });
    await withSystemDbAccessContext(() =>
      db.insert(llmEgressEvents).values({
        orgId: org.id,
        partnerId: partner.id,
        surface: 'sdk_proxy_connect',
        host: 'openrouter.ai',
        resolvedIp: '203.0.113.10',
        blocked: true,
      }),
    );

    // An audit row states what happened; rewriting `blocked` after the fact
    // would turn the trail into a claim. 42501 = permission denied, from the
    // narrowed GRANT in `2026-09-13-d-llm-egress-events-revoke-update.sql`
    // rather than from RLS.
    await expect(
      withSystemDbAccessContext(() =>
        db
          .update(llmEgressEvents)
          .set({ blocked: false })
          .where(
            and(eq(llmEgressEvents.orgId, org.id), eq(llmEgressEvents.host, 'openrouter.ai')),
          ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
