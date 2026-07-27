import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { deviceCommands } from '../db/schema';
import { rearmIdempotentCommandForDelivery } from './commandQueue';
import type { DesktopSessionFinalizationInput } from './desktopSessionFinalization';

export type DesktopStopProof =
  | {
      state: 'confirmed';
      commandId: string;
      outcome: 'stopped' | 'already_absent';
    }
  | {
      state: 'pending';
      commandId: string;
      reason: 'agent_disconnected' | 'delivery_unacknowledged' | 'result_unavailable';
    };

type StopCommandRow = {
  id: string;
  deviceId: string;
  type: string;
  payload: unknown;
  status: string;
  targetRole: string;
  result: unknown;
};

function hasExactPayload(
  payload: unknown,
  input: DesktopSessionFinalizationInput,
): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const value = payload as Record<string, unknown>;
  return (
    value.sessionId === input.sessionId
    && value.finalizationId === input.finalizationId
    && Object.keys(value).length === 2
  );
}

function parseConfirmedStop(
  row: StopCommandRow,
  input: DesktopSessionFinalizationInput,
): DesktopStopProof | null {
  if (row.status !== 'completed') return null;
  if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result)) return null;
  const stored = row.result as Record<string, unknown>;
  if (stored.status !== 'completed' || typeof stored.stdout !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = parsed as Record<string, unknown>;
  if (
    result.sessionId !== input.sessionId
    || result.finalizationId !== input.finalizationId
    || (result.outcome !== 'stopped' && result.outcome !== 'already_absent')
  ) {
    return null;
  }
  return {
    state: 'confirmed',
    commandId: input.finalizationId,
    outcome: result.outcome,
  };
}

function assertExactCommand(
  row: StopCommandRow,
  input: DesktopSessionFinalizationInput,
): void {
  if (
    row.id !== input.finalizationId
    || row.deviceId !== input.deviceId
    || row.type !== 'desktop_stream_stop'
    || row.targetRole !== 'agent'
    || !hasExactPayload(row.payload, input)
  ) {
    throw new Error('desktop stream stop command identity conflict');
  }
}

export async function ensureDesktopStreamStopped(
  input: DesktopSessionFinalizationInput,
): Promise<DesktopStopProof> {
  const payload = {
    sessionId: input.sessionId,
    finalizationId: input.finalizationId,
  };

  const row = await withSystemDbAccessContext(async () => {
    await db
      .insert(deviceCommands)
      .values({
        id: input.finalizationId,
        deviceId: input.deviceId,
        type: 'desktop_stream_stop',
        payload,
        status: 'pending',
        targetRole: 'agent',
      })
      .onConflictDoNothing()
      .returning({ id: deviceCommands.id });

    const [selected] = await db
      .select()
      .from(deviceCommands)
      .where(eq(deviceCommands.id, input.finalizationId))
      .limit(1) as StopCommandRow[];

    if (!selected) {
      throw new Error('desktop stream stop command unavailable after insert');
    }
    return selected;
  });

  assertExactCommand(row, input);
  const confirmed = parseConfirmedStop(row, input);
  if (confirmed) return confirmed;

  const delivery = await rearmIdempotentCommandForDelivery({
    commandId: input.finalizationId,
    deviceId: input.deviceId,
    type: 'desktop_stream_stop',
    payload,
  });
  if (!delivery.delivered && delivery.reason === 'agent_disconnected') {
    return {
      state: 'pending',
      commandId: input.finalizationId,
      reason: 'agent_disconnected',
    };
  }
  return {
    state: 'pending',
    commandId: input.finalizationId,
    reason: row.result == null ? 'delivery_unacknowledged' : 'result_unavailable',
  };
}
