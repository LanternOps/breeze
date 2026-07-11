import { describe, it, expect } from 'vitest';
import {
  createTicketSchema, updateTicketSchema, changeTicketStatusSchema,
  assignTicketSchema, addTicketCommentSchema, listTicketsQuerySchema,
  ticketCategoryInputSchema, bulkTicketActionSchema, editCommentSchema, moveTicketOrgSchema,
  createTicketFromChatSchema
} from './tickets';

describe('ticket validators', () => {
  it('accepts a minimal valid create payload', () => {
    const r = createTicketSchema.safeParse({
      orgId: '3f2f1d8e-1111-4222-8333-444455556666',
      subject: 'Printer offline'
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBeUndefined();
  });

  it('createTicketSchema: subject optional only when formId present; formResponses passthrough', () => {
    const orgId = '3f2f1d8e-1111-4222-8333-444455556666';
    const formId = '9a8b7c6d-1111-4222-8333-444455556666';
    expect(createTicketSchema.safeParse({ orgId }).success).toBe(false); // no subject, no form
    expect(createTicketSchema.safeParse({ orgId, formId }).success).toBe(true);
    const r = createTicketSchema.safeParse({ orgId, formId, formResponses: { affected_user: 'jdoe' } });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.formResponses).toEqual({ affected_user: 'jdoe' });
  });

  it('createTicketSchema: formResponses without formId is rejected', () => {
    const orgId = '3f2f1d8e-1111-4222-8333-444455556666';
    const formId = '9a8b7c6d-1111-4222-8333-444455556666';
    // formResponses with no formId has nothing to validate against — reject it.
    const bad = createTicketSchema.safeParse({ orgId, subject: 'x', formResponses: { affected_user: 'jdoe' } });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(bad.error.issues.some((i) => i.path[0] === 'formResponses' && /requires formId/i.test(i.message))).toBe(true);
    }
    // formId + formResponses together still accepted.
    expect(createTicketSchema.safeParse({ orgId, formId, formResponses: { affected_user: 'jdoe' } }).success).toBe(true);
    // Plain ticket (neither) still accepted.
    expect(createTicketSchema.safeParse({ orgId, subject: 'x' }).success).toBe(true);
  });

  it('createTicketSchema: priority no longer injects a default', () => {
    const r = createTicketSchema.safeParse({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBeUndefined();
  });

  it('rejects empty subject and invalid orgId', () => {
    expect(createTicketSchema.safeParse({ orgId: 'nope', subject: 'x' }).success).toBe(false);
    expect(createTicketSchema.safeParse({ orgId: '3f2f1d8e-1111-4222-8333-444455556666', subject: '' }).success).toBe(false);
  });

  it('requires resolutionNote when status is resolved', () => {
    expect(changeTicketStatusSchema.safeParse({ status: 'resolved' }).success).toBe(false);
    expect(changeTicketStatusSchema.safeParse({ status: 'resolved', resolutionNote: 'Replaced toner' }).success).toBe(true);
    expect(changeTicketStatusSchema.safeParse({ status: 'open' }).success).toBe(true);
  });

  it('changeTicketStatusSchema: both status and statusId → invalid', () => {
    const r = changeTicketStatusSchema.safeParse({
      status: 'open',
      statusId: '3f2f1d8e-1111-4222-8333-444455556666'
    });
    expect(r.success).toBe(false);
  });

  it('changeTicketStatusSchema: neither status nor statusId → invalid', () => {
    const r = changeTicketStatusSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('changeTicketStatusSchema: statusId only (uuid) → valid', () => {
    const r = changeTicketStatusSchema.safeParse({
      statusId: '3f2f1d8e-1111-4222-8333-444455556666'
    });
    expect(r.success).toBe(true);
  });

  it('changeTicketStatusSchema: statusId with non-uuid → invalid', () => {
    const r = changeTicketStatusSchema.safeParse({ statusId: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });

  it('changeTicketStatusSchema: status=resolved without resolutionNote → invalid', () => {
    const r = changeTicketStatusSchema.safeParse({ status: 'resolved' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some(i => i.path.includes('resolutionNote'))).toBe(true);
    }
  });

  it('assign accepts a uuid or null (unassign)', () => {
    expect(assignTicketSchema.safeParse({ assigneeId: null }).success).toBe(true);
    expect(assignTicketSchema.safeParse({ assigneeId: '3f2f1d8e-1111-4222-8333-444455556666' }).success).toBe(true);
    expect(assignTicketSchema.safeParse({ assigneeId: 'me' }).success).toBe(false);
  });

  it('comment requires non-empty content and defaults to public', () => {
    const r = addTicketCommentSchema.safeParse({ content: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.isPublic).toBe(true);
    expect(addTicketCommentSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('list query coerces paging and validates enums', () => {
    const r = listTicketsQuerySchema.safeParse({ page: '2', limit: '25', statusGroup: 'open', assignee: 'me' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(2);
      expect(r.data.sort).toBe('triage');
    }
    expect(listTicketsQuerySchema.safeParse({ statusGroup: 'weird' }).success).toBe(false);
  });

  it('list query accepts an optional deviceId uuid filter', () => {
    const ok = listTicketsQuerySchema.safeParse({ deviceId: '3f2f1d8e-1111-4222-8333-444455556666' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.deviceId).toBe('3f2f1d8e-1111-4222-8333-444455556666');
    expect(listTicketsQuerySchema.safeParse({ deviceId: 'not-a-uuid' }).success).toBe(false);
  });

  it('listTicketsQuerySchema accepts slaState values', () => {
    for (const v of ['ok', 'at_risk', 'breached', 'breaching']) {
      expect(listTicketsQuerySchema.parse({ slaState: v }).slaState).toBe(v);
    }
    expect(() => listTicketsQuerySchema.parse({ slaState: 'nope' })).toThrow();
  });

  describe('requester fields', () => {
    const ORG = '3f2f1d8e-1111-4222-8333-444455556666';
    const PORTAL_USER = '5a6b7c8d-1234-4321-abcd-000011112222';

    it('createTicketSchema accepts a portal-user requester (submittedBy)', () => {
      const r = createTicketSchema.safeParse({ orgId: ORG, subject: 'x', submittedBy: PORTAL_USER });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.submittedBy).toBe(PORTAL_USER);
    });

    it('createTicketSchema accepts a free-text requester (name + email)', () => {
      const r = createTicketSchema.safeParse({ orgId: ORG, subject: 'x', submitterName: 'Jane', submitterEmail: 'jane@example.com' });
      expect(r.success).toBe(true);
    });

    it('createTicketSchema rejects a non-uuid submittedBy and a malformed email', () => {
      expect(createTicketSchema.safeParse({ orgId: ORG, subject: 'x', submittedBy: 'nope' }).success).toBe(false);
      expect(createTicketSchema.safeParse({ orgId: ORG, subject: 'x', submitterEmail: 'not-an-email' }).success).toBe(false);
    });

    it('updateTicketSchema accepts requester changes incl null to clear the portal link', () => {
      expect(updateTicketSchema.safeParse({ submittedBy: PORTAL_USER }).success).toBe(true);
      expect(updateTicketSchema.safeParse({ submittedBy: null, submitterName: 'Jane', submitterEmail: 'jane@example.com' }).success).toBe(true);
      expect(updateTicketSchema.safeParse({ submitterName: null, submitterEmail: null }).success).toBe(true);
    });

    it('updateTicketSchema rejects a malformed requester email', () => {
      expect(updateTicketSchema.safeParse({ submitterEmail: 'bad' }).success).toBe(false);
    });

    it('updateTicketSchema rejects an empty submitterName (clear via null, not "")', () => {
      expect(updateTicketSchema.safeParse({ submitterName: '' }).success).toBe(false);
      expect(updateTicketSchema.safeParse({ submitterName: null }).success).toBe(true);
    });
  });

  it('updateTicketSchema accepts SLA override minutes', () => {
    expect(updateTicketSchema.parse({ responseSlaMinutes: 30, resolutionSlaMinutes: 120 }))
      .toEqual({ responseSlaMinutes: 30, resolutionSlaMinutes: 120 });
    expect(updateTicketSchema.parse({ responseSlaMinutes: null }).responseSlaMinutes).toBeNull();
  });

  it('updateTicketSchema rejects non-positive SLA minutes', () => {
    expect(() => updateTicketSchema.parse({ responseSlaMinutes: 0 })).toThrow();
    expect(() => updateTicketSchema.parse({ resolutionSlaMinutes: -5 })).toThrow();
  });

  it('category validates hex color', () => {
    expect(ticketCategoryInputSchema.safeParse({ name: 'Hardware', color: '#1c8a9e' }).success).toBe(true);
    expect(ticketCategoryInputSchema.safeParse({ name: 'Hardware', color: 'teal' }).success).toBe(false);
  });

  describe('bulkTicketActionSchema', () => {
    const ID = '3f2f1d8e-1111-4222-8333-444455556666';
    const ASSIGNEE = '5a6b7c8d-1234-4321-abcd-000011112222';

    it('accepts assign with a uuid assignee and with null (unassign)', () => {
      expect(bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'assign', assigneeId: ASSIGNEE }).success).toBe(true);
      expect(bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'assign', assigneeId: null }).success).toBe(true);
    });

    it('rejects assign without an assigneeId (refine branch)', () => {
      const r = bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'assign' });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path).toEqual(['assigneeId']);
    });

    it('accepts status for non-resolved statuses', () => {
      expect(bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'status', status: 'closed' }).success).toBe(true);
      expect(bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'status', status: 'on_hold' }).success).toBe(true);
    });

    it('rejects status action without a status (refine branch)', () => {
      const r = bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'status' });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path).toEqual(['status']);
    });

    it('rejects resolved — resolving requires a per-ticket resolution note (refine branch)', () => {
      const r = bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'status', status: 'resolved' });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.path).toEqual(['status']);
    });

    it('enforces ticketIds bounds: 1-100 uuids', () => {
      expect(bulkTicketActionSchema.safeParse({ ticketIds: [], action: 'status', status: 'closed' }).success).toBe(false);
      expect(bulkTicketActionSchema.safeParse({ ticketIds: ['not-a-uuid'], action: 'status', status: 'closed' }).success).toBe(false);
      const tooMany = Array.from({ length: 101 }, () => ID);
      expect(bulkTicketActionSchema.safeParse({ ticketIds: tooMany, action: 'status', status: 'closed' }).success).toBe(false);
    });

    it('accepts action:delete with no extra fields (soft-delete)', () => {
      expect(bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'delete' }).success).toBe(true);
    });

    it('rejects an unknown action', () => {
      expect(bulkTicketActionSchema.safeParse({ ticketIds: [ID], action: 'purge' }).success).toBe(false);
    });
  });

  describe('editCommentSchema', () => {
    it('accepts non-empty content', () => {
      expect(editCommentSchema.parse({ content: 'updated' })).toEqual({ content: 'updated' });
    });
    it('rejects empty content', () => {
      expect(editCommentSchema.safeParse({ content: '' }).success).toBe(false);
    });
  });

  describe('moveTicketOrgSchema', () => {
    it('accepts a uuid orgId', () => {
      const id = '11111111-1111-1111-1111-111111111111';
      expect(moveTicketOrgSchema.parse({ orgId: id })).toEqual({ orgId: id });
    });
    it('rejects a non-uuid orgId', () => {
      expect(moveTicketOrgSchema.safeParse({ orgId: 'nope' }).success).toBe(false);
    });
  });
});

describe('createTicketFromChatSchema', () => {
  const base = { subject: 'Outlook would not open', description: 'Sarah could not open Outlook.', status: 'open' as const, timeMinutes: 15, billable: true };

  it('accepts a valid open-ticket payload', () => {
    expect(createTicketFromChatSchema.parse(base)).toMatchObject({ status: 'open', timeMinutes: 15 });
  });

  it('requires a resolutionNote when status is resolved', () => {
    const r = createTicketFromChatSchema.safeParse({ ...base, status: 'resolved' });
    expect(r.success).toBe(false);
  });

  it('accepts a resolved payload with a resolutionNote', () => {
    const r = createTicketFromChatSchema.safeParse({ ...base, status: 'resolved', resolutionNote: 'Rebuilt the mail profile.' });
    expect(r.success).toBe(true);
  });

  it('rejects negative timeMinutes and empty subject', () => {
    expect(createTicketFromChatSchema.safeParse({ ...base, timeMinutes: -1 }).success).toBe(false);
    expect(createTicketFromChatSchema.safeParse({ ...base, subject: '' }).success).toBe(false);
  });
});
