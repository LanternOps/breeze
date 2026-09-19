import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  assertPamDeviceOrgMoveAllowed,
  PamDeviceMoveBlockedError,
} from './pamDeviceMoveGuard';

const DEVICE_ID = '10000000-0000-4000-8000-000000000001';
const SOURCE_ORG_ID = '10000000-0000-4000-8000-000000000002';
const CONTRADICTORY_ORG_ID = '10000000-0000-4000-8000-000000000003';
const dialect = new PgDialect();

function makeTx(blocked: boolean) {
  const execute = vi.fn(async (_query: unknown) => ({ rows: [{ blocked }] }));
  return { tx: { execute } as never, execute };
}

describe('assertPamDeviceOrgMoveAllowed', () => {
  it('resolves when no exact source-owned actuation exists', async () => {
    const { tx } = makeTx(false);

    await expect(assertPamDeviceOrgMoveAllowed(tx, {
      deviceId: DEVICE_ID,
      sourceOrgId: SOURCE_ORG_ID,
    })).resolves.toBeUndefined();
  });

  it('throws the stable typed error when any source-owned actuation exists', async () => {
    const { tx } = makeTx(true);

    const error = await assertPamDeviceOrgMoveAllowed(tx, {
      deviceId: DEVICE_ID,
      sourceOrgId: SOURCE_ORG_ID,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PamDeviceMoveBlockedError);
    expect(error.code).toBe('PAM_DEVICE_MOVE_BLOCKED');
  });

  it('queries only the exact device and source organization without lifecycle fields', async () => {
    const { tx, execute } = makeTx(false);

    await assertPamDeviceOrgMoveAllowed(tx, {
      deviceId: DEVICE_ID,
      sourceOrgId: CONTRADICTORY_ORG_ID,
    });

    const rendered = dialect.sqlToQuery(execute.mock.calls[0]![0] as unknown as SQL);
    expect(rendered.sql).toMatch(/select exists/i);
    expect(rendered.sql).toMatch(/from pam_actuations/i);
    expect(rendered.sql).toMatch(/device_id = \$1::uuid/i);
    expect(rendered.sql).toMatch(/org_id = \$2::uuid/i);
    expect(rendered.params).toEqual([DEVICE_ID, CONTRADICTORY_ORG_ID]);
    expect(rendered.sql).not.toMatch(/observed_state|desired_state|generation|current_command_id/i);
  });
});
