/**
 * Vendor update run history for one device (#11065 W04). Its own route and shape
 * rather than `PATCH_COMMAND_TYPES`: a run is not a patch (spec 4.7).
 *
 * The caller passes `scope`, the access-checked device's current-org condition
 * (routes/devices/commandOrgScope.ts). A row with no stamp is left out on top of
 * that: the seam stamps every run, so an unstamped one says nothing about whose it
 * was, and it is not worth showing an actor from someone else's tenure to find out.
 */
import { and, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { OemOutcome, OemUpdateRunResult } from '@breeze/shared';
import { db } from '../../db';
import { deviceCommands, users } from '../../db/schema';
import { oemRunCommandFilter } from './dispatch';
import { parseStoredOemResult } from './storedResult';

export type OemRunRow = {
  id: string;
  status: string;
  payload: unknown;
  result: unknown;
  createdAt: Date;
  completedAt: Date | null;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
};

export type OemRunView = {
  commandId: string;
  trigger: 'scheduled' | 'on_demand' | null;
  status: string;
  /** Null when the run has not reported, or what it reported could not be read. */
  outcome: OemOutcome | null;
  errorCode: string | null;
  toolVersion: string | null;
  rebootRequired: boolean;
  /** Whether the tech chose reboot when finished. Null when the row cannot say. */
  rebootControlled: boolean | null;
  items: OemUpdateRunResult['items'];
  skippedCategories: OemUpdateRunResult['skippedCategories'];
  createdAt: Date;
  completedAt: Date | null;
  actor: { id: string; name: string | null; email: string | null } | null;
};

/** Vendor tool output is untrusted: a result that fails the contract shows as no result. */
export function normalizeOemRun(row: OemRunRow): OemRunView {
  const result = parseStoredOemResult(row.result);
  const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as {
    trigger?: unknown;
    rebootControlled?: unknown;
  };
  return {
    commandId: row.id,
    trigger: payload.trigger === 'scheduled' || payload.trigger === 'on_demand' ? payload.trigger : null,
    status: row.status,
    outcome: result?.outcome ?? null,
    errorCode: result?.errorCode ?? null,
    toolVersion: result?.toolVersion ?? null,
    rebootRequired: result?.rebootRequired ?? false,
    rebootControlled: typeof payload.rebootControlled === 'boolean' ? payload.rebootControlled : null,
    items: result?.items ?? [],
    skippedCategories: result?.skippedCategories ?? [],
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    actor: row.actorId ? { id: row.actorId, name: row.actorName, email: row.actorEmail } : null,
  };
}

export async function listOemRuns(input: {
  deviceId: string;
  scope: SQL;
  limit: number;
  offset: number;
}): Promise<{ runs: OemRunView[]; total: number }> {
  const where = and(
    eq(deviceCommands.deviceId, input.deviceId),
    oemRunCommandFilter(),
    isNotNull(deviceCommands.submittedOrgId),
    input.scope,
  );

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(deviceCommands)
    .where(where);

  const rows = await db
    .select({
      id: deviceCommands.id,
      status: deviceCommands.status,
      payload: deviceCommands.payload,
      result: deviceCommands.result,
      createdAt: deviceCommands.createdAt,
      completedAt: deviceCommands.completedAt,
      actorId: users.id,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(deviceCommands)
    .leftJoin(users, eq(deviceCommands.createdBy, users.id))
    .where(where)
    .orderBy(desc(deviceCommands.createdAt), desc(deviceCommands.id))
    .limit(input.limit)
    .offset(input.offset);

  return { runs: rows.map(normalizeOemRun), total: counted?.total ?? 0 };
}
