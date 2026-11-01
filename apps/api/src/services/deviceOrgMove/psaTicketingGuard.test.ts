import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DeviceOrgMoveTx } from './moveDeviceOrgInTransaction';
import { detachPsaMappingsForDeviceMove, PsaTicketingMoveBlockedError } from './psaTicketingGuard';

const deviceId = '11111111-1111-4111-8111-111111111111';
const targetOrgId = '22222222-2222-4222-8222-222222222222';

describe('PSA ticketing device move guard', () => {
  it('returns a stable refusal when locked mappings still owe remote work', async () => {
    const execute = vi.fn().mockResolvedValue([{ openMappings: 1 }]);
    await expect(detachPsaMappingsForDeviceMove({ execute } as unknown as DeviceOrgMoveTx, deviceId, targetOrgId))
      .rejects.toThrow(PsaTicketingMoveBlockedError);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('locks only mappings crossing a partner and retains site-owned alert mappings', async () => {
    const execute = vi.fn().mockResolvedValue([{ openMappings: 0 }]);
    await detachPsaMappingsForDeviceMove({ execute } as unknown as DeviceOrgMoveTx, deviceId, targetOrgId);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toContain('FOR UPDATE OF m');
    expect(query.sql).toContain('c.partner_id IS DISTINCT FROM');
    expect(query.sql).toContain('topology_site_id IS NULL');
    expect(query.sql).toContain('AND NOT EXISTS (SELECT 1 FROM open_mappings)');
    expect(query.params.slice(0, 3)).toEqual([deviceId, deviceId, targetOrgId]);
    expect(query.params).toEqual(expect.arrayContaining([
      'create_in_flight', 'create_outcome_unknown', 'needs_attention', 'created',
      'pending', 'in_flight', 'outcome_unknown', 'closed',
    ]));
  });
});
