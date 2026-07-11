import { z } from 'zod';

export const ticketStatusSchema = z.enum(['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']);
export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const ticketSourceSchema = z.enum(['portal', 'email', 'alert', 'manual', 'api', 'ai']);
export type TicketStatus = z.infer<typeof ticketStatusSchema>;
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;

export const createTicketSchema = z
  .object({
    orgId: z.string().guid(),
    // Optional when an intake form composes it server-side (formId present).
    subject: z.string().min(1).max(255).optional(),
    description: z.string().max(50_000).optional(),
    deviceId: z.string().guid().optional(),
    categoryId: z.string().guid().optional(),
    // No .default('normal') — the service already falls back to 'normal', and
    // a schema default would make explicit-vs-absent indistinguishable, which
    // breaks intake-form defaultPriority precedence.
    priority: ticketPrioritySchema.optional(),
    dueDate: z.coerce.date().optional(),
    assigneeId: z.string().guid().optional(),
    // Intake form (spec 2026-07-10): responses are validated server-side
    // against the form's field schema in ticketService.
    formId: z.string().guid().optional(),
    formResponses: z.record(z.string(), z.unknown()).optional(),
    // Requester: pick an existing portal user (submittedBy) and/or supply a
    // free-text name/email. When all three are absent the service falls back to
    // the acting staff member's name (legacy behaviour). Picking a portal user
    // backfills name/email from that row when they aren't supplied here.
    submittedBy: z.string().guid().optional(),
    submitterName: z.string().min(1).max(255).optional(),
    submitterEmail: z.string().email().max(255).optional()
  })
  .superRefine((v, ctx) => {
    if (!v.formId && (!v.subject || v.subject.trim().length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['subject'], message: 'subject is required unless a formId is provided' });
    }
  });

export const createTicketFromChatSchema = z
  .object({
    subject: z.string().min(1).max(255),
    description: z.string().max(50_000).optional(),
    status: z.enum(['open', 'resolved']),
    resolutionNote: z.string().max(50_000).optional(),
    timeMinutes: z.number().int().min(0).max(24 * 60),
    billable: z.boolean(),
    priority: ticketPrioritySchema.optional(),
  })
  .refine((v) => v.status !== 'resolved' || (v.resolutionNote?.trim().length ?? 0) > 0, {
    message: 'A resolution note is required to resolve a ticket',
    path: ['resolutionNote'],
  });

export type CreateTicketFromChatInput = z.infer<typeof createTicketFromChatSchema>;

export const updateTicketSchema = z.object({
  subject: z.string().min(1).max(255).optional(),
  description: z.string().max(50_000).optional(),
  categoryId: z.string().guid().nullable().optional(),
  priority: ticketPrioritySchema.optional(),
  dueDate: z.coerce.date().nullable().optional(),
  responseSlaMinutes: z.number().int().positive().nullable().optional(),
  resolutionSlaMinutes: z.number().int().positive().nullable().optional(),
  deviceId: z.string().guid().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  // Requester edit. submittedBy=null clears the portal link (free-text requester);
  // a uuid links a portal user and backfills name/email when those are omitted.
  // submitterName mirrors create's min(1) (use null to clear, not an empty string).
  submittedBy: z.string().guid().nullable().optional(),
  submitterName: z.string().min(1).max(255).nullable().optional(),
  submitterEmail: z.string().email().max(255).nullable().optional()
});

export const changeTicketStatusSchema = z.object({
  status: ticketStatusSchema.optional(),
  statusId: z.string().guid().optional(),
  resolutionNote: z.string().min(1).max(10_000).optional(),
  pendingReason: z.string().max(500).optional()
}).superRefine((v, ctx) => {
  const hasStatus = v.status !== undefined;
  const hasStatusId = v.statusId !== undefined;
  if (hasStatus && hasStatusId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide either status or statusId, not both', path: ['status'] });
  }
  if (!hasStatus && !hasStatusId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Either status or statusId is required', path: [] });
  }
  if (hasStatus && v.status === 'resolved' && (!v.resolutionNote || v.resolutionNote.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'resolutionNote is required when resolving', path: ['resolutionNote'] });
  }
});

export const assignTicketSchema = z.object({
  assigneeId: z.string().guid().nullable()
});

// Bulk queue actions (assign / status / delete). Resolving is intentionally
// excluded: it requires a per-ticket resolution note, so it stays a per-ticket
// action. 'delete' is a soft-delete and carries no extra fields; the route gates
// it on tickets:manage (assign/status only need tickets:write).
export const bulkTicketActionSchema = z.object({
  ticketIds: z.array(z.string().guid()).min(1).max(100),
  action: z.enum(['assign', 'status', 'delete']),
  assigneeId: z.string().guid().nullable().optional(),
  status: ticketStatusSchema.optional()
}).refine(
  (v) => v.action !== 'assign' || v.assigneeId !== undefined,
  { message: 'assigneeId is required when action is assign (null to unassign)', path: ['assigneeId'] }
).refine(
  (v) => v.action !== 'status' || v.status !== undefined,
  { message: 'status is required when action is status', path: ['status'] }
).refine(
  (v) => v.action !== 'status' || v.status !== 'resolved',
  { message: 'Resolving requires a per-ticket resolution note; resolve tickets individually', path: ['status'] }
);

export const addTicketCommentSchema = z.object({
  content: z.string().min(1).max(50_000),
  isPublic: z.boolean().default(true)
});

export const editCommentSchema = z.object({
  content: z.string().min(1).max(50_000)
});

export const moveTicketOrgSchema = z.object({
  orgId: z.string().guid()
});

export const listTicketsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: ticketStatusSchema.optional(),
  statusGroup: z.enum(['open', 'closed']).optional(),
  orgId: z.string().guid().optional(),
  deviceId: z.string().guid().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().guid()]).optional(),
  categoryId: z.string().guid().optional(),
  priority: ticketPrioritySchema.optional(),
  slaState: z.enum(['ok', 'at_risk', 'breached', 'breaching']).optional(),
  search: z.string().max(200).optional(),
  sort: z.enum(['triage', 'newest', 'oldest', 'due']).default('triage'),
  // deleted=only returns the soft-deleted "Archived" queue (tickets:manage only).
  // Omitted/any other value returns live tickets (deleted rows excluded).
  deleted: z.enum(['only']).optional()
});

export const ticketCategoryInputSchema = z.object({
  name: z.string().min(1).max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  parentId: z.string().guid().nullable().optional(),
  defaultPriority: ticketPrioritySchema.nullable().optional(),
  responseSlaMinutes: z.number().int().positive().nullable().optional(),
  resolutionSlaMinutes: z.number().int().positive().nullable().optional(),
  defaultBillable: z.boolean().optional(),
  defaultHourlyRate: z.number().nonnegative().nullable().optional(),
  sortOrder: z.number().int().optional(),
  isActive: z.boolean().optional()
});
