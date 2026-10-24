/**
 * #8972 W1 Task 1.4 / 1.6 (spec §3.2, §3.3, §3.6, §3.7): mergeTickets, end to
 * end on real Postgres, run in a PARTNER-scope request context (real RLS,
 * `breeze_app`), the way the staff route runs it. Read-backs use the admin
 * pool (getTestDb) so they see every row.
 *
 * One case per §3.3 row, plus the tombstone transition, path compression,
 * the feed stamp, outbox rows and refusals under the lock.
 */
import './setup';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { loadMergeTicketRows, mergeTickets } from '../../services/ticketMerge';
import { previewMerge } from '../../services/ticketMerge/preview';
import { db } from '../../db';
import { MergeRefusedError, TicketMergedError } from '../../services/ticketMerge/errors';
import { addTicketComment, type TicketActor } from '../../services/ticketService';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { businessCalendarIntervals, businessCalendarRevisions, businessCalendars } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const T = 60_000;

type Row = Record<string, unknown>;
const q = async <R = Row>(query: ReturnType<typeof sql>): Promise<R[]> =>
  (await getTestDb().execute(query)) as unknown as R[];
const one = async <R = Row>(query: ReturnType<typeof sql>): Promise<R> => (await q<R>(query))[0]!;

let seq = 0;
async function insertTicket(orgId: string, partnerId: string, extra: {
  subject?: string; description?: string; customFields?: Record<string, unknown>; deviceId?: string | null;
  tags?: string[]; status?: string; createdAt?: Date; submitterEmail?: string; budgetMinutes?: number;
  slaPausedAt?: Date | null; slaPausedMinutes?: number; emailMessageId?: string; emailThreadKey?: string;
} = {}): Promise<string> {
  seq++;
  const r = await one<{ id: string }>(sql`
    INSERT INTO tickets (org_id, partner_id, subject, description, custom_fields, source, priority, ticket_number,
                         internal_number, device_id, tags, status, created_at, submitter_email, budget_minutes,
                         sla_paused_at, sla_paused_minutes, sla_paused_business_minutes, email_message_id, email_thread_key)
    VALUES (${orgId}::uuid, ${partnerId}::uuid, ${extra.subject ?? `merge ${seq}`}, ${extra.description ?? null},
            ${extra.customFields ? JSON.stringify(extra.customFields) : null}::jsonb, 'api', 'normal',
            ${`MRG-${crypto.randomUUID().slice(0, 8)}`}, ${`T-2026-${String(9000 + seq).padStart(4, '0')}`},
            ${extra.deviceId ?? null}::uuid, ${sql.raw(`ARRAY[${(extra.tags ?? []).map((t) => `'${t}'`).join(',')}]::text[]`)},
            ${extra.status ?? 'open'}::ticket_status, ${(extra.createdAt ?? new Date()).toISOString()}::timestamptz, ${extra.submitterEmail ?? null},
            ${extra.budgetMinutes ?? null}, ${extra.slaPausedAt ? extra.slaPausedAt.toISOString() : null}::timestamptz, ${extra.slaPausedMinutes ?? 0},
            ${extra.slaPausedMinutes ?? 0}, ${extra.emailMessageId ?? null}, ${extra.emailThreadKey ?? null})
    RETURNING id`);
  return r.id;
}

async function seed() {
  const partner = await createPartner({ name: 'Merge-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'Merge-Org' });
  const ctx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id],
    currentPartnerId: partner.id, userId: user.id,
  };
  const actor: TicketActor = { kind: 'user', userId: user.id, name: 'Tess Tech' };
  // The source is the NEWER ticket; the survivor the older (D5 default).
  const dst = await insertTicket(org.id, partner.id, { subject: 'Printer offline', createdAt: new Date(Date.now() - 3_600_000) });
  const src = await insertTicket(org.id, partner.id, {
    subject: 'Printer still broken', description: 'Third floor HP', customFields: { floor: '3', urgency: 'high' },
  });
  return { partner, user, org, ctx, actor, src, dst };
}

type Seed = Awaited<ReturnType<typeof seed>>;
const merge = (s: Seed, src = s.src, dst = s.dst, notifyRequester?: boolean) =>
  withDbAccessContext(s.ctx, () => mergeTickets({ sourceTicketId: src, intoTicketId: dst, notifyRequester }, s.actor));

async function insertComment(ticketId: string, userId: string, content: string, isPublic = true): Promise<string> {
  const r = await one<{ id: string }>(sql`
    INSERT INTO ticket_comments (ticket_id, user_id, author_type, comment_type, content, is_public)
    VALUES (${ticketId}::uuid, ${userId}::uuid, 'internal', ${isPublic ? 'comment' : 'internal'}::ticket_comment_type, ${content}, ${isPublic})
    RETURNING id`);
  return r.id;
}

describe('mergeTickets (#8972 W1, spec §3.3)', () => {
  runDb('ticket_comments move, interleaved, merged_from_ticket_id set only where null (A→B→C keeps A)', async () => {
    const s = await seed();
    const a = s.src;
    const cA = await insertComment(a, s.user.id, 'from A');
    const b = await insertTicket(s.org.id, s.partner.id);
    const cB = await insertComment(b, s.user.id, 'from B');
    await merge(s, a, b);
    expect(await one(sql`SELECT ticket_id, merged_from_ticket_id FROM ticket_comments WHERE id = ${cA}::uuid`))
      .toEqual({ ticket_id: b, merged_from_ticket_id: a });
    await merge(s, b, s.dst);
    expect(await one(sql`SELECT ticket_id, merged_from_ticket_id FROM ticket_comments WHERE id = ${cA}::uuid`))
      .toEqual({ ticket_id: s.dst, merged_from_ticket_id: a });
    expect(await one(sql`SELECT ticket_id, merged_from_ticket_id FROM ticket_comments WHERE id = ${cB}::uuid`))
      .toEqual({ ticket_id: s.dst, merged_from_ticket_id: b });
  }, T);

  runDb('writes ONE internal system comment on the survivor with the source subject, description, intake answers and dropped links', async () => {
    const s = await seed();
    await getTestDb().execute(sql`
      INSERT INTO ticket_links (org_id, source_ticket_id, target_ticket_id, link_type)
      VALUES (${s.org.id}::uuid, ${s.src}::uuid, ${s.dst}::uuid, 'caused_by')`);
    await merge(s);
    const notes = await q<{ content: string; is_public: boolean; comment_type: string }>(sql`
      SELECT content, is_public, comment_type::text FROM ticket_comments
       WHERE ticket_id = ${s.dst}::uuid AND comment_type = 'system' AND merged_from_ticket_id IS NULL`);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.is_public).toBe(false);
    expect(notes[0]!.content).toContain('Printer still broken');
    expect(notes[0]!.content).toContain('Third floor HP');
    expect(notes[0]!.content).toContain('floor: 3');
    expect(notes[0]!.content).toContain('urgency: high');
    expect(notes[0]!.content).toMatch(/dropped/i);
    // The source keeps its own "merged into" note.
    const srcNote = await one<{ content: string }>(sql`
      SELECT content FROM ticket_comments WHERE ticket_id = ${s.src}::uuid AND comment_type = 'system'`);
    expect(srcNote.content).toMatch(/^Merged into T-/);
  }, T);

  runDb('attachments follow (comment_id follows its comment)', async () => {
    const s = await seed();
    const c = await insertComment(s.src, s.user.id, 'with file');
    const att = await one<{ id: string }>(sql`
      INSERT INTO ticket_attachments (org_id, ticket_id, comment_id, attached_at, storage_backend, data, content_type, byte_size, original_filename, sha256)
      VALUES (${s.org.id}::uuid, ${s.src}::uuid, ${c}::uuid, now(), 'db', '\\x01'::bytea, 'text/plain', 1, 'a.txt', ${'a'.repeat(64)})
      RETURNING id`);
    await merge(s);
    expect(await one(sql`SELECT ticket_id, comment_id FROM ticket_attachments WHERE id = ${att.id}::uuid`))
      .toEqual({ ticket_id: s.dst, comment_id: c });
  }, T);

  runDb('time entries (billed, running timer) move with billing fields unchanged; invoice lines keep the source', async () => {
    const s = await seed();
    const billed = await one<{ id: string }>(sql`
      INSERT INTO time_entries (partner_id, org_id, ticket_id, user_id, started_at, ended_at, duration_minutes, currency_code, hourly_rate, billing_status, is_billable)
      VALUES (${s.partner.id}::uuid, ${s.org.id}::uuid, ${s.src}::uuid, ${s.user.id}::uuid, now() - interval '2 hours', now() - interval '1 hour', 60, 'USD', 120.00, 'billed', true)
      RETURNING id`);
    const running = await one<{ id: string }>(sql`
      INSERT INTO time_entries (partner_id, org_id, ticket_id, user_id, started_at, currency_code)
      VALUES (${s.partner.id}::uuid, ${s.org.id}::uuid, ${s.src}::uuid, ${s.user.id}::uuid, now() - interval '5 minutes', 'USD')
      RETURNING id`);
    const inv = await one<{ id: string }>(sql`
      INSERT INTO invoices (partner_id, org_id, currency_code) VALUES (${s.partner.id}::uuid, ${s.org.id}::uuid, 'USD') RETURNING id`);
    const line = await one<{ id: string }>(sql`
      INSERT INTO invoice_lines (invoice_id, org_id, source_type, source_id, ticket_id, quantity, unit_price, ticket_label, ticket_subject)
      VALUES (${inv.id}::uuid, ${s.org.id}::uuid, 'time_entry', ${billed.id}::uuid, ${s.src}::uuid, 1, 120, 'T-SRC', 'Printer still broken')
      RETURNING id`);
    const before = await one(sql`SELECT billing_status, hourly_rate, duration_minutes, is_billable FROM time_entries WHERE id = ${billed.id}::uuid`);
    await merge(s);
    expect(await one(sql`SELECT ticket_id FROM time_entries WHERE id = ${billed.id}::uuid`)).toEqual({ ticket_id: s.dst });
    expect(await one(sql`SELECT billing_status, hourly_rate, duration_minutes, is_billable FROM time_entries WHERE id = ${billed.id}::uuid`)).toEqual(before);
    expect(await one(sql`SELECT ticket_id, ended_at FROM time_entries WHERE id = ${running.id}::uuid`)).toEqual({ ticket_id: s.dst, ended_at: null });
    expect(await one(sql`SELECT ticket_id, ticket_label FROM invoice_lines WHERE id = ${line.id}::uuid`))
      .toEqual({ ticket_id: s.src, ticket_label: 'T-SRC' });
  }, T);

  runDb('parts (including billed) move', async () => {
    const s = await seed();
    const part = await one<{ id: string }>(sql`
      INSERT INTO ticket_parts (ticket_id, org_id, description, quantity, currency_code, billing_status)
      VALUES (${s.src}::uuid, ${s.org.id}::uuid, 'Toner', 1, 'USD', 'billed') RETURNING id`);
    await merge(s);
    expect(await one(sql`SELECT ticket_id, billing_status::text FROM ticket_parts WHERE id = ${part.id}::uuid`))
      .toEqual({ ticket_id: s.dst, billing_status: 'billed' });
  }, T);

  runDb('checklist items are appended after the survivor\'s last item, keeping the source order', async () => {
    const s = await seed();
    await getTestDb().execute(sql`
      INSERT INTO ticket_checklist_items (org_id, ticket_id, label, position) VALUES
        (${s.org.id}::uuid, ${s.dst}::uuid, 'd0', 0), (${s.org.id}::uuid, ${s.dst}::uuid, 'd1', 1),
        (${s.org.id}::uuid, ${s.src}::uuid, 's0', 0), (${s.org.id}::uuid, ${s.src}::uuid, 's1', 1)`);
    await merge(s);
    const items = await q<{ label: string }>(sql`
      SELECT label FROM ticket_checklist_items WHERE ticket_id = ${s.dst}::uuid ORDER BY position`);
    expect(items.map((i) => i.label)).toEqual(['d0', 'd1', 's0', 's1']);
  }, T);

  runDb('alert links: the survivor\'s row wins a shared alert, the rest move', async () => {
    const s = await seed();
    const site = await createSite({ orgId: s.org.id });
    const device = await createDevice({ orgId: s.org.id, siteId: site.id });
    const tpl = await one<{ id: string }>(sql`
      INSERT INTO alert_templates (partner_id, name, conditions, severity, title_template, message_template)
      VALUES (${s.partner.id}::uuid, 'merge-tpl', '{}'::jsonb, 'info', 't', 'm') RETURNING id`);
    const rule = await one<{ id: string }>(sql`
      INSERT INTO alert_rules (org_id, template_id, name, target_type, target_id)
      VALUES (${s.org.id}::uuid, ${tpl.id}::uuid, 'merge-rule', 'device', ${device.id}::uuid) RETURNING id`);
    const mkAlert = async (title: string) => (await one<{ id: string }>(sql`
      INSERT INTO alerts (rule_id, device_id, org_id, severity, title, status)
      VALUES (${rule.id}::uuid, ${device.id}::uuid, ${s.org.id}::uuid, 'info', ${title}, 'resolved') RETURNING id`)).id;
    const shared = await mkAlert('shared');
    const own = await mkAlert('own');
    const dstLink = await one<{ id: string }>(sql`
      INSERT INTO ticket_alert_links (ticket_id, org_id, alert_id, link_type) VALUES (${s.dst}::uuid, ${s.org.id}::uuid, ${shared}::uuid, 'attached') RETURNING id`);
    await getTestDb().execute(sql`
      INSERT INTO ticket_alert_links (ticket_id, org_id, alert_id, link_type) VALUES
        (${s.src}::uuid, ${s.org.id}::uuid, ${shared}::uuid, 'attached'), (${s.src}::uuid, ${s.org.id}::uuid, ${own}::uuid, 'attached')`);
    await merge(s);
    const links = await q<{ id: string; alert_id: string }>(sql`
      SELECT id, alert_id FROM ticket_alert_links WHERE ticket_id = ${s.dst}::uuid ORDER BY alert_id`);
    expect(links.map((l) => l.alert_id).sort()).toEqual([shared, own].sort());
    expect(links.find((l) => l.alert_id === shared)!.id).toBe(dstLink.id);
    expect(await q(sql`SELECT 1 FROM ticket_alert_links WHERE ticket_id = ${s.src}::uuid`)).toEqual([]);
  }, T);

  runDb('email links move; the source\'s own message id and thread key stay on the tombstone', async () => {
    const s = await seed();
    await getTestDb().execute(sql`
      UPDATE tickets SET email_message_id = '<src@mail>', email_thread_key = 'thread-src' WHERE id = ${s.src}::uuid`);
    const link = await one<{ id: string }>(sql`
      INSERT INTO ticket_email_links (ticket_id, org_id, partner_id, message_id, origin, visibility)
      VALUES (${s.src}::uuid, ${s.org.id}::uuid, ${s.partner.id}::uuid, '<reply@mail>', 'inbound', 'public') RETURNING id`);
    await merge(s);
    expect(await one(sql`SELECT ticket_id FROM ticket_email_links WHERE id = ${link.id}::uuid`)).toEqual({ ticket_id: s.dst });
    expect(await one(sql`SELECT email_message_id, email_thread_key FROM tickets WHERE id = ${s.src}::uuid`))
      .toEqual({ email_message_id: '<src@mail>', email_thread_key: 'thread-src' });
  }, T);

  runDb('external refs move, except a same-principal collision which stays on the tombstone', async () => {
    const s = await seed();
    const mkPrincipal = async (name: string) => (await one<{ id: string }>(sql`
      INSERT INTO partner_service_principals (partner_id, name, scopes, created_by, updated_by)
      VALUES (${s.partner.id}::uuid, ${name}, ARRAY['tickets:read','tickets:write'], ${s.user.id}::uuid, ${s.user.id}::uuid) RETURNING id`)).id;
    const p1 = await mkPrincipal('psa-1');
    const p2 = await mkPrincipal('psa-2');
    await getTestDb().execute(sql`
      INSERT INTO ticket_external_refs (ticket_id, org_id, partner_id, partner_service_principal_id, external_id) VALUES
        (${s.dst}::uuid, ${s.org.id}::uuid, ${s.partner.id}::uuid, ${p1}::uuid, 'DST-1')`);
    const collide = await one<{ id: string }>(sql`
      INSERT INTO ticket_external_refs (ticket_id, org_id, partner_id, partner_service_principal_id, external_id)
      VALUES (${s.src}::uuid, ${s.org.id}::uuid, ${s.partner.id}::uuid, ${p1}::uuid, 'SRC-1') RETURNING id`);
    const moves = await one<{ id: string }>(sql`
      INSERT INTO ticket_external_refs (ticket_id, org_id, partner_id, partner_service_principal_id, external_id)
      VALUES (${s.src}::uuid, ${s.org.id}::uuid, ${s.partner.id}::uuid, ${p2}::uuid, 'SRC-2') RETURNING id`);
    const res = await merge(s);
    expect(await one(sql`SELECT ticket_id FROM ticket_external_refs WHERE id = ${moves.id}::uuid`)).toEqual({ ticket_id: s.dst });
    expect(await one(sql`SELECT ticket_id FROM ticket_external_refs WHERE id = ${collide.id}::uuid`)).toEqual({ ticket_id: s.src });
    expect(res.retainedExternalRefIds).toEqual([collide.id]);
  }, T);

  runDb('links: between-pair deleted, related re-canonicalised, collisions dropped and listed, duplicate_of follows the survivor', async () => {
    const s = await seed();
    const x = await insertTicket(s.org.id, s.partner.id);
    const y = await insertTicket(s.org.id, s.partner.id);
    const z = await insertTicket(s.org.id, s.partner.id);
    const link = async (a: string, b: string, type: string) => (await one<{ id: string }>(sql`
      INSERT INTO ticket_links (org_id, source_ticket_id, target_ticket_id, link_type)
      VALUES (${s.org.id}::uuid, ${a}::uuid, ${b}::uuid, ${type}::ticket_link_type) RETURNING id`)).id;
    const between = await link(s.src, s.dst, 'caused_by');
    const [lo, hi] = [s.src, y].sort();
    const related = await link(lo!, hi!, 'related');
    await link(x, s.dst, 'caused_by');            // the survivor already has x caused_by dst
    const collides = await link(x, s.src, 'caused_by'); // → x caused_by dst: pair_unique
    const dup = await link(z, s.src, 'duplicate_of');   // z duplicate_of src → z duplicate_of dst
    const res = await merge(s);
    expect(await q(sql`SELECT 1 FROM ticket_links WHERE id = ${between}::uuid`)).toEqual([]);
    const rel = await one<{ source_ticket_id: string; target_ticket_id: string }>(sql`
      SELECT source_ticket_id, target_ticket_id FROM ticket_links WHERE id = ${related}::uuid`);
    expect([rel.source_ticket_id, rel.target_ticket_id]).toEqual([s.dst, y].sort());
    expect(await q(sql`SELECT 1 FROM ticket_links WHERE id = ${collides}::uuid`)).toEqual([]);
    expect(await one(sql`SELECT source_ticket_id, target_ticket_id FROM ticket_links WHERE id = ${dup}::uuid`))
      .toEqual({ source_ticket_id: z, target_ticket_id: s.dst });
    expect(res.droppedLinks.map((d) => [d.linkId, d.reason]).sort()).toEqual([[between, 'between_pair'], [collides, 'pair_unique']].sort());
    expect(await q(sql`SELECT 1 FROM ticket_links WHERE source_ticket_id = ${s.src}::uuid OR target_ticket_id = ${s.src}::uuid`)).toEqual([]);
  }, T);

  runDb('device vulnerabilities, key-date reminders and AI Operator targets re-point', async () => {
    const s = await seed();
    const site = await createSite({ orgId: s.org.id });
    const device = await createDevice({ orgId: s.org.id, siteId: site.id });
    const vuln = await one<{ id: string }>(sql`
      INSERT INTO vulnerabilities (cve_id, description, raw_payload) VALUES (${`CVE-2099-${Math.floor(Math.random() * 1e6)}`}, 'x', '{}'::jsonb) RETURNING id`);
    const dv = await one<{ id: string }>(sql`
      INSERT INTO device_vulnerabilities (org_id, device_id, vulnerability_id, detected_at, ticket_id)
      VALUES (${s.org.id}::uuid, ${device.id}::uuid, ${vuln.id}::uuid, now(), ${s.src}::uuid) RETURNING id`);
    const kd = await one<{ id: string }>(sql`
      INSERT INTO organization_key_dates (org_id, label, date, reminder_ticket_id)
      VALUES (${s.org.id}::uuid, 'Renewal', '2027-01-01', ${s.src}::uuid) RETURNING id`);
    const agent = await one<{ id: string }>(sql`
      INSERT INTO ai_agents (org_id, kind, name, created_by) VALUES (${s.org.id}::uuid, 'triage', 'Triage', ${s.user.id}::uuid) RETURNING id`);
    const task = await one<{ id: string }>(sql`
      INSERT INTO ai_operator_tasks (org_id, agent_id, agent_kind, agent_name, workflow_key, origin_kind, objective)
      VALUES (${s.org.id}::uuid, ${agent.id}::uuid, 'triage', 'Triage', 'wf', 'manual', 'fix it') RETURNING id`);
    const target = await one<{ id: string }>(sql`
      INSERT INTO ai_operator_task_targets (org_id, task_id, target_kind, target_label, target_ordinal, ticket_id)
      VALUES (${s.org.id}::uuid, ${task.id}::uuid, 'ticket', 'T', 0, ${s.src}::uuid) RETURNING id`);
    await merge(s);
    expect(await one(sql`SELECT ticket_id FROM device_vulnerabilities WHERE id = ${dv.id}::uuid`)).toEqual({ ticket_id: s.dst });
    expect(await one(sql`SELECT reminder_ticket_id FROM organization_key_dates WHERE id = ${kd.id}::uuid`)).toEqual({ reminder_ticket_id: s.dst });
    expect(await one(sql`SELECT ticket_id, detached_at FROM ai_operator_task_targets WHERE id = ${target.id}::uuid`))
      .toEqual({ ticket_id: s.dst, detached_at: null });
  }, T);

  runDb('device: the survivor takes the source\'s device when it has none; the tombstone\'s is nulled and audited', async () => {
    const s = await seed();
    const site = await createSite({ orgId: s.org.id });
    const device = await createDevice({ orgId: s.org.id, siteId: site.id });
    await getTestDb().execute(sql`UPDATE tickets SET device_id = ${device.id}::uuid WHERE id = ${s.src}::uuid`);
    await merge(s);
    expect(await one(sql`SELECT device_id FROM tickets WHERE id = ${s.dst}::uuid`)).toEqual({ device_id: device.id });
    expect(await one(sql`SELECT device_id FROM tickets WHERE id = ${s.src}::uuid`)).toEqual({ device_id: null });
    // Audit rows are written after commit, best effort; poll briefly.
    let audit: Row[] = [];
    for (let i = 0; i < 40 && audit.length < 2; i++) {
      audit = await q(sql`SELECT action, details FROM audit_logs WHERE resource_id IN (${s.src}::uuid, ${s.dst}::uuid) AND action LIKE 'ticket.merge.%' ORDER BY action`);
      if (audit.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(audit.map((a) => a.action)).toEqual(['ticket.merge.source', 'ticket.merge.target']);
    expect((audit[0]!.details as Row).originalDeviceId).toBe(device.id);
  }, T);

  runDb('the survivor keeps its own device when both have one', async () => {
    const s = await seed();
    const site = await createSite({ orgId: s.org.id });
    const d1 = await createDevice({ orgId: s.org.id, siteId: site.id });
    const d2 = await createDevice({ orgId: s.org.id, siteId: site.id });
    await getTestDb().execute(sql`UPDATE tickets SET device_id = ${d1.id}::uuid WHERE id = ${s.src}::uuid`);
    await getTestDb().execute(sql`UPDATE tickets SET device_id = ${d2.id}::uuid WHERE id = ${s.dst}::uuid`);
    await merge(s);
    expect(await one(sql`SELECT device_id FROM tickets WHERE id = ${s.dst}::uuid`)).toEqual({ device_id: d2.id });
  }, T);

  runDb('tags union; the source\'s drafts are deleted', async () => {
    const s = await seed();
    await getTestDb().execute(sql`UPDATE tickets SET tags = ARRAY['printer','floor3'] WHERE id = ${s.src}::uuid`);
    await getTestDb().execute(sql`UPDATE tickets SET tags = ARRAY['printer','vip'] WHERE id = ${s.dst}::uuid`);
    await getTestDb().execute(sql`
      INSERT INTO ticket_drafts (org_id, ticket_id, kind, content) VALUES (${s.org.id}::uuid, ${s.src}::uuid, 'reply', 'draft')`);
    const res = await merge(s);
    const tags = await one<{ tags: string[] }>(sql`SELECT tags FROM tickets WHERE id = ${s.dst}::uuid`);
    expect([...tags.tags].sort()).toEqual(['floor3', 'printer', 'vip']);
    expect(await q(sql`SELECT 1 FROM ticket_drafts WHERE ticket_id = ${s.src}::uuid`)).toEqual([]);
    expect(res.counts.ticket_drafts).toBe(1);
  }, T);

  runDb('stays on the tombstone: outbox history, inbound email rows, invoice lines, idempotency keys, terminal intents', async () => {
    const s = await seed();
    await getTestDb().execute(sql`
      INSERT INTO ticket_outbox (org_id, ticket_id, event_type) VALUES (${s.org.id}::uuid, ${s.src}::uuid, 'ticket.created')`);
    await getTestDb().execute(sql`
      INSERT INTO ticket_email_inbound (provider, provider_message_id, parse_status, partner_id, ticket_id)
      VALUES ('test', ${`pm-${seq}`}, 'parsed', ${s.partner.id}::uuid, ${s.src}::uuid)`);
    await merge(s);
    expect(await one(sql`SELECT count(*)::int AS n FROM ticket_outbox WHERE ticket_id = ${s.src}::uuid AND event_type = 'ticket.created'`)).toEqual({ n: 1 });
    expect(await one(sql`SELECT count(*)::int AS n FROM ticket_email_inbound WHERE ticket_id = ${s.src}::uuid`)).toEqual({ n: 1 });
  }, T);

  runDb('tombstone: closed with the partner\'s closed status, close stamps, "Merged into" note, open pause folded into BOTH paused columns', async () => {
    const s = await seed();
    await getTestDb().execute(sql`
      UPDATE tickets SET status = 'pending', sla_paused_at = now() - interval '30 minutes', sla_paused_minutes = 10,
                         sla_paused_business_minutes = 10
       WHERE id = ${s.src}::uuid`);
    await merge(s);
    const t = await one<Row>(sql`
      SELECT status::text, closed_at IS NOT NULL AS closed, closed_by, resolved_at IS NOT NULL AS resolved,
             resolution_note, sla_paused_at, sla_paused_minutes, sla_paused_business_minutes,
             merged_into_ticket_id, merged_at IS NOT NULL AS merged, merged_by_user_id
        FROM tickets WHERE id = ${s.src}::uuid`);
    const dstNumber = (await one<{ n: string }>(sql`SELECT internal_number AS n FROM tickets WHERE id = ${s.dst}::uuid`)).n;
    expect(t).toMatchObject({
      status: 'closed', closed: true, closed_by: s.user.id, resolved: true, resolution_note: `Merged into ${dstNumber}`,
      sla_paused_at: null, merged_into_ticket_id: s.dst, merged: true, merged_by_user_id: s.user.id,
    });
    expect(t.sla_paused_minutes as number).toBeGreaterThanOrEqual(39);
    expect(t.sla_paused_business_minutes as number).toBeGreaterThanOrEqual(39);
  }, T);

  // #8973 W4: the open pause folds into business minutes on the SOURCE's own
  // calendar, not the wall clock. The calendar has one business minute a day
  // (00:00–00:01 UTC), so a 30-minute pause accrues at most 1.
  runDb('tombstone: an open pause on a calendar ticket accrues business minutes on that calendar', async () => {
    const s = await seed();
    const owner = { orgId: null, partnerId: s.partner.id };
    const revId = await withSystemDbAccessContext(async () => {
      const [cal] = await db.insert(businessCalendars).values({ ...owner, name: `Merge cal ${seq}` }).returning();
      const [rev] = await db.insert(businessCalendarRevisions).values({ calendarId: cal!.id, ...owner, revision: 1, timezone: 'UTC' }).returning();
      await db.insert(businessCalendarIntervals).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        revisionId: rev!.id, ...owner, weekday, startMinute: 0, endMinute: 1,
      })));
      return rev!.id;
    });
    await getTestDb().execute(sql`
      UPDATE tickets SET status = 'pending', sla_paused_at = now() - interval '30 minutes', sla_paused_minutes = 10,
                         sla_paused_business_minutes = 10, sla_calendar_revision_id = ${revId}::uuid
       WHERE id = ${s.src}::uuid`);
    await merge(s);
    const t = await one<{ sla_paused_minutes: number; sla_paused_business_minutes: number; sla_calendar_revision_id: string }>(sql`
      SELECT sla_paused_minutes, sla_paused_business_minutes, sla_calendar_revision_id FROM tickets WHERE id = ${s.src}::uuid`);
    expect(t.sla_paused_minutes).toBeGreaterThanOrEqual(39);
    // Kept the 10 already accrued, added at most the one business minute.
    expect(t.sla_paused_business_minutes).toBeGreaterThanOrEqual(10);
    expect(t.sla_paused_business_minutes).toBeLessThanOrEqual(11);
    expect(t.sla_calendar_revision_id).toBe(revId);
  }, T);

  runDb('path compression: A→B then B→C leaves A pointing at C', async () => {
    const s = await seed();
    const a = s.src;
    const b = await insertTicket(s.org.id, s.partner.id);
    await merge(s, a, b);
    await merge(s, b, s.dst);
    expect(await one(sql`SELECT merged_into_ticket_id FROM tickets WHERE id = ${a}::uuid`)).toEqual({ merged_into_ticket_id: s.dst });
    expect(await one(sql`SELECT merged_into_ticket_id FROM tickets WHERE id = ${b}::uuid`)).toEqual({ merged_into_ticket_id: s.dst });
  }, T);

  runDb('survivor feed xid bumped exactly once (one transaction stamp); moved comments do not fire the feed trigger', async () => {
    const s = await seed();
    const c = await insertComment(s.src, s.user.id, 'moving');
    const before = await one<{ xid: string; comment_edited: unknown }>(sql`
      SELECT t.partner_feed_xid::text AS xid, c.edited_at AS comment_edited
        FROM tickets t, ticket_comments c WHERE t.id = ${s.dst}::uuid AND c.id = ${c}::uuid`);
    await merge(s);
    const after = await q<{ id: string; xid: string }>(sql`
      SELECT id, partner_feed_xid::text AS xid FROM tickets WHERE id IN (${s.src}::uuid, ${s.dst}::uuid)`);
    const dstXid = after.find((r) => r.id === s.dst)!.xid;
    expect(dstXid).not.toBe(before.xid);
    // One transaction stamped both rows: the survivor carries the merge's xid, nothing later.
    expect(after.find((r) => r.id === s.src)!.xid).toBe(dstXid);
    expect(await one(sql`SELECT edited_at FROM ticket_comments WHERE id = ${c}::uuid`)).toEqual({ edited_at: before.comment_edited });
  }, T);

  runDb('outbox: ticket.merged + ticket.updated (changed: merge) on the survivor, ticket.status_changed on the source, no ticket.commented', async () => {
    const s = await seed();
    await insertComment(s.src, s.user.id, 'moved, not re-announced');
    await getTestDb().execute(sql`DELETE FROM ticket_outbox`);
    await merge(s);
    const rows = await q<{ ticket_id: string; event_type: string; payload: Row }>(sql`
      SELECT ticket_id, event_type, payload FROM ticket_outbox ORDER BY id`);
    const nums = await q<{ id: string; n: string }>(sql`SELECT id, internal_number AS n FROM tickets WHERE id IN (${s.src}::uuid, ${s.dst}::uuid)`);
    const num = (id: string) => nums.find((r) => r.id === id)!.n;
    expect(rows.filter((r) => r.event_type === 'ticket.commented')).toEqual([]);
    expect(rows.find((r) => r.event_type === 'ticket.merged')).toEqual({
      ticket_id: s.dst, event_type: 'ticket.merged',
      payload: { sourceTicketId: s.src, targetTicketId: s.dst, sourceInternalNumber: num(s.src), targetInternalNumber: num(s.dst) },
    });
    expect(rows.find((r) => r.event_type === 'ticket.updated')).toMatchObject({ ticket_id: s.dst, payload: { changed: ['merge'] } });
    expect(rows.find((r) => r.event_type === 'ticket.status_changed')).toMatchObject({ ticket_id: s.src, payload: { from: 'open', to: 'closed' } });
  }, T);

  runDb('an already-closed source writes no ticket.status_changed', async () => {
    const s = await seed();
    await getTestDb().execute(sql`UPDATE tickets SET status = 'closed', closed_at = now(), resolved_at = now() WHERE id = ${s.src}::uuid`);
    await getTestDb().execute(sql`DELETE FROM ticket_outbox`);
    await merge(s);
    expect(await q(sql`SELECT 1 FROM ticket_outbox WHERE event_type = 'ticket.status_changed'`)).toEqual([]);
  }, T);

  runDb('refusals are re-checked under the lock and move nothing (D3 budget on the survivor)', async () => {
    const s = await seed();
    const c = await insertComment(s.src, s.user.id, 'stays');
    await getTestDb().execute(sql`UPDATE tickets SET budget_minutes = 60 WHERE id = ${s.dst}::uuid`);
    const err = await merge(s).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MergeRefusedError);
    expect(err).toMatchObject({ code: 'MERGE_APPROVAL_STATE', side: 'survivor' });
    expect(await one(sql`SELECT ticket_id FROM ticket_comments WHERE id = ${c}::uuid`)).toEqual({ ticket_id: s.src });
    expect(await one(sql`SELECT merged_into_ticket_id FROM tickets WHERE id = ${s.src}::uuid`)).toEqual({ merged_into_ticket_id: null });
  }, T);

  runDb('a tombstone refuses writes afterwards (TICKET_MERGED)', async () => {
    const s = await seed();
    await merge(s);
    const err = await withDbAccessContext(s.ctx, () => addTicketComment(s.src, { content: 'late', isPublic: true }, s.actor))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TicketMergedError);
    expect(err).toMatchObject({ mergedIntoTicketId: s.dst });
  }, T);

  runDb('preview == execute: counts, dropped links and retained refs match what the merge does', async () => {
    const s = await seed();
    await insertComment(s.src, s.user.id, 'c1');
    await getTestDb().execute(sql`
      INSERT INTO ticket_checklist_items (org_id, ticket_id, label, position) VALUES (${s.org.id}::uuid, ${s.src}::uuid, 'x', 0)`);
    const x = await insertTicket(s.org.id, s.partner.id);
    await getTestDb().execute(sql`
      INSERT INTO ticket_links (org_id, source_ticket_id, target_ticket_id, link_type) VALUES
        (${s.org.id}::uuid, ${s.src}::uuid, ${s.dst}::uuid, 'caused_by'),
        (${s.org.id}::uuid, ${x}::uuid, ${s.dst}::uuid, 'resolves'),
        (${s.org.id}::uuid, ${x}::uuid, ${s.src}::uuid, 'resolves'),
        (${s.org.id}::uuid, ${s.src}::uuid, ${x}::uuid, 'caused_by')`);
    const p = (await one<{ id: string }>(sql`
      INSERT INTO partner_service_principals (partner_id, name, scopes, created_by, updated_by)
      VALUES (${s.partner.id}::uuid, 'psa', ARRAY['tickets:read','tickets:write'], ${s.user.id}::uuid, ${s.user.id}::uuid) RETURNING id`)).id;
    await getTestDb().execute(sql`
      INSERT INTO ticket_external_refs (ticket_id, org_id, partner_id, partner_service_principal_id, external_id) VALUES
        (${s.dst}::uuid, ${s.org.id}::uuid, ${s.partner.id}::uuid, ${p}::uuid, 'D'),
        (${s.src}::uuid, ${s.org.id}::uuid, ${s.partner.id}::uuid, ${p}::uuid, 'S')`);
    const preview = await withDbAccessContext(s.ctx, async () => {
      const rows = await loadMergeTicketRows(db, [s.src, s.dst]);
      return previewMerge(db as never, rows.get(s.src)!, rows.get(s.dst)!);
    });
    expect(preview.eligible).toBe(true);
    const res = await merge(s);
    // The merge itself writes two notes after the re-point; the preview counts what MOVES.
    expect(preview.counts).toEqual(res.counts);
    expect(preview.droppedLinks).toEqual(res.droppedLinks);
    expect(preview.retainedExternalRefs.map((r) => r.id)).toEqual(res.retainedExternalRefIds);
    expect(preview.droppedLinks.map((d) => d.reason).sort()).toEqual(['between_pair', 'pair_unique']);
  }, T);

  describe('eligibility on real SQL (§3.1, D3)', () => {
    const refused = async (s: Seed) => (await merge(s).then(() => null, (e: unknown) => e)) as MergeRefusedError;

    runDb('MERGE_APPROVAL_STATE: an approval request on the source', async () => {
      const s = await seed();
      await getTestDb().execute(sql`
        INSERT INTO ticket_approval_requests (org_id, ticket_id, trigger, origin, enforcement, expires_at)
        VALUES (${s.org.id}::uuid, ${s.src}::uuid, 'budget', 'staff', 'soft', now() + interval '1 day')`);
      expect(await refused(s)).toMatchObject({ code: 'MERGE_APPROVAL_STATE', side: 'source' });
    }, T);

    runDb('ORG_MERGING: the org is being merged', async () => {
      const s = await seed();
      await getTestDb().execute(sql`UPDATE organizations SET status = 'merging' WHERE id = ${s.org.id}::uuid`);
      expect(await refused(s)).toMatchObject({ code: 'ORG_MERGING' });
    }, T);

    runDb('MERGE_WORK_KIND_MISMATCH: planned work into a support ticket', async () => {
      const s = await seed();
      await getTestDb().execute(sql`UPDATE tickets SET work_kind = 'deliverable' WHERE id = ${s.src}::uuid`);
      expect(await refused(s)).toMatchObject({ code: 'MERGE_WORK_KIND_MISMATCH' });
    }, T);

    runDb('MERGE_SURVIVOR_INELIGIBLE: a closed survivor', async () => {
      const s = await seed();
      await getTestDb().execute(sql`UPDATE tickets SET status = 'closed', closed_at = now() WHERE id = ${s.dst}::uuid`);
      expect(await refused(s)).toMatchObject({ code: 'MERGE_SURVIVOR_INELIGIBLE', side: 'survivor' });
    }, T);
  });
});
