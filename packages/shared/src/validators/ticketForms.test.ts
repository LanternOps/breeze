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
    const r = v.safeParse({ affected_user: 'jdoe@client.com', start_date: '2026-07-14', needs_vpn: true, license_count: 3, department: 'Sales' });
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
});

describe('coerceFormResponses', () => {
  it('coerces number strings, drops empty strings, passes booleans', () => {
    expect(coerceFormResponses(fields, { affected_user: 'x', license_count: '4', needs_vpn: false, department: '' }))
      .toEqual({ affected_user: 'x', license_count: 4, needs_vpn: false });
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
      { affected_user: 'jdoe@client.com', start_date: '2026-07-14', needs_vpn: true, department: 'Sales' }
    );
    expect(out).toContain('HR request.');
    expect(out).toContain('**New user onboarding** (form)');
    expect(out).toContain('- **Affected user:** jdoe@client.com');
    expect(out).toContain('- **Needs VPN:** Yes');
    expect(out).toContain('- **License count:** —');
  });
});
