/**
 * Standing-instruction subject keys and enforceability (spec §5.3).
 *
 * The subject key carries clause identity: a capture with the same normalised
 * effect, verb, condition, until and text (the extractor's wording) supersedes
 * its own earlier unconfirmed copy, while two DIFFERENT clauses on
 * the same device+verb (e.g. "never reboot PC-01 during business hours" vs
 * "don't reboot PC-01 until Friday") get different keys and coexist, even
 * under the human confirm's same-key supersede.
 *
 * Only an unconditional, unexpired deny with a device and a verb is ever
 * enforceable; everything else is context only.
 */
import { createHash } from 'node:crypto';
import type { StandingInstructionContent } from '@breeze/shared';

export function standingInstructionClauseHash(
  c: Pick<StandingInstructionContent, 'effect' | 'verb' | 'condition' | 'until' | 'text'>,
): string {
  const material = [c.effect, c.verb ?? '', c.condition ?? '', c.until ?? '', c.text]
    .join('|')
    .normalize('NFKC')
    .toLowerCase();
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function standingInstructionSubjectKey(c: StandingInstructionContent): string {
  const hash = standingInstructionClauseHash(c);
  return c.deviceId !== null
    ? `device:${c.deviceId}:${c.verb ?? 'none'}:${hash}`
    : `instruction:${hash}`;
}

export function isEnforceableDeny(c: StandingInstructionContent, now: Date): boolean {
  if (c.effect !== 'deny' || c.verb === null || c.deviceId === null || c.condition !== null) return false;
  if (c.until === null) return true;
  return Date.parse(c.until) > now.getTime();
}
