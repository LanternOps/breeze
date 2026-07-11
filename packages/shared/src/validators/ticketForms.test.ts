import { describe, it, expect } from 'vitest';
import {
  ticketFormFieldsSchema,
  createTicketFormSchema,
  updateTicketFormSchema,
  buildResponseValidator,
  coerceFormResponses,
  renderTitleTemplate,
  renderFormResponses,
  type TicketFormField
} from './ticketForms';

const fields: TicketFormField[] = [
  { key: 'affected_user', label: 'Affected user', type: 'text', required: true },
  { key: 'start_date', label: 'Start date', type: 'date', required: true },
  { key: 'needs_vpn', label: 'Needs VPN', type: 'checkbox', required: false },
  { key: 'license_count', label: 'License count', type: 'number', required: false },
  { key: 'department', label: 'Department', type: 'select', required: true, options: ['Sales', 'Ops'] }
];

describe('ticketFormFieldsSchema', () => {
  it('accepts a valid field list and rejects duplicate keys', () => {
    expect(ticketFormFieldsSchema.safeParse(fields).success).toBe(true);
    expect(ticketFormFieldsSchema.safeParse([fields[0], fields[0]]).success).toBe(false);
  });

  it('rejects select without options, options on non-select, bad keys, >30 fields', () => {
    expect(ticketFormFieldsSchema.safeParse([{ key: 'a', label: 'A', type: 'select', required: false }]).success).toBe(false);
    expect(ticketFormFieldsSchema.safeParse([{ key: 'a', label: 'A', type: 'text', required: false, options: ['x'] }]).success).toBe(false);
    expect(ticketFormFieldsSchema.safeParse([{ key: 'Bad-Key', label: 'A', type: 'text', required: false }]).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => ({ key: `f_${i}`, label: `F${i}`, type: 'text' as const, required: false }));
    expect(ticketFormFieldsSchema.safeParse(many).success).toBe(false);
  });
});

describe('createTicketFormSchema / updateTicketFormSchema', () => {
  it('accepts a minimal create payload and defaults', () => {
    const r = createTicketFormSchema.safeParse({ name: 'New user onboarding', fields });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.isActive).toBe(true);
      expect(r.data.showInPortal).toBe(true);
      expect(r.data.defaultTags).toEqual([]);
      expect(r.data.sortOrder).toBe(0);
    }
  });

  it('accepts explicit nulls for all clearable optional fields (create + update)', () => {
    // The web editor clears an optional on EDIT by sending an explicit null —
    // omitting the key on a .partial() update schema is a silent keep-old-value.
    const nulls = {
      description: null,
      categoryId: null,
      titleTemplate: null,
      descriptionIntro: null,
      defaultPriority: null
    };
    const u = updateTicketFormSchema.safeParse(nulls);
    expect(u.success).toBe(true);
    if (u.success) {
      expect(u.data.description).toBeNull();
      expect(u.data.categoryId).toBeNull();
      expect(u.data.titleTemplate).toBeNull();
      expect(u.data.descriptionIntro).toBeNull();
      expect(u.data.defaultPriority).toBeNull();
    }
    const c = createTicketFormSchema.safeParse({ name: 'n', fields, ...nulls });
    expect(c.success).toBe(true);
  });

  it('update schema does NOT materialize create-time defaults for omitted keys', () => {
    // .partial() must not re-apply .default() to omitted keys: a partial PUT of
    // only { name } must never carry defaultTags/showInPortal/isActive/sortOrder,
    // or every web edit would reset those four API-set fields.
    const r = updateTicketFormSchema.parse({ name: 'x' });
    expect('defaultTags' in r).toBe(false);
    expect('showInPortal' in r).toBe(false);
    expect('isActive' in r).toBe(false);
    expect('sortOrder' in r).toBe(false);
    expect(Object.keys(r)).toEqual(['name']);
  });

  it('update schema passes through explicit values and explicit nulls', () => {
    const r = updateTicketFormSchema.parse({
      defaultTags: ['vip'],
      showInPortal: false,
      isActive: false,
      sortOrder: 5,
      description: null,
      titleTemplate: null
    });
    expect(r.defaultTags).toEqual(['vip']);
    expect(r.showInPortal).toBe(false);
    expect(r.isActive).toBe(false);
    expect(r.sortOrder).toBe(5);
    expect(r.description).toBeNull();
    expect(r.titleTemplate).toBeNull();
  });

  it('update schema refuses ownerScope and orgId', () => {
    const r = updateTicketFormSchema.safeParse({ ownerScope: 'partner', orgId: '3f2f1d8e-1111-4222-8333-444455556666', name: 'x' });
    // .omit() strips the keys from the schema; strict() makes them errors — we use strip semantics, so keys are silently dropped
    expect(r.success).toBe(true);
    if (r.success) {
      expect('ownerScope' in r.data).toBe(false);
      expect('orgId' in r.data).toBe(false);
    }
  });
});

describe('buildResponseValidator', () => {
  const v = buildResponseValidator(fields);

  it('accepts valid responses', () => {
    const r = v.safeParse({ affected_user: 'jdoe@client.example', start_date: '2026-07-14', needs_vpn: true, license_count: 3, department: 'Sales' });
    expect(r.success).toBe(true);
  });

  it('rejects missing required, unknown keys, bad select option, bad date', () => {
    expect(v.safeParse({ start_date: '2026-07-14', department: 'Sales' }).success).toBe(false); // missing affected_user
    expect(v.safeParse({ affected_user: 'x', start_date: '2026-07-14', department: 'Sales', extra: 1 }).success).toBe(false);
    expect(v.safeParse({ affected_user: 'x', start_date: '2026-07-14', department: 'HR' }).success).toBe(false);
    expect(v.safeParse({ affected_user: 'x', start_date: 'tomorrow', department: 'Sales' }).success).toBe(false);
  });

  it('required checkbox must be true', () => {
    const consent = buildResponseValidator([{ key: 'confirmed', label: 'I rebooted', type: 'checkbox', required: true }]);
    expect(consent.safeParse({ confirmed: true }).success).toBe(true);
    expect(consent.safeParse({ confirmed: false }).success).toBe(false);
  });

  it('select field lacking options does not throw at construction and rejects any value', () => {
    const broken = { key: 'dept', label: 'Department', type: 'select', required: true } as TicketFormField;
    let v!: ReturnType<typeof buildResponseValidator>;
    expect(() => {
      v = buildResponseValidator([broken]);
    }).not.toThrow();
    expect(v.safeParse({ dept: 'Sales' }).success).toBe(false);
    expect(v.safeParse({ dept: '' }).success).toBe(false);
  });
});

describe('coerceFormResponses', () => {
  it('coerces number strings, drops empty strings, passes booleans', () => {
    expect(coerceFormResponses(fields, { affected_user: 'x', license_count: '4', needs_vpn: false, department: '' }))
      .toEqual({ affected_user: 'x', license_count: 4, needs_vpn: false });
  });

  it('drops whitespace-only strings for all field types', () => {
    expect(coerceFormResponses(fields, { license_count: ' ' })).toEqual({});
    expect(coerceFormResponses(fields, { affected_user: '   ', department: '\t\n' })).toEqual({});
  });
});

describe('rendering', () => {
  it('interpolates title template, blanks missing keys, falls back to form name', () => {
    expect(renderTitleTemplate('Onboard {{affected_user}} ({{missing}})', 'New user', { affected_user: 'jdoe' })).toBe('Onboard jdoe ()');
    expect(renderTitleTemplate('   ', 'New user', {})).toBe('New user');
    expect(renderTitleTemplate(null, 'New user', {})).toBe('New user');
  });

  it('renders a markdown block with intro, Yes/No checkboxes, and em-dash for blanks', () => {
    const out = renderFormResponses(
      { name: 'New user onboarding', descriptionIntro: 'HR request.', fields },
      { affected_user: 'jdoe@client.example', start_date: '2026-07-14', needs_vpn: true, department: 'Sales' }
    );
    expect(out).toContain('HR request.');
    expect(out).toContain('**New user onboarding** (form)');
    expect(out).toContain('- **Affected user:** jdoe@client.example');
    expect(out).toContain('- **Needs VPN:** Yes');
    expect(out).toContain('- **License count:** —');
  });

  it('indents multiline response values so they cannot forge sibling field lines', () => {
    const out = renderFormResponses(
      { name: 'New user onboarding', descriptionIntro: null, fields },
      { affected_user: 'x\n- **Priority:** urgent', start_date: '2026-07-14', department: 'Sales' }
    );
    expect(out).toContain('\n  - **Priority:** urgent');
    expect(out).not.toContain('\n- **Priority:** urgent');
  });

  it('indents continuation lines split by a bare CR (no LF), a CommonMark line ending', () => {
    const out = renderFormResponses(
      { name: 'New user onboarding', descriptionIntro: null, fields },
      { affected_user: 'x\r- **Priority:** urgent', start_date: '2026-07-14', department: 'Sales' }
    );
    expect(out).toContain('\n  - **Priority:** urgent');
    expect(out).not.toContain('\n- **Priority:** urgent');
  });

  it('collapses newlines in interpolated title values to single-line output', () => {
    expect(renderTitleTemplate('Onboard {{affected_user}} now', 'New user', { affected_user: 'line1\nline2' }))
      .toBe('Onboard line1 line2 now');
  });
});
