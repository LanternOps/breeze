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

describe('PAM ownership epoch transfer (W6, #8208)', () => {
  it('reads the env flag strictly: only true/1/on enable it', async () => {
    const { isPamEpochTransferEnvEnabled } = await import('./pamDeviceMoveGuard');
    for (const [value, expected] of [
      [undefined, false], ['', false], ['false', false], ['0', false], ['yes', false],
      ['true', true], ['1', true], ['on', true], [' TRUE ', true],
    ] as const) {
      expect(isPamEpochTransferEnvEnabled({ PAM_OWNERSHIP_EPOCH_TRANSFER: value }), String(value)).toBe(expected);
    }
  });

  it('resolves transfer only when BOTH the env flag and the database switch are on', async () => {
    const { resolvePamEpochTransfer } = await import('./pamDeviceMoveGuard');
    const dbOn = { execute: vi.fn(async (_q: unknown) => [{ enabled: true }]) };
    const dbOff = { execute: vi.fn(async (_q: unknown) => [{ enabled: false }]) };

    await expect(resolvePamEpochTransfer(dbOn as never, { PAM_OWNERSHIP_EPOCH_TRANSFER: 'true' })).resolves.toBe(true);
    await expect(resolvePamEpochTransfer(dbOff as never, { PAM_OWNERSHIP_EPOCH_TRANSFER: 'true' })).resolves.toBe(false);
    const untouched = { execute: vi.fn(async (_q: unknown) => [{ enabled: true }]) };
    await expect(resolvePamEpochTransfer(untouched as never, {})).resolves.toBe(false);
    // Env off never asks the database.
    expect(untouched.execute).not.toHaveBeenCalled();
    const rendered = dialect.sqlToQuery(dbOn.execute.mock.calls[0]![0] as unknown as SQL);
    expect(rendered.sql).toMatch(/breeze_pam_epoch_transfer_enabled\(\)/);
  });

  it('arms the cause GUC always and the transfer GUC only when transfer is on, transaction-local', async () => {
    const { armOwnershipChange } = await import('./pamDeviceMoveGuard');
    const execute = vi.fn(async (_q: unknown) => []);
    await armOwnershipChange({ execute } as never, 'device_move', false);
    let rendered = dialect.sqlToQuery(execute.mock.calls[0]![0] as unknown as SQL);
    expect(rendered.sql).toMatch(/set_config\('breeze\.ownership_change_cause', \$1, true\)/);
    expect(rendered.sql).toMatch(/set_config\('breeze\.pam_epoch_transfer', \$2, true\)/);
    expect(rendered.params).toEqual(['device_move', 'off']);

    execute.mockClear();
    await armOwnershipChange({ execute } as never, 'org_merge', true);
    rendered = dialect.sqlToQuery(execute.mock.calls[0]![0] as unknown as SQL);
    expect(rendered.params).toEqual(['org_merge', 'on']);
  });

  it('with transfer on refuses only a not-closed actuation, with PAM_DEVICE_MOVE_ACTIVE', async () => {
    const { PamDeviceMoveActiveError } = await import('./pamDeviceMoveGuard');
    const { tx, execute } = makeTx(true);
    const error = await assertPamDeviceOrgMoveAllowed(tx, {
      deviceId: DEVICE_ID,
      sourceOrgId: SOURCE_ORG_ID,
      transferEnabled: true,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(PamDeviceMoveActiveError);
    expect(error.code).toBe('PAM_DEVICE_MOVE_ACTIVE');
    const rendered = dialect.sqlToQuery(execute.mock.calls[0]![0] as unknown as SQL);
    expect(rendered.sql).toMatch(/not pam_actuation_is_closed\(a\)/i);
    expect(rendered.params).toEqual([DEVICE_ID, SOURCE_ORG_ID]);
  });

  it('with transfer on resolves when every departing actuation is closed', async () => {
    const { tx } = makeTx(false);
    await expect(assertPamDeviceOrgMoveAllowed(tx, {
      deviceId: DEVICE_ID,
      sourceOrgId: SOURCE_ORG_ID,
      transferEnabled: true,
    })).resolves.toBeUndefined();
  });

  it('fails closed (throws) when the precondition query returns no row, in both modes', async () => {
    for (const transferEnabled of [false, true]) {
      const tx = { execute: vi.fn(async (_q: unknown) => ({ rows: [] })) } as never;
      await expect(assertPamDeviceOrgMoveAllowed(tx, {
        deviceId: DEVICE_ID,
        sourceOrgId: SOURCE_ORG_ID,
        transferEnabled,
      })).rejects.toThrow(/returned no row/);
    }
  });

  it('OD4: expires pending un-actuated requests with reason ownership_changed and audits each', async () => {
    const { expireUnactuatedElevationRequests } = await import('./pamDeviceMoveGuard');
    const execute = vi.fn(async (_q: unknown) => [{ id: 'r1' }, { id: 'r2' }]);
    await expect(expireUnactuatedElevationRequests({ execute } as never, {
      orgId: SOURCE_ORG_ID,
      deviceId: DEVICE_ID,
    })).resolves.toBe(2);
    const rendered = dialect.sqlToQuery(execute.mock.calls[0]![0] as unknown as SQL);
    expect(rendered.sql).toMatch(/status in \('pending', 'approved', 'auto_approved', 'actuating'\)/i);
    expect(rendered.sql).toMatch(/not exists \(select 1 from pam_actuations a where a\.elevation_request_id = r\.id\)/i);
    expect(rendered.sql).toMatch(/insert into elevation_audit/i);
    expect(rendered.sql).toMatch(/'ownership_changed'/);
    expect(rendered.params).toEqual([SOURCE_ORG_ID, DEVICE_ID]);
  });

  it('OD4 for a merge scopes to the whole loser org (no device filter)', async () => {
    const { expireUnactuatedElevationRequests } = await import('./pamDeviceMoveGuard');
    const execute = vi.fn(async (_q: unknown) => []);
    await expect(expireUnactuatedElevationRequests({ execute } as never, { orgId: SOURCE_ORG_ID })).resolves.toBe(0);
    const rendered = dialect.sqlToQuery(execute.mock.calls[0]![0] as unknown as SQL);
    expect(rendered.sql).not.toMatch(/r\.device_id =/i);
    expect(rendered.params).toEqual([SOURCE_ORG_ID]);
  });
});
