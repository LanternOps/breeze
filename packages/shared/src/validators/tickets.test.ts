import { describe, it, expect } from 'vitest';
import {
  createTicketSchema, updateTicketSchema, changeTicketStatusSchema,
  assignTicketSchema, addTicketCommentSchema, listTicketsQuerySchema,
  ticketCategoryInputSchema
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

  it('category validates hex color', () => {
    expect(ticketCategoryInputSchema.safeParse({ name: 'Hardware', color: '#1c8a9e' }).success).toBe(true);
    expect(ticketCategoryInputSchema.safeParse({ name: 'Hardware', color: 'teal' }).success).toBe(false);
  });
});
