import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock('../../db', () => ({ db: { execute: executeMock } }));

import { reconcileDeviceLinks } from './links';

const ORG = '11111111-1111-4111-8111-111111111111';

function compiled(call: number): { sql: string; params: unknown[] } {
  const out = new PgDialect().sqlToQuery(executeMock.mock.calls[call]![0] as never);
  return { sql: out.sql, params: out.params };
}

beforeEach(() => {
  vi.clearAllMocks();
  executeMock
    .mockResolvedValueOnce([{ linked: 3, released: 0, ambiguous: 1 }])
    .mockResolvedValueOnce([{ linked: 2 }]);
});

// Shape/statement-count proof only; m365SyncLinks.integration.test.ts is the
// behavioural proof of the SQL against real Postgres.
describe('reconcileDeviceLinks', () => {
  it('issues exactly two statements, serial then hostname, and reports their counts', async () => {
    await expect(reconcileDeviceLinks(ORG)).resolves.toEqual({ linkedBySerial: 3, linkedByHostname: 2, ambiguous: 1 });
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(compiled(0).sql).toContain('device_hardware');
    expect(compiled(1).sql).toContain('hostname');
  });

  it('binds the org id on every statement', async () => {
    await reconcileDeviceLinks(ORG);
    for (const call of [0, 1]) expect(compiled(call).params).toContain(ORG);
  });

  it('re-links rows whose link no longer matches, not only unlinked rows', async () => {
    await reconcileDeviceLinks(ORG);
    expect(compiled(0).sql).toContain('is distinct from m.device_id');
  });

  it('restricts the hostname pass to rows still unlinked after the serial pass', async () => {
    await reconcileDeviceLinks(ORG);
    expect(compiled(1).sql).toContain('i.breeze_device_id is null');
  });

  it('excludes decommissioned and ephemeral Breeze devices from both passes', async () => {
    await reconcileDeviceLinks(ORG);
    for (const call of [0, 1]) {
      expect(compiled(call).sql).toContain("d.status <> 'decommissioned'");
      expect(compiled(call).sql).toContain('d.is_ephemeral = false');
    }
  });

  it('never writes last_changed_at or core_hash', async () => {
    await reconcileDeviceLinks(ORG);
    for (const call of [0, 1]) {
      expect(compiled(call).sql).not.toContain('last_changed_at');
      expect(compiled(call).sql).not.toContain('core_hash');
    }
  });

  it('reports zero rather than throwing when a statement returns no row', async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValue([]);
    await expect(reconcileDeviceLinks(ORG)).resolves.toEqual({
      linkedBySerial: 0, linkedByHostname: 0, ambiguous: 0,
    });
  });
});
