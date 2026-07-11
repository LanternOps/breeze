import { z } from 'zod';
import { ticketPrioritySchema } from './tickets';

export const TICKET_FORM_FIELD_TYPES = ['text', 'textarea', 'select', 'checkbox', 'date', 'number'] as const;
export type TicketFormFieldType = (typeof TICKET_FORM_FIELD_TYPES)[number];

// Single source of truth for a field key's shape. The anchored form validates a
// stored key; renderTitleTemplate derives an unanchored `{{key}}` matcher from
// the same core so the two can never drift.
const FIELD_KEY_CORE = '[a-z][a-z0-9_]{0,49}';
export const TICKET_FORM_FIELD_KEY_PATTERN = new RegExp(`^${FIELD_KEY_CORE}$`);

const fieldKeySchema = z
  .string()
  .regex(TICKET_FORM_FIELD_KEY_PATTERN, 'lowercase letters, digits and underscores; must start with a letter');

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

// Default-free base with EVERY form field but WITHOUT ownerScope/orgId and
// WITHOUT any .default(). createTicketFormSchema re-adds the create-time
// defaults and the ownership axis; updateTicketFormSchema is base.partial().
// Structuring it this way is load-bearing: in this zod version, a .partial() of
// a schema whose keys carry .default() still MATERIALIZES those defaults for
// omitted keys — so a partial PUT of only { name } would silently reset
// defaultTags/showInPortal/isActive/sortOrder. Keeping the defaults OUT of the
// base is what makes the update schema truly partial.
const ticketFormBaseSchema = z.object({
  name: z.string().min(1).max(200),
  // All clearable optionals accept explicit null: the update schema is
  // .partial(), so the web editor must SEND null to clear a stored value —
  // omitting the key on an update silently keeps the old one.
  description: z.string().max(2000).nullable().optional(),
  categoryId: z.string().guid().nullable().optional(),
  fields: ticketFormFieldsSchema,
  titleTemplate: z.string().max(300).nullable().optional(),
  descriptionIntro: z.string().max(5000).nullable().optional(),
  defaultPriority: ticketPrioritySchema.nullable().optional(),
  defaultTags: z.array(z.string().min(1).max(100)).max(20),
  showInPortal: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(10_000)
});

export const createTicketFormSchema = ticketFormBaseSchema.extend({
  // Ownership axis (Partner-Wide First, epic #2135, mirrors software policies
  // #2126): 'partner' = all-orgs form; the server derives the partner from the
  // caller's own token — a client-supplied partner id is NEVER trusted.
  // orgId is only consulted when ownerScope is 'organization' (or absent).
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().guid().optional(),
  // Create-time defaults live ONLY here (never on the base — see above).
  defaultTags: z.array(z.string().min(1).max(100)).max(20).default([]),
  showInPortal: z.boolean().default(true),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0)
});

// Ownership (ownerScope/orgId) is immutable-by-omission: it is not part of the
// base, so it can never appear on an update payload.
export const updateTicketFormSchema = ticketFormBaseSchema.partial();

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
      case 'select': {
        // Defensive: a malformed field list (options missing/empty) must not
        // throw at schema construction; such a field simply accepts no value.
        const opts = f.options ?? [];
        s = opts.length ? z.enum(opts as [string, ...string[]]) : z.never();
        break;
      }
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
    if (v === undefined || v === null) continue;
    // Blank (empty or whitespace-only) strings mean "not answered" for every
    // field type — notably Number(' ') === 0, which would fabricate a value.
    if (typeof v === 'string' && v.trim() === '') continue;
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
    .replace(new RegExp(`\\{\\{\\s*(${FIELD_KEY_CORE})\\s*\\}\\}`, 'g'), (_m, key: string) => {
      const v = responses[key];
      return v === undefined || v === null ? '' : String(v);
    })
    // Titles are single-line: collapse all whitespace runs (incl. newlines
    // smuggled in via response values) to single spaces.
    .replace(/\s+/g, ' ')
    .trim();
  return rendered.length > 0 ? rendered : formName;
}

export function formatFormResponseValue(field: TicketFormField, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field.type === 'checkbox') return value === true ? 'Yes' : 'No';
  // Indent continuation lines so a multiline value cannot start a new list
  // item at column 0 and forge sibling field lines (content spoofing /
  // prompt-injection surface for downstream AI/email/PSA consumers).
  return String(value).replace(/\r\n?|\n/g, '\n  ');
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
