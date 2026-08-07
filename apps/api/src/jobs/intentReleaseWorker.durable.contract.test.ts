/**
 * Durable-executable contract (2026-08-05 tier3-supervised-four-eyes design,
 * task 9): a `four_eyes` intent's whole reason for existing is to survive
 * past the requesting chat session — a second `approvals:decide` holder may
 * decide it minutes or (for mcp_api) up to a day later, long after the
 * inline session that created it is gone. If the tool is ALSO
 * `session_required` (no headless dispatch path — services/aiTools.ts's
 * requiresLiveSession, minus the Google/M365 headless carve-outs), the
 * durable release worker (jobs/intentReleaseWorker.ts) can never execute it:
 * the approval could be granted and just sit there forever.
 *
 * No vi.mock — like aiGuardrails.approvalScope.contract.test.ts, this needs
 * the REAL registries on both sides (the tier-3 classification tables AND
 * the worker's session-required predicate) to be a meaningful contract.
 */
import { describe, it, expect } from 'vitest';
import {
  TIER3_FOUR_EYES_ACTIONS, TIER3_FOUR_EYES_TOOLS,
  TIER3_INPUT_AWARE_ACTIONS, TIER3_INPUT_AWARE_TOOLS,
} from '../services/aiGuardrails';
import { isSessionRequiredForRelease } from './intentReleaseWorker';

describe('durable release: four_eyes tools must not be session_required', () => {
  // Deliberately a SUPERSET of "definitely four_eyes": the input-aware tools
  // (s1_isolate_device) and the tool half of the input-aware pairs
  // (manage_organizations, via update_org) resolve four_eyes on SOME inputs
  // at runtime but are invisible to the static TIER3_FOUR_EYES_TOOLS /
  // TIER3_FOUR_EYES_ACTIONS tables by construction (that's the whole point
  // of pulling them out into TIER3_INPUT_AWARE_* — see resolveApprovalScope).
  // Folding them in here is still correct because this assertion is about
  // session-requirement, which is a property of the TOOL, not the scope it
  // resolves to on a given call — a false positive (a tool that's never
  // actually four_eyes) only makes the check stricter than required, never
  // wrong; omitting a true one would make it silently blind.
  const fourEyesTools = Array.from(
    new Set<string>([
      ...TIER3_FOUR_EYES_TOOLS,
      ...Object.keys(TIER3_FOUR_EYES_ACTIONS),
      ...TIER3_INPUT_AWARE_TOOLS,
      ...[...TIER3_INPUT_AWARE_ACTIONS].map((pair) => pair.split(':')[0] ?? pair),
    ]),
  );

  it('has at least one tool to check (guards against an accidentally-empty fixture)', () => {
    expect(fourEyesTools.length).toBeGreaterThan(0);
  });

  it('every four_eyes-classified tool is durably releasable', () => {
    const sessionRequired = fourEyesTools.filter((tool) => isSessionRequiredForRelease(tool));
    expect(
      sessionRequired,
      `these four_eyes tools require a live chat session and can never be released by the ` +
        `durable worker once approved — either give them a headless dispatch path or move ` +
        `them off four_eyes: ${sessionRequired.join(', ')}`,
    ).toEqual([]);
  });
});
