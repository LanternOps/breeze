// Deliberately DEPENDENCY-FREE.
//
// This is imported by the inline release path in services/aiAgentSdk.ts, whose
// tests `vi.mock('../db/schema')` with a PARTIAL mock. Widening that module's
// import graph — even transitively, even by one symbol — breaks them with
// "No <x> export is defined on the mock". Keep this module a leaf: no schema,
// no db, no service imports. (flows/toolNames.ts is a leaf too.)
import { isFlowToolName } from '../flows/toolNames';

/**
 * Tools that must be released ONLY by the durable worker, never claimed and
 * executed inline by a live chat session.
 *
 * Why this exists: an approved intent has TWO possible releasers — the durable
 * worker (jobs/intentReleaseWorker.ts) and the live chat session
 * (services/aiAgentSdk.ts), which race for the `approved -> executing` CAS.
 * They run DIFFERENT code: the worker dispatches through the headless mappers,
 * while the inline path calls the ordinary tool handler under the live
 * session's auth. Both re-prove authorization identically, so this is not an
 * authz hole — but any guarantee that lives in the headless/executor transport
 * (content-to-effect digest binding, pinned credential bindings, executor-side
 * revalidation) simply DOES NOT APPLY on the inline path.
 *
 * So: a tool whose safety depends on that transport must never take the
 * inline shortcut. Listing it here makes the session decline the CAS entirely
 * and leave the intent for the worker. The cost is latency on an action that
 * already waited for a human approval — i.e. nothing that matters.
 *
 * This is the mirror of `requiresLiveSession` above: that marks tools which
 * can ONLY run inline; this marks tools which must NEVER run inline.
 *
 * Empty today. The M365 communications send tools are its first members
 * (design docs/superpowers/specs/integrations/2026-07-28-breeze-m365-communications-delegated-design.md
 * §0.a); a parity test pins membership so a transport-bound tool cannot be
 * added without landing here.
 */
export const DURABLE_RELEASE_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([]);

/**
 * True iff `toolName` must be released by the durable worker only. Callers on
 * the inline release path MUST check this BEFORE attempting the
 * `approved -> executing` CAS — checking after would already have claimed the
 * intent, and releasing the claim is not something the inline path can do
 * safely once won.
 *
 * W5 PR C (#5220): every FLOW tool (`flow__<slug>`, dynamic, so not a set
 * member) is durable-release-only too. Its release starts a run with the
 * APPROVER as the triggerer and the approved publication pinned on the insert
 * (`services/flows/flowToolRelease.ts`, called by the worker's flow-tool
 * branch); the inline path would run the SDK handler under the live session
 * instead. `flows/toolNames.ts` is itself a leaf (no imports).
 */
export function requiresDurableRelease(toolName: string): boolean {
  return DURABLE_RELEASE_ONLY_TOOLS.has(toolName) || isFlowToolName(toolName);
}

