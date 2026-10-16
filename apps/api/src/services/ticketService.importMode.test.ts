/**
 * #8313 import mode, function by function (spec
 * docs/superpowers/specs/api-platform/2026-10-10-ticket-migration-windows-design.md
 * §4.1–§4.3, §6 "1b" unit tests). Live behaviour stays covered by the
 * existing ticketService suites; this file pins what import mode changes:
 * historic times, null SLA with human-authoritative provenance, the UTC
 * numbering year, the relaxed assignee check with the partner and org
 * boundary kept, resolve without a note, resolved-then-closed, staff-only
 * first response, no restamp on a later edit, and no side effect at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
}));

const mocks = vi.hoisted(() => ({
  emit: vi.fn().mockResolvedValue(undefined),
  audit: vi.fn().mockResolvedValue(undefined),
  triage: vi.fn().mockResolvedValue(undefined),
  allocate: vi.fn().mockResolvedValue('T-2021-0001'),
  eligible: vi.fn().mockResolvedValue(true),
  orgSla: vi.fn().mockResolvedValue({ responseMinutes: 60, resolutionMinutes: 480 }),
  partnerSla: vi.fn().mockResolvedValue({ responseMinutes: null, resolutionMinutes: null }),
  statusId: vi.fn().mockResolvedValue(null),
}));

vi.mock('../db', () => {
  const thenable = <T>(value: T, extra: Record<string, unknown> = {}) => Object.assign(Promise.resolve(value), extra);
  const db: Record<string, unknown> = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            const rows = state.selectQueue.shift() ?? [];
            return thenable(rows, { for: vi.fn(() => Promise.resolve(rows)) });
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        state.inserts.push({ table, values });
        return thenable(undefined, { returning: vi.fn(async () => [{ id: 'row-1', originPrincipalKind: values.originPrincipalKind, originPrincipalId: values.originPrincipalId, ...values }]) });
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((set: Record<string, unknown>) => {
        state.updates.push({ table, set });
        return { where: vi.fn(() => thenable(undefined, { returning: vi.fn(async () => [{ id: 'ticket-1', ...set }]) })) };
      }),
    })),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return { db, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./ticketEvents', () => ({ emitTicketEvent: mocks.emit }));
vi.mock('./auditService', () => ({ createAuditLogAsync: mocks.audit }));
vi.mock('./mlFeedbackEmitters', () => ({ emitTicketTriageFeedback: mocks.triage }));
vi.mock('./ticketNumbers', () => ({ allocateInternalTicketNumber: mocks.allocate }));
vi.mock('./ticketPush', async (orig) => ({ ...(await orig<typeof import('./ticketPush')>()), isEligibleTicketRecipient: mocks.eligible }));
vi.mock('./ticketConfigService', () => ({
  getOrgSlaOverride: mocks.orgSla,
  getPartnerPrioritySla: mocks.partnerSla,
  getSystemStatusId: mocks.statusId,
  getTicketStatusById: vi.fn().mockResolvedValue(null),
}));
vi.mock('./serviceManagement', async (orig) => ({
  ...(await orig<typeof import('./serviceManagement')>()),
  assertTicketCreationAllowed: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./aiOperator/humanWorkService', () => ({ detachHumanWorkLinksForTicket: vi.fn(async () => 0) }));

import { ticketComments, ticketOutbox, tickets } from '../db/schema';
import {
  addTicketComment,
  assignTicket,
  changeTicketStatus,
  createTicket,
  ticketSideEffects,
  updateTicketFields,
  type TicketActor,
} from './ticketService';
import { createAuditLogAsync } from './auditService';
import type { OpenWindow, TicketWriteMode } from './ticketWriteMode';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const WINDOW = '55555555-5555-4555-8555-555555555555';
const AGENT = '66666666-6666-4666-8666-666666666666';
const TICKET = '77777777-7777-4777-8777-777777777777';

const window = { id: WINDOW, partnerId: PARTNER, principalId: PRINCIPAL, principalName: 'Zammad import', orgIds: new Set([ORG]) } as unknown as OpenWindow;
const actor: TicketActor = { kind: 'service_principal', principalId: PRINCIPAL, keyId: null, name: 'Zammad import' };
const CREATED = new Date('2021-03-04T05:06:07.000Z');
const LATER = new Date('2021-03-09T10:00:00.000Z');
const at = (time: Date): TicketWriteMode => ({ kind: 'import', window, at: time });

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

function storedTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: TICKET, orgId: ORG, partnerId: PARTNER, status: 'new', statusId: null, priority: 'normal', categoryId: null,
    assignedTo: null, deviceId: null, firstResponseAt: null, resolvedAt: null, closedAt: null, slaPausedAt: null,
    slaPausedMinutes: 0, createdAt: CREATED, updatedAt: CREATED, workKind: 'support', ticketType: 'incident',
    subject: 'Printer', description: null, tags: [], fieldProvenance: {}, responseSlaMinutes: null, resolutionSlaMinutes: null,
    submittedBy: null, submitterName: null, submitterEmail: null, requesterContactId: null,
    ...overrides,
  };
}

function inserted(table: unknown) {
  return state.inserts.filter((i) => i.table === table).map((i) => i.values);
}

function expectNoSideEffects() {
  expect(inserted(ticketOutbox)).toEqual([]);
  expect(mocks.emit).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(mocks.triage).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  state.selectQueue.length = 0;
  state.inserts.length = 0;
  state.updates.length = 0;
});

describe('ticketSideEffects', () => {
  it('is the real set live and four no-ops in import mode', async () => {
    expect(ticketSideEffects({ kind: 'live' }).createAuditLogAsync).toBe(createAuditLogAsync);
    const fx = ticketSideEffects(at(LATER));
    await fx.createAuditLogAsync({} as never);
    await fx.emitTicketEvent({} as never);
    await fx.writeTicketOutbox('o', 't', 'ticket.created');
    await fx.emitTicketTriageFeedback({} as never);
    expect(state.inserts).toEqual([]);
    expectNoSideEffects();
  });
});

describe('createTicket in import mode', () => {
  it('keeps the source time, stamps the window, leaves SLA targets null with service_principal provenance, and numbers by the UTC year', async () => {
    state.selectQueue.push([{ id: ORG, partnerId: PARTNER }]);
    // 2021-12-31T23:30Z is still 2021 in UTC whatever the server zone is.
    const newYearsEve = new Date('2021-12-31T23:30:00.000Z');
    const ticket = await createTicket(
      { orgId: ORG, subject: '  Printer jam  ', description: 'It jams', source: 'email', submitterName: 'Maya', submitterEmail: 'maya@customer.example', tags: ['legacy'] },
      actor,
      at(newYearsEve),
    );
    expect(mocks.allocate).toHaveBeenCalledWith(PARTNER, newYearsEve, { utcYear: true });
    expect(mocks.orgSla).not.toHaveBeenCalled();
    expect(mocks.partnerSla).not.toHaveBeenCalled();
    const [values] = inserted(tickets);
    expect(values).toMatchObject({
      subject: 'Printer jam',
      createdAt: newYearsEve,
      updatedAt: newYearsEve,
      migrationWindowId: WINDOW,
      responseSlaMinutes: null,
      resolutionSlaMinutes: null,
      fieldProvenance: { responseSlaMinutes: 'service_principal', resolutionSlaMinutes: 'service_principal' },
      tags: ['legacy'],
      source: 'email',
      submitterName: 'Maya',
      submitterEmail: 'maya@customer.example',
      requesterContactId: null,
      ticketType: 'incident',
    });
    expect(ticket.id).toBe('row-1');
    expectNoSideEffects();
  });

  it('a live create still resolves SLA targets, numbers by the local year and writes its outbox and audit rows', async () => {
    state.selectQueue.push([{ id: ORG, partnerId: PARTNER }]);
    await createTicket({ orgId: ORG, subject: 'Live', source: 'manual', tags: ['ignored'] }, { kind: 'user', userId: AGENT, name: 'Tess' });
    expect(mocks.allocate).toHaveBeenCalledWith(PARTNER);
    expect(mocks.orgSla).toHaveBeenCalled();
    const [values] = inserted(tickets);
    expect(values).toMatchObject({ responseSlaMinutes: 60, resolutionSlaMinutes: 480 });
    expect(values).not.toHaveProperty('migrationWindowId');
    expect(values!.tags).toBeUndefined();
    expect(inserted(ticketOutbox)).toHaveLength(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });

  it('refuses an org outside the window, a future time, and an actor that is not the window principal', async () => {
    state.selectQueue.push([{ id: OTHER_ORG, partnerId: PARTNER }]);
    await expect(createTicket({ orgId: OTHER_ORG, subject: 'x', source: 'manual' }, actor, at(LATER)))
      .rejects.toMatchObject({ status: 403, code: 'MIGRATION_WINDOW_ORG_NOT_ALLOWED' });
    state.selectQueue.push([{ id: ORG, partnerId: PARTNER }]);
    await expect(createTicket({ orgId: ORG, subject: 'x', source: 'manual' }, actor, at(new Date(Date.now() + 60_000))))
      .rejects.toMatchObject({ status: 400, code: 'IMPORT_TIME_INVALID' });
    state.selectQueue.push([{ id: ORG, partnerId: PARTNER }]);
    await expect(createTicket({ orgId: ORG, subject: 'x', source: 'manual' }, { ...actor, principalId: AGENT }, at(LATER)))
      .rejects.toThrow(/window principal/);
    expect(inserted(tickets)).toEqual([]);
  });

  it('accepts a deactivated agent as the historic assignee without the live eligibility check', async () => {
    state.selectQueue.push([{ id: ORG, partnerId: PARTNER }], [{ id: AGENT, partnerId: PARTNER, orgId: null, status: 'disabled' }]);
    await createTicket({ orgId: ORG, subject: 'x', source: 'manual', assigneeId: AGENT }, actor, at(LATER));
    expect(mocks.eligible).not.toHaveBeenCalled();
    expect(inserted(tickets)[0]).toMatchObject({ assignedTo: AGENT, status: 'open' });
  });
});

describe('assignTicket in import mode', () => {
  it('keeps the partner and org boundary: another partner, or another org, is ASSIGNEE_NOT_ELIGIBLE', async () => {
    state.selectQueue.push([storedTicket()], [{ id: AGENT, partnerId: '99999999-9999-4999-8999-999999999999', orgId: null, status: 'active' }]);
    await expect(assignTicket(TICKET, AGENT, actor, at(LATER))).rejects.toMatchObject({ status: 400, code: 'ASSIGNEE_NOT_ELIGIBLE' });
    state.selectQueue.push([storedTicket()], [{ id: AGENT, partnerId: PARTNER, orgId: OTHER_ORG, status: 'active' }]);
    await expect(assignTicket(TICKET, AGENT, actor, at(LATER))).rejects.toMatchObject({ status: 400, code: 'ASSIGNEE_NOT_ELIGIBLE' });
    state.selectQueue.push([storedTicket()], []);
    await expect(assignTicket(TICKET, AGENT, actor, at(LATER))).rejects.toMatchObject({ status: 404, code: 'ASSIGNEE_NOT_FOUND' });
    expect(state.updates).toEqual([]);
  });

  it("assigns a deactivated agent or one of the ticket org's users, at the source time, notifying nobody", async () => {
    state.selectQueue.push([storedTicket()], [{ id: AGENT, partnerId: PARTNER, orgId: ORG, status: 'disabled' }]);
    await assignTicket(TICKET, AGENT, actor, at(LATER));
    expect(mocks.eligible).not.toHaveBeenCalled();
    const [update] = state.updates;
    expect(update!.set).toMatchObject({ assignedTo: AGENT, status: 'open' });
    expect(render(update!.set.updatedAt).sql).toMatch(/GREATEST\("tickets"\."updated_at", \$1::timestamp\)/);
    expect(render(update!.set.updatedAt).params).toEqual([LATER.toISOString()]);
    expect(inserted(ticketComments)[0]).toMatchObject({ commentType: 'assignment', createdAt: LATER, migrationWindowId: WINDOW, originPrincipalId: PRINCIPAL });
    expectNoSideEffects();
  });

  it('refuses a historic time before the ticket was created', async () => {
    state.selectQueue.push([storedTicket()]);
    await expect(assignTicket(TICKET, null, actor, at(new Date(CREATED.getTime() - 1))))
      .rejects.toMatchObject({ code: 'IMPORT_TIME_INVALID' });
  });
});

describe('changeTicketStatus in import mode', () => {
  it('resolves without a note, at the source time, with no event, outbox, audit or triage feedback', async () => {
    state.selectQueue.push([storedTicket({ status: 'open' })]);
    await changeTicketStatus(TICKET, { status: 'resolved' }, {}, actor, at(LATER));
    const [update] = state.updates;
    expect(update!.set).toMatchObject({ status: 'resolved', resolvedAt: LATER });
    expect(inserted(ticketComments)[0]).toMatchObject({ commentType: 'status_change', newValue: 'resolved', createdAt: LATER, migrationWindowId: WINDOW });
    expectNoSideEffects();
  });

  it('a live resolve still needs its note', async () => {
    state.selectQueue.push([storedTicket({ status: 'open' })]);
    await expect(changeTicketStatus(TICKET, { status: 'resolved' }, {}, { kind: 'user', userId: AGENT })).rejects.toThrow(/resolution note/);
  });

  it('resolved then closed keeps both source times', async () => {
    const closedAt = new Date('2021-03-10T08:00:00.000Z');
    state.selectQueue.push([storedTicket({ status: 'resolved', resolvedAt: LATER })]);
    await changeTicketStatus(TICKET, { status: 'closed' }, {}, actor, at(closedAt));
    expect(state.updates[0]!.set).toMatchObject({ status: 'closed', closedAt, resolvedAt: LATER, closedBy: null });
    // Closing straight from open stamps resolved_at at the close time, as live does with now.
    state.updates.length = 0;
    state.selectQueue.push([storedTicket({ status: 'open' })]);
    await changeTicketStatus(TICKET, { status: 'closed' }, {}, actor, at(closedAt));
    expect(state.updates[0]!.set).toMatchObject({ closedAt, resolvedAt: closedAt });
    expectNoSideEffects();
  });

  it('skips the SLA pause bookkeeping: an imported ticket has no targets to pause', async () => {
    state.selectQueue.push([storedTicket({ status: 'open' })]);
    await changeTicketStatus(TICKET, { status: 'pending' }, {}, actor, at(LATER));
    expect(state.updates[0]!.set).not.toHaveProperty('slaPausedAt');
    state.updates.length = 0;
    state.selectQueue.push([storedTicket({ status: 'pending', slaPausedAt: CREATED })]);
    await changeTicketStatus(TICKET, { status: 'open' }, {}, actor, at(LATER));
    expect(state.updates[0]!.set).not.toHaveProperty('slaPausedMinutes');
  });

  it('keeps the transition table', async () => {
    state.selectQueue.push([storedTicket({ status: 'closed' })]);
    await expect(changeTicketStatus(TICKET, { status: 'pending' }, {}, actor, at(LATER))).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('updateTicketFields in import mode', () => {
  it('never restamps SLA targets on a priority change, and stamps the feed row at the source time', async () => {
    state.selectQueue.push([storedTicket({ status: 'open' })]);
    await updateTicketFields(TICKET, { priority: 'urgent', tags: ['vip'] }, actor, at(LATER));
    expect(mocks.orgSla).not.toHaveBeenCalled();
    const [update] = state.updates;
    expect(update!.set).toMatchObject({ priority: 'urgent', tags: ['vip'] });
    expect(update!.set).not.toHaveProperty('responseSlaMinutes');
    expect(render(update!.set.updatedAt).sql).toMatch(/GREATEST/);
    expect(render(update!.set.fieldProvenance).params).toEqual([JSON.stringify({ priority: 'service_principal', tags: 'service_principal' })]);
    expect(inserted(ticketComments)[0]).toMatchObject({ commentType: 'system', createdAt: LATER, migrationWindowId: WINDOW });
    expectNoSideEffects();
  });

  it('refuses a field outside what an import converges (device, requester, SLA, budget, due date)', async () => {
    for (const fields of [{ deviceId: null }, { submitterName: 'x' }, { responseSlaMinutes: 30 }, { budgetMinutes: 60 }, { dueDate: LATER }]) {
      state.selectQueue.push([storedTicket()]);
      await expect(updateTicketFields(TICKET, fields, actor, at(LATER))).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
    expect(state.updates).toEqual([]);
  });

  it('a live priority change on an open ticket still restamps (unchanged)', async () => {
    state.selectQueue.push([storedTicket({ status: 'open', responseSlaMinutes: 120, resolutionSlaMinutes: 960 })]);
    await updateTicketFields(TICKET, { priority: 'urgent' }, { kind: 'user', userId: AGENT });
    expect(mocks.orgSla).toHaveBeenCalled();
    expect(state.updates[0]!.set).toMatchObject({ responseSlaMinutes: 60, resolutionSlaMinutes: 480 });
  });
});

describe('addTicketComment in import mode', () => {
  const staff = { sourceId: 'a-1', author: { kind: 'staff' as const, name: 'Former Tech', email: 'former@msp.example' } };
  const requester = { sourceId: 'a-2', author: { kind: 'requester' as const, name: 'Maya', email: 'maya@customer.example' } };

  it('writes the original author, the source id and time; a public STAFF reply stamps the first response at its time', async () => {
    state.selectQueue.push([storedTicket()]);
    const result = await addTicketComment(TICKET, { content: 'Fixed it', isPublic: true, imported: staff }, actor, at(LATER));
    expect(inserted(ticketComments)[0]).toMatchObject({
      authorName: 'Former Tech',
      authorType: 'internal',
      originalAuthorEmail: 'former@msp.example',
      originalAuthorKind: 'staff',
      importSourceId: 'a-1',
      createdAt: LATER,
      migrationWindowId: WINDOW,
      userId: null,
      originPrincipalKind: 'service_principal',
      originPrincipalId: PRINCIPAL,
      commentType: 'comment',
    });
    const [update] = state.updates;
    const firstResponse = render(update!.set.firstResponseAt);
    expect(firstResponse.sql).toMatch(/LEAST\(COALESCE\("tickets"\."first_response_at", \$1::timestamp\), \$2::timestamp\)/);
    expect(firstResponse.params).toEqual([LATER.toISOString(), LATER.toISOString()]);
    expect(result.firstResponseStamped).toBe(true);
    expectNoSideEffects();
  });

  it("a requester's public reply is author_type email and is not a first response; an internal note neither", async () => {
    state.selectQueue.push([storedTicket()]);
    const result = await addTicketComment(TICKET, { content: 'Still broken', isPublic: true, imported: requester }, actor, at(LATER));
    expect(inserted(ticketComments)[0]).toMatchObject({ authorType: 'email', originalAuthorKind: 'requester', authorName: 'Maya' });
    expect(state.updates).toEqual([]);
    expect(result.firstResponseStamped).toBe(false);
    state.selectQueue.push([storedTicket()]);
    await addTicketComment(TICKET, { content: 'note', isPublic: false, imported: { ...staff, sourceId: 'a-3' } }, actor, at(LATER));
    expect(state.updates).toEqual([]);
    expectNoSideEffects();
  });

  it('imported authorship is refused on a live comment and required on an import', async () => {
    await expect(addTicketComment(TICKET, { content: 'x', isPublic: true, imported: staff }, { kind: 'user', userId: AGENT }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(addTicketComment(TICKET, { content: 'x', isPublic: true }, actor, at(LATER)))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(state.inserts).toEqual([]);
  });

  it('a live public comment still stamps the first response now and is published', async () => {
    state.selectQueue.push([storedTicket()]);
    await addTicketComment(TICKET, { content: 'Hi', isPublic: true }, { kind: 'user', userId: AGENT, name: 'Tess' });
    expect(state.updates[0]!.set.firstResponseAt).toBeInstanceOf(Date);
    expect(inserted(ticketOutbox)).toHaveLength(1);
    expect(mocks.emit).toHaveBeenCalledTimes(1);
  });
});
