/**
 * Live-Postgres proof for 2027-01-18-169000-wisp-concerns-readiness-subject.sql.sql
 * (#10386): readiness notes stored under the org subject move to the
 * `readiness` kind, the org concerns the onboarding note overwrote are
 * resolved, and nothing else is touched. Replaying it is a no-op.
 *
 * setup.ts has already applied every migration to an empty database, so each
 * test seeds the pre-fix state and replays the file.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { wispConcerns } from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const MIGRATION = '2027-01-18-169000-wisp-concerns-readiness-subject.sql.sql';
const migrationSql = readFileSync(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

async function replayMigration() {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql.raw(migrationSql));
  });
}

const NOTE_EVIDENCE = { readiness: { checks: [{ watchKind: 'ticket_waiting', serviceable: false }], missingIntegrations: ['psa'] } };
const NOTE_SUMMARY = "I can watch alerts here. I can't watch tickets (no tickets in 90 days).";

type Seed = Partial<typeof wispConcerns.$inferInsert> & { orgId: string; partnerId: string };

async function seedConcern(row: Seed): Promise<string> {
  const [inserted] = await getTestDb().insert(wispConcerns).values({
    subjectKind: 'org',
    subjectId: row.orgId,
    summary: 'Patch jobs failing since 2026-10-08',
    severity: 'high',
    evidence: {},
    ...row,
  }).returning({ id: wispConcerns.id });
  return inserted!.id;
}

async function rowOf(id: string) {
  const [row] = await getTestDb().select().from(wispConcerns).where(eq(wispConcerns.id, id));
  return row!;
}

async function twoOrgs() {
  const partner = await createPartner();
  const a = await createOrganization({ partnerId: partner.id });
  const b = await createOrganization({ partnerId: partner.id });
  return { partnerId: partner.id, orgA: a.id, orgB: b.id };
}

describe('wisp concerns readiness subject migration (#10386)', () => {
  runDb('moves both readiness notes (any status) off the org subject by their exact signatures', async () => {
    const { partnerId, orgA, orgB } = await twoOrgs();
    const onboarding = await seedConcern({
      partnerId, orgId: orgA, signature: `readiness:${orgA}`, severity: 'info', summary: NOTE_SUMMARY, evidence: NOTE_EVIDENCE,
    });
    const noAgent = await seedConcern({
      partnerId, orgId: orgB, signature: `wisp-readiness:no-effective-agent:${orgB}`, severity: 'info',
      status: 'resolved', summary: "Wisp can't check this organization yet.", evidence: { href: '/settings/ai-agents' },
    });
    // A signature naming ANOTHER org is not this org's note (closed, so the
    // live signature index does not refuse the seed).
    const foreign = await seedConcern({
      partnerId, orgId: orgB, signature: `readiness:${orgA}`, severity: 'info', status: 'dismissed',
    });

    await replayMigration();

    expect(await rowOf(onboarding)).toMatchObject({ subjectKind: 'readiness', subjectId: orgA, status: 'open', severity: 'info' });
    expect(await rowOf(noAgent)).toMatchObject({ subjectKind: 'readiness', subjectId: orgB, status: 'resolved' });
    expect(await rowOf(foreign)).toMatchObject({ subjectKind: 'org', status: 'dismissed' });
  });

  runDb('resolves a live org concern the note overwrote, and leaves look-alikes alone', async () => {
    const { partnerId, orgA, orgB } = await twoOrgs();
    const overwritten = await seedConcern({ partnerId, orgId: orgA, summary: NOTE_SUMMARY, evidence: NOTE_EVIDENCE });
    // Org concern with readiness-shaped evidence PLUS a key of its own: a real concern.
    const extraKey = await seedConcern({ partnerId, orgId: orgB, summary: NOTE_SUMMARY, evidence: { ...NOTE_EVIDENCE, alertIds: [1] } });
    // Same evidence on a device subject: never an org slot.
    const device = await seedConcern({
      partnerId, orgId: orgA, subjectKind: 'device', subjectId: randomUUID(), summary: NOTE_SUMMARY, evidence: NOTE_EVIDENCE,
    });

    await replayMigration();

    const fixed = await rowOf(overwritten);
    expect(fixed).toMatchObject({ subjectKind: 'org', status: 'resolved', severity: 'high' });
    expect(fixed.outcome).toMatch(/#10386/);
    expect(fixed.resolvedAt).not.toBeNull();
    expect(await rowOf(extraKey)).toMatchObject({ status: 'open', outcome: null });
    expect(await rowOf(device)).toMatchObject({ status: 'open', outcome: null });
  });

  runDb('an overwritten concern a later run re-edited (summary no longer the note) is left alone', async () => {
    const { partnerId, orgA } = await twoOrgs();
    const reedited = await seedConcern({ partnerId, orgId: orgA, summary: 'Patch failures continue on 5 devices', evidence: NOTE_EVIDENCE });
    await replayMigration();
    expect(await rowOf(reedited)).toMatchObject({ status: 'open', subjectKind: 'org' });
  });

  runDb('replaying the file changes nothing more', async () => {
    const { partnerId, orgA } = await twoOrgs();
    const note = await seedConcern({
      partnerId, orgId: orgA, signature: `readiness:${orgA}`, severity: 'info', summary: NOTE_SUMMARY, evidence: NOTE_EVIDENCE,
    });
    await replayMigration();
    const first = await rowOf(note);
    await replayMigration();
    const second = await rowOf(note);
    expect(second).toMatchObject({ subjectKind: 'readiness', status: 'open' });
    expect(second.updatedAt).toEqual(first.updatedAt);
  });
});
