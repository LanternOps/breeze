import { z } from 'zod';
import { ticketPrioritySchema } from './tickets';

export const TICKET_FORM_FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'date', 'number'] as const;
export type TicketFormFieldType = (typeof TICKET_FORM_FIELD_TYPES)[number];

const fieldKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, 'lowercase letters, digits and underscores; must start with a letter');

export const ticketFormFieldSchema = z
  .object({
    key: fieldKeySchema,
    label: z.string().min(1).max(200),
    type: z.enum(TICKET_FORM_FIELD_TYPES),
    required: z.boolean(),
    helpText: z.string().max(500).optional(),
    placeholder: z.string().max(200).optional(),
    options: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional()
  })
  .superRefine((f, ctx) => {
    if (f.type === 'select' && (!f.options || f.options.length === 0)) {
      ctx.addIssue({ code: 'custom', message: 'select fields require options', path: ['options'] });
    }
    if (f.type !== 'select' && f.options !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'options are only valid on select fields', path: ['options'] });
    }
  });

export type TicketFormField = z.infer<typeof ticketFormFieldSchema>;

export const ticketFormFieldsSchema = z
  .array(ticketFormFieldSchema)
  .max(30)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const f of fields) {
      if (seen.has(f.key)) ctx.addIssue({ code: 'custom', message: `duplicate field key: ${f.key}` });
      seen.add(f.key);
    }
  });

export const createTicketFormSchema = z.object({
  // Ownership axis (Partner-Wide First, epic #2135, mirrors software policies
  // #2126): 'partner' = all-orgs form; the server derives the partner from the
  // caller's own token — a client-supplied partner id is NEVER trusted.
  // orgId is only consulted when ownerScope is 'organization' (or absent).
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().guid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  categoryId: z.string().guid().nullable().optional(),
  fields: ticketFormFieldsSchema,
  titleTemplate: z.string().max(300).optional(),
  descriptionIntro: z.string().max(5000).optional(),
  defaultPriority: ticketPrioritySchema.optional(),
  defaultTags: z.array(z.string().min(1).max(100)).max(20).default([]),
  showInPortal: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0)
});

export const updateTicketFormSchema = createTicketFormSchema.partial().omit({ ownerScope: true, orgId: true });

export type CreateTicketFormInput = z.infer<typeof createTicketFormSchema>;
export type UpdateTicketFormInput = z.infer<typeof updateTicketFormSchema>;

/** The subset of a ticket_forms row the rendering/validation helpers need. */
export interface TicketFormLike {
  name: string;
  descriptionIntro?: string | null;
  fields: TicketFormField[];
}

/**
 * Strict runtime validator for a submission against a form's field list.
 * Shared by web (inline errors), API (authoritative), and later the portal.
 * Required checkbox = consent-style: must be exactly true.
 */
export function buildResponseValidator(fields: TicketFormField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    let s: z.ZodType;
    switch (f.type) {
      case 'text':
        s = f.required ? z.string().min(1).max(1000) : z.string().max(1000);
        break;
      case 'textarea':
        s = f.required ? z.string().min(1).max(10_000) : z.string().max(10_000);
        break;
      case 'select':
        s = z.enum(f.options as [string, ...string[]]);
        break;
      case 'checkbox':
        s = f.required ? z.literal(true) : z.boolean();
        break;
      case 'date':
        s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
        break;
      case 'number':
        s = z.number().finite();
        break;
    }
    shape[f.key] = f.required ? s : s.optional();
  }
  return z.object(shape).strict();
}

/**
 * Normalize raw UI values before validation: empty strings become undefined
 * (so optional fields don't fail), number-field strings become numbers.
 */
export function coerceFormResponses(
  fields: TicketFormField[],
  raw: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined || v === null || v === '') continue;
    if (f.type === 'number' && typeof v === 'string') {
      const n = Number(v);
      out[f.key] = Number.isNaN(n) ? v : n;
      continue;
    }
    out[f.key] = v;
  }
  return out;
}

/** {{key}} interpolation; unknown keys render as ''. Blank result falls back to the form name. */
export function renderTitleTemplate(
  template: string | null | undefined,
  formName: string,
  responses: Record<string, unknown>
): string {
  if (!template || !template.trim()) return formName;
  const rendered = template
    .replace(/\{\{\s*([a-z][a-z0-9_]{0,49})\s*\}\}/g, (_m, key: string) => {
      const v = responses[key];
      return v === undefined || v === null ? '' : String(v);
    })
    .trim();
  return rendered.length > 0 ? rendered : formName;
}

export function formatFormResponseValue(field: TicketFormField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field.type === 'checkbox') return value === true ? 'Yes' : 'No';
  return String(value);
}

/**
 * Deterministic markdown block appended to the ticket description. The
 * rendered ticket must stand alone: every consumer (workbench, email, AI,
 * PSA sync) reads this without knowing forms exist.
 */
export function renderFormResponses(form: TicketFormLike, responses: Record<string, unknown>): string {
  const lines: string[] = [];
  if (form.descriptionIntro && form.descriptionIntro.trim()) {
    lines.push(form.descriptionIntro.trim(), '');
  }
  lines.push(`**${form.name}** (form)`);
  for (const f of form.fields) {
    lines.push(`- **${f.label}:** ${formatFormResponseValue(f, responses[f.key])}`);
  }
  return lines.join('\n');
}
