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
  return !isStandingInstructionLapsed(c, now);
}

/**
 * The one expiry rule for a standing instruction (#11630): it lapses at its
 * `until` instant, and an `until` that cannot be parsed counts as lapsed. The
 * enforcement gate, `isEnforceableDeny`, the session prompt and the memory
 * page's expired marker all call this, so they cannot disagree.
 */
export function isStandingInstructionLapsed(c: { until: string | null }, now: Date): boolean {
  return c.until !== null && !(Date.parse(c.until) > now.getTime());
}

/**
 * Block-level form for readers holding a raw memory block (content is
 * untyped jsonb there). Only a `standing_instruction` with a string `until`
 * can lapse; content that does not carry one is never judged expired here
 * (the gate treats unreadable content as a warning, not as lapsed).
 */
export function isMemoryBlockLapsed(
  block: { blockType: string; content: Record<string, unknown> },
  now: Date,
): boolean {
  if (block.blockType !== 'standing_instruction') return false;
  const until = block.content.until;
  // Fail visible: an unparseable `until` is corrupt content the gate warns on
  // (schema failure), so it stays in the prompt and is not shown as expired.
  return typeof until === 'string' && Number.isFinite(Date.parse(until)) && isStandingInstructionLapsed({ until }, now);
}

/**
 * #11614: the rule a clause states, without its wording (subject, effect,
 * verb, condition and end time), so one thread never keeps the same rule
 * twice because the extractor phrased it differently on a later turn.
 * `standingInstructionSubjectKey` hashes the wording, so it cannot see this.
 * The subject is the resolved device, or for a note the named targets.
 *
 * null when the rule cannot be compared safely: no verb (two different
 * "don't touch X" rules would collide) or a note naming no target.
 */
export function standingInstructionRuleKey(
  c: Pick<StandingInstructionContent, 'effect' | 'verb' | 'deviceId' | 'condition' | 'until' | 'targetLabels'>,
): string | null {
  if (c.verb === null) return null;
  const norm = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const labels = [...new Set(c.targetLabels.map(norm).filter((l) => l !== ''))].sort();
  if (c.deviceId === null && labels.length === 0) return null;
  const subject = c.deviceId !== null ? ['device', c.deviceId] : ['note', ...labels];
  const until = c.until === null ? null : Date.parse(c.until);
  return JSON.stringify([subject, c.effect, c.verb, c.condition === null ? null : norm(c.condition), until]);
}
