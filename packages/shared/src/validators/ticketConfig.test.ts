import { describe, it, expect } from 'vitest';
import {
  coreTicketStatusSchema,
  ticketPrioritySchema,
  createTicketStatusSchema,
  updateTicketStatusSchema,
  reorderTicketStatusesSchema,
  prioritySettingsSchema,
  orgTicketSettingsSchema
} from './ticketConfig';

const UUID = '3f2f1d8e-1111-4222-8333-444455556666';
const UUID2 = '3f2f1d8e-1111-4222-8333-444455556667';

describe('coreTicketStatusSchema', () => {
  it('accepts all six core statuses', () => {
    for (const s of ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed']) {
      expect(coreTicketStatusSchema.safeParse(s).success).toBe(true);
    }
  });
  it('rejects junk values', () => {
    expect(coreTicketStatusSchema.safeParse('archived').success).toBe(false);
    expect(coreTicketStatusSchema.safeParse('').success).toBe(false);
    expect(coreTicketStatusSchema.safeParse(5).success).toBe(false);
  });
});

describe('ticketPrioritySchema', () => {
  it('accepts the four priorities', () => {
    for (const p of ['low', 'normal', 'high', 'urgent']) {
      expect(ticketPrioritySchema.safeParse(p).success).toBe(true);
    }
  });
  it('rejects junk', () => {
    expect(ticketPrioritySchema.safeParse('critical').success).toBe(false);
  });
});

describe('hexColor (via createTicketStatusSchema.color)', () => {
  const base = { name: 'Triage', coreStatus: 'open' as const };
  it('accepts a 6-digit hex value', () => {
    expect(createTicketStatusSchema.safeParse({ ...base, color: '#1a2b3c' }).success).toBe(true);
    expect(createTicketStatusSchema.safeParse({ ...base, color: '#ABCDEF' }).success).toBe(true);
  });
  it('rejects shorthand #fff', () => {
    expect(createTicketStatusSchema.safeParse({ ...base, color: '#fff' }).success).toBe(false);
  });
  it('rejects a named color', () => {
    expect(createTicketStatusSchema.safeParse({ ...base, color: 'red' }).success).toBe(false);
  });
  it('rejects a hex missing the leading #', () => {
    expect(createTicketStatusSchema.safeParse({ ...base, color: '1a2b3c' }).success).toBe(false);
  });
  it('accepts null and omitted', () => {
    expect(createTicketStatusSchema.safeParse({ ...base, color: null }).success).toBe(true);
    expect(createTicketStatusSchema.safeParse({ ...base }).success).toBe(true);
  });
});

describe('slaMinutes bounds', () => {
  // Tested through orgTicketSettingsSchema.slaOverrides + a direct priority field.
  const wrap = (responseMinutes: unknown) =>
    orgTicketSettingsSchema.safeParse({ slaOverrides: { high: { responseMinutes } } });
  it('accepts 0', () => expect(wrap(0).success).toBe(true));
  it('accepts 525600 (one year)', () => expect(wrap(525_600).success).toBe(true));
  it('accepts null', () => expect(wrap(null).success).toBe(true));
  it('rejects 525601 (over a year)', () => expect(wrap(525_601).success).toBe(false));
  it('rejects -1', () => expect(wrap(-1).success).toBe(false));
  it('rejects 1.5 (non-integer)', () => expect(wrap(1.5).success).toBe(false));

  it('also enforces bounds on priority settings responseSlaMinutes', () => {
    const ok = prioritySettingsSchema.safeParse({ priorities: { high: { responseSlaMinutes: 60 } } });
    expect(ok.success).toBe(true);
    const bad = prioritySettingsSchema.safeParse({ priorities: { high: { responseSlaMinutes: -5 } } });
    expect(bad.success).toBe(false);
    const badFloat = prioritySettingsSchema.safeParse({ priorities: { high: { resolutionSlaMinutes: 2.2 } } });
    expect(badFloat.success).toBe(false);
  });
});

describe('createTicketStatusSchema', () => {
  it('trims and requires name (min 1)', () => {
    const r = createTicketStatusSchema.safeParse({ name: '  Triage  ', coreStatus: 'open' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe('Triage');
    expect(createTicketStatusSchema.safeParse({ name: '   ', coreStatus: 'open' }).success).toBe(false);
  });
  it('enforces max 60 on name', () => {
    expect(createTicketStatusSchema.safeParse({ name: 'a'.repeat(61), coreStatus: 'open' }).success).toBe(false);
    expect(createTicketStatusSchema.safeParse({ name: 'a'.repeat(60), coreStatus: 'open' }).success).toBe(true);
  });
  it('requires coreStatus', () => {
    expect(createTicketStatusSchema.safeParse({ name: 'Triage' }).success).toBe(false);
  });
  it('rejects negative sortOrder', () => {
    expect(createTicketStatusSchema.safeParse({ name: 'Triage', coreStatus: 'open', sortOrder: -1 }).success).toBe(false);
    expect(createTicketStatusSchema.safeParse({ name: 'Triage', coreStatus: 'open', sortOrder: 0 }).success).toBe(true);
  });
});

describe('updateTicketStatusSchema', () => {
  it('rejects an empty object', () => {
    const r = updateTicketStatusSchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toBe('At least one field is required');
  });
  it('accepts a single-field patch', () => {
    expect(updateTicketStatusSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(updateTicketStatusSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});

describe('reorderTicketStatusesSchema', () => {
  it('rejects duplicate ids', () => {
    expect(reorderTicketStatusesSchema.safeParse({ ids: [UUID, UUID] }).success).toBe(false);
  });
  it('requires at least one id', () => {
    expect(reorderTicketStatusesSchema.safeParse({ ids: [] }).success).toBe(false);
  });
  it('rejects more than 200 ids', () => {
    const many = Array.from({ length: 201 }, (_, i) => `3f2f1d8e-1111-4222-8333-${String(i).padStart(12, '0')}`);
    expect(reorderTicketStatusesSchema.safeParse({ ids: many }).success).toBe(false);
  });
  it('rejects non-uuid ids', () => {
    expect(reorderTicketStatusesSchema.safeParse({ ids: ['not-a-uuid'] }).success).toBe(false);
  });
  it('accepts a unique uuid list', () => {
    expect(reorderTicketStatusesSchema.safeParse({ ids: [UUID, UUID2] }).success).toBe(true);
  });
});

describe('prioritySettingsSchema', () => {
  it('accepts a partial priority record', () => {
    const r = prioritySettingsSchema.safeParse({
      priorities: { urgent: { label: 'Urgent', responseSlaMinutes: 15, resolutionSlaMinutes: 240 } }
    });
    expect(r.success).toBe(true);
  });
  it('accepts label null and omitted sla', () => {
    expect(prioritySettingsSchema.safeParse({ priorities: { low: { label: null } } }).success).toBe(true);
  });
});

describe('orgTicketSettingsSchema', () => {
  it('rejects an empty object', () => {
    expect(orgTicketSettingsSchema.safeParse({}).success).toBe(false);
  });
  it('accepts defaultHourlyRate null', () => {
    expect(orgTicketSettingsSchema.safeParse({ defaultHourlyRate: null }).success).toBe(true);
  });
  it('rejects a negative rate', () => {
    expect(orgTicketSettingsSchema.safeParse({ defaultHourlyRate: -1 }).success).toBe(false);
  });
  it('rejects a 3-decimal rate (multipleOf 0.01)', () => {
    expect(orgTicketSettingsSchema.safeParse({ defaultHourlyRate: 10.001 }).success).toBe(false);
    expect(orgTicketSettingsSchema.safeParse({ defaultHourlyRate: 10.5 }).success).toBe(true);
  });
  it('accepts defaultBillable boolean and slaOverrides', () => {
    expect(orgTicketSettingsSchema.safeParse({ defaultBillable: true }).success).toBe(true);
    expect(orgTicketSettingsSchema.safeParse({ slaOverrides: { normal: { resolutionMinutes: 480 } } }).success).toBe(true);
  });
});
