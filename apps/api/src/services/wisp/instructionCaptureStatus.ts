/**
 * #10428 (W05): the short-lived status of one turn-end instruction capture.
 *
 * The prefilter runs before `done`; on a hit `done` carries a `captureId` and
 * the extraction runs after it. The chip polls this status until it is
 * terminal; a reload recovers the chips from the persisted blocks instead, so
 * the key only has to outlive the polling window (1 h).
 *
 * The value names the user and session the capture belongs to, so the status
 * route answers only the person who sent the message (404 otherwise).
 */
import {
  WISP_INSTRUCTION_CAPTURE_STATUSES,
  type WispInstructionCaptureStatus,
  type WispInstructionCaptureTerminalStatus,
} from '@breeze/shared';
import { getRedis } from '../redis';

export const INSTRUCTION_CAPTURE_STATUS_TTL_SECONDS = 3600;

export type InstructionCaptureRecord = { status: WispInstructionCaptureStatus; userId: string; sessionId: string };

export function instructionCaptureStatusKey(captureId: string): string {
  return `wisp:instr-capture:${captureId}`;
}

function encode(record: InstructionCaptureRecord): string {
  return JSON.stringify({ s: record.status, u: record.userId, sid: record.sessionId });
}

function decode(raw: string | null): InstructionCaptureRecord | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { s?: unknown; u?: unknown; sid?: unknown };
    if (typeof v.u !== 'string' || typeof v.sid !== 'string') return null;
    if (!(WISP_INSTRUCTION_CAPTURE_STATUSES as readonly unknown[]).includes(v.s)) return null;
    return { status: v.s as WispInstructionCaptureStatus, userId: v.u, sessionId: v.sid };
  } catch {
    return null;
  }
}

/**
 * Write the `pending` record. False when Redis is unavailable: the caller then
 * starts no capture at all (nothing could report it, and the extractor's daily
 * cap fails closed without Redis anyway). A Redis error propagates.
 */
export async function beginInstructionCapture(input: { captureId: string; userId: string; sessionId: string }): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  const ok = await redis.set(
    instructionCaptureStatusKey(input.captureId),
    encode({ status: 'pending', userId: input.userId, sessionId: input.sessionId }),
    'EX', INSTRUCTION_CAPTURE_STATUS_TTL_SECONDS,
  );
  return ok === 'OK';
}

/**
 * Record the extractor's outcome, keeping the owner. Only `pending` moves: a
 * terminal status is final, and a missing record (expired, or Redis lost it)
 * stays missing.
 */
export async function finishInstructionCapture(captureId: string, status: WispInstructionCaptureTerminalStatus): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = instructionCaptureStatusKey(captureId);
  const current = decode(await redis.get(key));
  if (!current || current.status !== 'pending') return;
  await redis.set(key, encode({ ...current, status }), 'EX', INSTRUCTION_CAPTURE_STATUS_TTL_SECONDS);
}

/** The record, or null when it is unknown, expired, malformed, or Redis is unavailable. */
export async function readInstructionCapture(captureId: string): Promise<InstructionCaptureRecord | null> {
  const redis = getRedis();
  if (!redis) return null;
  return decode(await redis.get(instructionCaptureStatusKey(captureId)));
}
