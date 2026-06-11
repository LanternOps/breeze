import { describe, it, expect } from 'vitest';
import {
  createTicketSchema, updateTicketSchema, changeTicketStatusSchema,
  assignTicketSchema, addTicketCommentSchema, listTicketsQuerySchema,
  ticketCategoryInputSchema, bulkTicketActionSchema
} from './tickets';

describe('ticket validators', () => {
  it('accepts a minimal valid create payload', () => {
    const r = createTicketSchema.safeParse({
      orgId: '3f2f1d8e-1111-4222-8333-444455556666',
      subject: 'Printer offline'
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.priority).toBe('normal');
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
  });
});
