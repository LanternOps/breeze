import { z } from 'zod';

export const ticketStatusSchema = z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const ticketSourceSchema = z.enum(['portal', 'email', 'alert', 'manual', 'api', 'ai']);

export const createTicketSchema = z.object({
  orgId: z.string().uuid(),
  subject: z.string().min(1).max(255),
  description: z.string().max(50_000).optional(),
  deviceId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  priority: ticketPrioritySchema.default('normal'),
  dueDate: z.coerce.date().optional(),
  assigneeId: z.string().uuid().optional()
});

export const updateTicketSchema = z.object({
  subject: z.string().min(1).max(255).optional(),
  description: z.string().max(50_000).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  priority: ticketPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  deviceId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional()
});

export const changeTicketStatusSchema = z.object({
  status: ticketStatusSchema,
  resolutionNote: z.string().min(1).max(10_000).optional(),
  pendingReason: z.string().max(500).optional()
}).refine(
  (v) => v.status !== 'resolved' || (v.resolutionNote !== undefined && v.resolutionNote.length > 0),
  { message: 'resolutionNote is required when resolving', path: ['resolutionNote'] }
);

export const assignTicketSchema = z.object({
  assigneeId: z.string().uuid().nullable()
});

export const addTicketCommentSchema = z.object({
  content: z.string().min(1).max(50_000),
  isPublic: z.boolean().default(true)
});

export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: ticketStatusSchema.optional(),
  statusGroup: z.enum(['open', 'closed']).optional(),
  orgId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  categoryId: z.string().uuid().optional(),
  priority: ticketPrioritySchema.optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['triage', 'newest', 'oldest', 'due']).default('triage')
});

export const ticketCategoryInputSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  parentId: z.string().uuid().nullable().optional(),
  defaultPriority: ticketPrioritySchema.nullable().optional(),
  responseSlaMinutes: z.number().int().positive().nullable().optional(),
  resolutionSlaMinutes: z.number().int().positive().nullable().optional(),
  defaultBillable: z.boolean().optional(),
  defaultHourlyRate: z.number().nonnegative().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional()
});
