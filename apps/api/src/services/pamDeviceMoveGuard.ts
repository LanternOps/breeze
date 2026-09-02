import { sql } from 'drizzle-orm';
import { db } from '../db';

export type PamDeviceMoveTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class PamDeviceMoveBlockedError extends Error {
  readonly code = 'PAM_DEVICE_MOVE_BLOCKED';

  constructor() {
    super('Device organization move is blocked by durable PAM lifecycle evidence');
    this.name = 'PamDeviceMoveBlockedError';
  }
}

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

export async function assertPamDeviceOrgMoveAllowed(
  tx: PamDeviceMoveTx,
  input: { deviceId: string; sourceOrgId: string },
): Promise<void> {
  const row = rows<{ blocked: boolean }>(await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1
      FROM pam_actuations
      WHERE device_id = ${input.deviceId}::uuid
        AND org_id = ${input.sourceOrgId}::uuid
    ) AS blocked
  `))[0];
  if (row?.blocked) throw new PamDeviceMoveBlockedError();
}
