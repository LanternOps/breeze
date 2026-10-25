import { describe, expect, it } from 'vitest';
import { bulkTicketReplyParamsSchema } from './wispSpecialists';
import { bulkTicketReplyParamsSchema as fromBarrel } from './index';

const CONCERN = '11111111-1111-4111-8111-111111111111';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const valid = () => ({
  concernId: CONCERN,
  ticketIds: [uid(1), uid(2)],
  message: 'We are aware of the outage and are working on it.',
});

describe('bulkTicketReplyParamsSchema', () => {
  it('accepts a valid body and defaults holdTickets to false', () => {
    const r = bulkTicketReplyParamsSchema.safeParse(valid());
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ ...valid(), holdTickets: false });
  });

  it('accepts a null concernId, holdTickets and an internal note', () => {
    const r = bulkTicketReplyParamsSchema.safeParse({ ...valid(), concernId: null, holdTickets: true, internalNote: 'held for the outage' });
    expect(r.success).toBe(true);
    expect(r.data?.holdTickets).toBe(true);
  });

  it('is exported from the validators barrel', () => {
    expect(fromBarrel).toBe(bulkTicketReplyParamsSchema);
  });

  it('rejects duplicate ticket ids', () => {
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), ticketIds: [uid(1), uid(2), uid(1)] }).success).toBe(false);
  });

  it('rejects more than 250 ticket ids and accepts exactly 250', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => uid(i + 1));
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), ticketIds: ids(250) }).success).toBe(true);
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), ticketIds: ids(251) }).success).toBe(false);
  });

  it('rejects an empty ticket list, an empty message and an over-long message', () => {
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), ticketIds: [] }).success).toBe(false);
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), message: '' }).success).toBe(false);
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), message: 'x'.repeat(4001) }).success).toBe(false);
  });

  it('rejects an over-long internal note and non-uuid ids', () => {
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), internalNote: 'x'.repeat(1001) }).success).toBe(false);
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), ticketIds: ['not-a-uuid'] }).success).toBe(false);
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), concernId: 'nope' }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(bulkTicketReplyParamsSchema.safeParse({ ...valid(), orgId: uid(9) }).success).toBe(false);
  });

  it('requires concernId to be present (null, not omitted)', () => {
    const { concernId: _omit, ...rest } = valid();
    expect(bulkTicketReplyParamsSchema.safeParse(rest).success).toBe(false);
  });
});

describe('WISP_SPECIALIST_KINDS', () => {
  it('lists the six W07 specialist kinds and is exported from the barrel', async () => {
    const mod: Record<string, unknown> = await import('./wispSpecialists');
    const barrel: Record<string, unknown> = await import('./index');
    expect(mod.WISP_SPECIALIST_KINDS).toEqual([
      'sweep', 'analysis', 'operator_recipe', 'patch_plan', 'remediation_research', 'bulk_ticket_reply',
    ]);
    expect(barrel.WISP_SPECIALIST_KINDS).toBe(mod.WISP_SPECIALIST_KINDS);
  });
});
