/**
 * Topology M4 Task 3 (#6000): the per-turn, server-only buffer every topology
 * provider text fragment goes into INSTEAD of the session event bus.
 *
 * Output validation precedes persistence AND streaming (M4-D6): nothing a
 * model writes reaches SSE, the replay ring buffer, `ai_messages`, a title,
 * an audit row or the answer cache until `finish` has
 *   1. parsed the COMPLETE output against the strict schema and citation
 *      manifest (`validateTopologyAiExplanation`),
 *   2. re-checked the retained scope stamp against live rows
 *      (`assertTopologyAiCurrentScope` — a moved device refuses a current
 *      answer), and
 *   3. re-authorized every cited resource under the caller's CURRENT access
 *      (`reauthorizeTopologyAiCitations`), removing dependent text.
 * The raw buffer is erased on finish, discard, overflow and error. Bounds:
 * 64 KiB of text and 2,000 reported output tokens; past either, appends are
 * dropped and the turn ends in the fixed fallback — truncation never releases
 * partial JSON.
 */
import type { TopologyAiExplanation } from '@breeze/shared';
import type { TopologyRequestContext } from './access';
import { applyTopologyAiCitationAvailability, reauthorizeTopologyAiCitations, topologyAiFallbackExplanation, TOPOLOGY_AI_FALLBACK_REASON, validateTopologyAiExplanation } from './aiCitations';
import { assertTopologyAiCurrentScope, TopologyAiScopeChangedError, type TopologyAiEvidenceSnapshot } from './aiEvidence';

export const TOPOLOGY_AI_OUTPUT_MAX_BYTES = 64 * 1024;
export const TOPOLOGY_AI_OUTPUT_MAX_TOKENS = 2_000;

export type TopologyAiGateOutcome = 'explanation' | 'fallback' | 'scope_changed';
export type TopologyAiGateResult = { outcome: TopologyAiGateOutcome; explanation: TopologyAiExplanation };

export function topologyAiScopeChangedExplanation(): TopologyAiExplanation {
  return {
    schemaVersion: 1, status: 'evidence_changed', findings: [], nextChecks: [], citationIds: [], citations: [],
    missingData: ['The selected devices or links changed site or collection source; start a new investigation.'],
    reasons: ['investigation_scope_changed'],
  };
}

export class TopologyAiOutputGate {
  /** Text blocks of the current turn; the answer is the LAST non-empty one. */
  private blocks: string[][] = [[]];
  private bytes = 0;
  private outputTokens = 0;
  private overflow = false;
  private discarded = false;

  get bufferedBytes(): number { return this.bytes; }
  get overflowed(): boolean { return this.overflow; }

  /** Retain one provider text fragment (never published). Returns false once a bound is reached. */
  append(delta: string): boolean {
    if (this.discarded || this.overflow) return false;
    const size = Buffer.byteLength(delta, 'utf8');
    if (this.bytes + size > TOPOLOGY_AI_OUTPUT_MAX_BYTES) {
      this.overflow = true;
      this.erase();
      return false;
    }
    this.blocks[this.blocks.length - 1]!.push(delta);
    this.bytes += size;
    return true;
  }

  /**
   * A new provider text block began (text → tool_use → text). Earlier blocks
   * are narration; only the final block is parsed as the answer. Bytes of
   * every block still count toward the cap.
   */
  startBlock(): void {
    if (this.blocks[this.blocks.length - 1]!.length) this.blocks.push([]);
  }

  /** Record provider-reported output tokens; past the cap the turn can only end in the fallback. */
  noteOutputTokens(tokens: number): boolean {
    if (!Number.isFinite(tokens) || tokens < 0) return !this.overflow;
    this.outputTokens += tokens;
    if (this.outputTokens > TOPOLOGY_AI_OUTPUT_MAX_TOKENS) {
      this.overflow = true;
      this.erase();
      return false;
    }
    return true;
  }

  /** Erase unvalidated bytes (cancel, error, timeout, budget cap, selection change). */
  discard(): void {
    this.discarded = true;
    this.erase();
  }

  /**
   * Validate the complete answer and reauthorize it under `currentCtx` — a
   * context freshly returned by `requireTopologySiteAccess` at completion, not
   * the request's cached one. Always erases the raw buffer.
   */
  async finish(currentCtx: TopologyRequestContext, snapshot: TopologyAiEvidenceSnapshot): Promise<TopologyAiGateResult> {
    const raw = [...this.blocks].reverse().map((block) => block.join('')).find((text) => text.trim().length > 0) ?? '';
    const overflow = this.overflow;
    const discarded = this.discarded;
    this.erase();
    this.discarded = true;
    if (overflow) return { outcome: 'fallback', explanation: topologyAiFallbackExplanation('output_limit_reached') };
    if (discarded) return { outcome: 'fallback', explanation: topologyAiFallbackExplanation() };

    const validated = validateTopologyAiExplanation(raw, snapshot);
    try {
      await assertTopologyAiCurrentScope(currentCtx, snapshot.scopeStamp);
    } catch (error) {
      if (error instanceof TopologyAiScopeChangedError) return { outcome: 'scope_changed', explanation: topologyAiScopeChangedExplanation() };
      throw error;
    }
    if (validated.reasons.includes(TOPOLOGY_AI_FALLBACK_REASON)) return { outcome: 'fallback', explanation: validated };
    const availability = await reauthorizeTopologyAiCitations(currentCtx, validated.citationIds, snapshot);
    return { outcome: 'explanation', explanation: applyTopologyAiCitationAvailability(validated, availability, snapshot) };
  }

  private erase(): void {
    this.blocks = [[]];
    this.bytes = 0;
  }
}
