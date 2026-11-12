/**
 * W06 (#7604): verify a gateway-kind offering (openai_compatible; W07's
 * cloud kinds) with the UNCHANGED W01 fidelity harness, run through the
 * loopback model gateway exactly as production traffic flows: the direct
 * stages via a gateway client, the Agent SDK stage via a child pointed at a
 * gateway grant (behind a deny-all CONNECT proxy).
 *
 * This is the ONLY producer of a gateway verification record, and that record
 * is what grants tool calling (gatewayCapabilities.verifiedGatewayCapabilities).
 * So:
 *  - Grants are purpose 'verification', org-less, bound to exactly the
 *    offering's wire model, and revoked when the run ends (any exit path).
 *  - The record is bound to the endpoint fingerprint the run started from and
 *    written through offeringVerificationStore (registry lock + superseded check).
 *  - A failed run stores a failed record (tools off); its summary is scrubbed
 *    of the upstream key and every grant token and capped at 200 chars. A run
 *    that could not happen (gateway / proxy setup or the harness threw) is
 *    captured and stored as a failed record with a fixed summary.
 *  - It writes capabilities only, never `enabled` (D5: verification never
 *    enables), and it is never triggered by discovery.
 *  - Token spend on the partner's endpoint is NOT ledgered (no org, no surface;
 *    Todd decision 2026-10-02) and no llm_egress_events row is written (org-scoped).
 *
 * #11393 W04 (#11397): after the basic stages PASS, one `surface_turn` per
 * tool surface the offering is assigned to (default, permitted or fallback on
 * an assignment row; chat first): the surface's own prompt and tool list under
 * the offering's tool exposure, answered by inert stubs (llm/surfaceTurnHarness).
 * Each turn runs on its own org-less verification grant (no window observer),
 * behind the same deny-all proxy, revoked when the turn ends. The verdicts are
 * stored per surface beside the basic record (surfaceReadiness.ts); a surface
 * turn never changes the basic verdict, and one that throws records nothing.
 * Spend is bounded per surface by SURFACE_TURN_MAX_TURNS requests and a
 * deadline, and per run by SURFACE_STAGE_BUDGET_MS.
 */
import { randomUUID } from 'node:crypto';
import { isGatewayConnectionKind, type AiSurface } from '@breeze/shared';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { getLlmEgressProxy } from '../llm/llmEgressProxy';
import { captureException } from '../sentry';
import {
  FIDELITY_HARNESS_VERSION,
  runFidelityCheck,
  type FidelityCheckResult,
} from '../llm/providerFidelityHarness';
import { createAnthropicClient } from './connectionFactory';
import { getConnection } from './connections';
import { getGatewayAdapter, type GatewayGrant } from './gateway';
import { takeGatewayFailure } from './gateway/failureNotes';
import type { KnownWindow } from './gateway/openai/contextWindow';
import type { SurfaceTurnInput, SurfaceTurnResult } from '../llm/surfaceTurnHarness';
import type { SurfaceTurnPlanResult } from '../llm/surfaceTurnStubs';
import { knownContextWindow, resolveEffectiveContextWindow } from './contextWindowFacts';
import {
  SURFACE_TURN_VERSION,
  readinessProfileKey,
  type SurfaceReadinessMap,
  type SurfaceReadinessOutcome,
  type ToolSurface,
} from './surfaceReadiness';
import { toolProfileFactsFrom, type ToolProfileFacts } from './toolProfileFacts';
import { GATEWAY_TOTAL_TIMEOUT_MS } from './gateway/limits';
import { GATEWAY_PLACEHOLDER_KEY } from './gateway/openai/adapter';
import { scrubSecrets } from './gateway/scrub';
import { endpointFingerprint, verifiedCapabilitiesTree, type GatewayVerificationRecord } from './gatewayCapabilities';
import { acquireModelGateway } from './gatewayConnectionState';
import { gatewayConfigFor, loadGatewayCredential } from './gatewayCandidate';
import { getOffering } from './offerings';
import { listOfferingToolSurfaces, writeOfferingVerification } from './offeringVerificationStore';
import { getPlatformModelById } from './platformModels';
import { CONNECTION_DISCONNECTED_MESSAGE, RegistryWriteError } from './registryWriteErrors';
import { buildGatewaySdkChildEnv } from './sdkChildEnv';

/** `superseded`: the connection changed (or a newer verdict landed) while the run was in flight; nothing was written. */
export type OfferingVerificationState = 'verified' | 'failed' | 'superseded';

export interface OfferingVerificationResult {
  offeringId: string;
  state: OfferingVerificationState;
  /**
   * 'superseded' because the connection's URL or key (config_version /
   * endpoint fingerprint) changed during the run while it stayed active — a
   * fresh run would verify the current connection. False for every other outcome.
   */
  connectionChanged: boolean;
  /** The record this run produced (scrubbed). Persisted unless `state` is 'superseded'. */
  record: GatewayVerificationRecord;
  /** #11397: what each surface turn did; 'refused' = the surface refuses this profile up front, so it was not run. */
  surfaceTurns: Array<{ surface: ToolSurface; state: SurfaceReadinessOutcome | 'refused'; summary: string | null }>;
}

/** The tool surfaces a verify can run a surface turn on, in run order (Office is not verified in v1). */
const VERIFIED_SURFACES = ['chat', 'helper', 'script_builder', 'ai_agents'] as const satisfies readonly ToolSurface[];
type VerifiedSurface = (typeof VERIFIED_SURFACES)[number];

/** The two halves of a surface turn (llm/surfaceTurnStubs + llm/surfaceTurnHarness), loaded lazily. */
export interface SurfaceTurnRunner {
  plan(surface: VerifiedSurface, facts: ToolProfileFacts): Promise<SurfaceTurnPlanResult>;
  run(input: SurfaceTurnInput): Promise<SurfaceTurnResult>;
}

export interface OfferingVerificationDeps {
  /** Test seam (integration suite): the harness. Defaults to runFidelityCheck. */
  runHarness?: typeof runFidelityCheck;
  /** Test seam: the surface turn. Defaults to the real planner + Agent SDK harness. */
  surfaceTurn?: SurfaceTurnRunner;
}

/** One surface turn: as long as the basic harness's SDK stage. */
export const SURFACE_TURN_DEADLINE_MS = 150_000;
/** Every surface turn of one run together (four surfaces at most). */
export const SURFACE_STAGE_BUDGET_MS = 480_000;
/** A turn is not started with less than this left of the stage budget. */
const SURFACE_TURN_MIN_MS = 15_000;

async function defaultSurfaceTurn(): Promise<SurfaceTurnRunner> {
  // Lazy: the planner loads the whole tool registry, which a verify that
  // never reaches the surface stage never needs.
  const [stubs, harness] = await Promise.all([import('../llm/surfaceTurnStubs'), import('../llm/surfaceTurnHarness')]);
  return {
    plan: async (surface, facts) => stubs.planSurfaceTurn(surface, facts),
    run: (input) => harness.runSurfaceTurn(input),
  };
}

const SUMMARY_MAX = 200;
/** Stored when the run itself could not happen; fixed text, so it can carry nothing secret. */
const COULD_NOT_RUN_SUMMARY = 'Verification could not run; try again.';
/** Each in-process request is capped by the harness (60 s, 1 retry); the child grant covers the whole run. */
const DIRECT_REQUEST_TIMEOUT_MS = 60_000;
const VERIFY_GRANT_TTL_MS = GATEWAY_TOTAL_TIMEOUT_MS;

const systemRead = <T>(fn: () => Promise<T>): Promise<T> => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const NOT_FOUND = 'Model not found.';
const NOT_GATEWAY = 'Only models on a BYO endpoint connection are verified here.';
const UNUSABLE = "This model's connection cannot be used right now.";

function unavailable(message: string): RegistryWriteError {
  return new RegistryWriteError(message, 'not_eligible', 409, { reason: 'connection_unavailable' });
}

/** Whether the kind's adapter carries Anthropic thinking (mirrors gatewayCandidate). openai_compatible drops it. */
function adapterCarriesThinking(kind: string): boolean {
  return kind !== 'openai_compatible';
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function proxyToken(proxyUrl: string): string | null {
  try {
    return decodeURIComponent(new URL(proxyUrl).password) || null;
  } catch {
    return null;
  }
}

function summarize(result: FidelityCheckResult, secrets: ReadonlyArray<string | null>): string | null {
  if (result.passed) return null;
  const first = result.steps.find((s) => !s.ok);
  return scrubSecrets(first ? `${first.name}: ${first.detail ?? 'failed'}` : 'verification failed', secrets, SUMMARY_MAX);
}

interface SurfaceStageContext {
  offeringId: string;
  partnerId: string;
  wireModel: string;
  facts: ToolProfileFacts;
  fingerprint: string;
  /** Issues one org-less verification grant for a surface turn. */
  issueSurfaceGrant(noteKey: string, compactSchemas: boolean): GatewayGrant;
  childEnvFor(grant: GatewayGrant): Record<string, string>;
  secrets: Array<string | null>;
  deps: OfferingVerificationDeps;
}

/**
 * The surface stage. Never throws: a surface whose plan or turn throws is
 * captured and records nothing (its stored entry stays as it was), and the
 * basic verdict is never touched.
 */
async function runSurfaceStage(ctx: SurfaceStageContext): Promise<{
  entries: SurfaceReadinessMap;
  turns: OfferingVerificationResult['surfaceTurns'];
}> {
  const entries: SurfaceReadinessMap = {};
  const turns: OfferingVerificationResult['surfaceTurns'] = [];
  let assigned: AiSurface[];
  try {
    assigned = await systemRead(() => listOfferingToolSurfaces(ctx.partnerId, ctx.offeringId));
  } catch {
    console.error(`[aiModels] offering ${ctx.offeringId}: could not list its tool surfaces; surface turns skipped`);
    captureException(new Error('Offering tool-surface listing failed'), undefined, { service: 'aiModels', stage: 'offering_surface_turn' });
    return { entries, turns };
  }
  const surfaces = VERIFIED_SURFACES.filter((s) => assigned.includes(s));
  if (surfaces.length === 0) return { entries, turns };

  let runner: SurfaceTurnRunner;
  try {
    runner = ctx.deps.surfaceTurn ?? await defaultSurfaceTurn();
  } catch (error) {
    captureException(new Error(`Surface turn could not load: ${scrubSecrets(describeError(error), ctx.secrets, SUMMARY_MAX)}`), undefined, { service: 'aiModels', stage: 'offering_surface_turn' });
    return { entries, turns };
  }
  const stageEnds = Date.now() + SURFACE_STAGE_BUDGET_MS;
  for (const surface of surfaces) {
    const remaining = stageEnds - Date.now();
    if (remaining < SURFACE_TURN_MIN_MS) break;
    let grant: GatewayGrant | null = null;
    try {
      const planned = await runner.plan(surface, ctx.facts);
      if (planned.kind === 'refused') {
        turns.push({ surface, state: 'refused', summary: planned.message });
        continue;
      }
      const { plan } = planned;
      const noteKey = randomUUID();
      grant = ctx.issueSurfaceGrant(noteKey, plan.compactSchemas);
      const result = await runner.run({
        plan,
        wireModel: ctx.wireModel,
        childEnv: ctx.childEnvFor(grant),
        deadlineMs: Math.min(SURFACE_TURN_DEADLINE_MS, remaining),
        gatewayFailure: () => takeGatewayFailure(noteKey),
      });
      const summary = result.outcome === 'passed' ? null : scrubSecrets(result.detail, ctx.secrets, SUMMARY_MAX);
      entries[surface] = {
        state: result.outcome,
        profileKey: readinessProfileKey(ctx.facts, surface),
        exposureFingerprint: plan.fingerprint,
        profile: plan.profile,
        endpointFingerprint: ctx.fingerprint,
        version: SURFACE_TURN_VERSION,
        at: new Date().toISOString(),
        promptTokens: result.promptTokens,
        cachedTokens: result.cachedTokens,
        summary,
      };
      turns.push({ surface, state: result.outcome, summary });
    } catch (error) {
      const scrubbed = new Error(`Surface turn (${surface}) could not run: ${scrubSecrets(describeError(error), ctx.secrets, SUMMARY_MAX)}`);
      console.error(`[aiModels] offering ${ctx.offeringId}: ${scrubbed.message}`);
      captureException(scrubbed, undefined, { service: 'aiModels', stage: 'offering_surface_turn' });
    } finally {
      grant?.revoke();
    }
  }
  return { entries, turns };
}

export async function verifyConnectionOffering(
  input: { offeringId: string; partnerId: string },
  deps: OfferingVerificationDeps = {},
): Promise<OfferingVerificationResult> {
  const runHarness = deps.runHarness ?? runFidelityCheck;

  const offering = await systemRead(() => getOffering(input.offeringId));
  if (!offering || offering.partnerId !== input.partnerId) throw new RegistryWriteError(NOT_FOUND, 'not_found', 404);
  if (!offering.connectionId || !offering.modelId) throw new RegistryWriteError(NOT_GATEWAY, 'not_gateway', 409);
  const connectionId = offering.connectionId;
  const wireModel = offering.modelId;

  const conn = await systemRead(() => getConnection(connectionId));
  if (!conn || conn.partnerId !== input.partnerId) throw new RegistryWriteError(NOT_FOUND, 'not_found', 404);
  if (!isGatewayConnectionKind(conn.kind)) throw new RegistryWriteError(NOT_GATEWAY, 'not_gateway', 409);
  // W03 soft-disconnect: provenance only, never verified (and never re-activated).
  if (conn.status !== 'active') throw unavailable(CONNECTION_DISCONNECTED_MESSAGE);
  const config = gatewayConfigFor(conn);
  if (!config) throw unavailable(UNUSABLE);
  // Re-reads status with the key: a disconnect landing now is never taken for "keyless".
  const credential = await loadGatewayCredential(conn);
  if (!credential) throw unavailable(UNUSABLE);

  const fingerprint = endpointFingerprint({ kind: conn.kind, baseUrl: conn.baseUrl, providerConfig: conn.providerConfig ?? null });
  const startedAt = new Date();
  const adapter = getGatewayAdapter(config.kind);
  const proxyKey = `verify-offering:${offering.id}:${randomUUID()}`;

  // Everything that must never appear in stored or returned text: the upstream
  // key and every grant / proxy token issued for this run.
  const secrets: Array<string | null> = [credential.secret];
  const grants: GatewayGrant[] = [];
  let proxy: Awaited<ReturnType<typeof getLlmEgressProxy>> | null = null;

  // Null when the run itself could not happen (gateway or proxy setup, or the
  // harness, threw): that is stored as a failed record with a fixed summary,
  // so the offering shows a verdict and tools stay off.
  let result: FidelityCheckResult | null = null;
  let surfaceStage: Awaited<ReturnType<typeof runSurfaceStage>> = { entries: {}, turns: [] };
  try {
    const gateway = await acquireModelGateway();
    proxy = await getLlmEgressProxy();
    const issueGrant = (): GatewayGrant => {
      const grant = gateway.grant({
        config,
        credential,
        wireModels: [wireModel],
        orgId: null,
        aiSessionId: null,
        purpose: 'verification',
        ttlMs: VERIFY_GRANT_TTL_MS,
      });
      grants.push(grant);
      secrets.push(grant.token);
      return grant;
    };
    // Deny-all, org-less: a stray child request is refused (nothing to persist without an org).
    const denied = proxy.grant(proxyKey, null, () => {});
    secrets.push(proxyToken(denied.proxyUrl));
    const child = issueGrant();
    const client = createAnthropicClient({
      apiKey: GATEWAY_PLACEHOLDER_KEY,
      // One fresh verification grant per HTTP request, revoked when it settles.
      target: { kind: 'gateway', dialect: 'anthropic', openGrant: async () => issueGrant() },
      timeout: DIRECT_REQUEST_TIMEOUT_MS,
      maxRetries: 1,
    });
    const childEnv = buildGatewaySdkChildEnv({
      adapterEnv: adapter.sdkChildEnv({ gatewayBaseUrl: child.baseUrl, config, wireModel }),
      denyProxyUrl: denied.proxyUrl,
    });
    result = await runHarness(
      { baseUrl: child.baseUrl, authMode: 'x-api-key', providerModel: wireModel, apiKey: GATEWAY_PLACEHOLDER_KEY },
      { client, childEnv, probeAdaptiveEffort: adapterCarriesThinking(config.kind) },
    );
    if (result.passed) {
      // The offering's facts as the resolver reads them (gatewayCandidate):
      // its profile, allow-list and effective window under this connection version.
      const window = resolveEffectiveContextWindow(offering, conn.configVersion);
      const known = knownContextWindow(window);
      surfaceStage = await runSurfaceStage({
        offeringId: offering.id,
        partnerId: input.partnerId,
        wireModel,
        facts: toolProfileFactsFrom(offering, 'gateway', window.value),
        fingerprint,
        issueSurfaceGrant: (noteKey, compactSchemas) => {
          const grant = gateway.grant({
            config,
            credential,
            wireModels: [wireModel],
            orgId: null,
            // Keys the gateway's failure note for this turn only (never a chat session).
            aiSessionId: noteKey,
            purpose: 'verification',
            ttlMs: VERIFY_GRANT_TTL_MS,
            compactSchemas,
            // Capped as a dispatch grant would be; no observers, so nothing is persisted.
            ...(known ? { knownWindows: new Map<string, KnownWindow>([[wireModel, known]]) } : {}),
          });
          grants.push(grant);
          secrets.push(grant.token);
          return grant;
        },
        childEnvFor: (grant) => buildGatewaySdkChildEnv({
          adapterEnv: adapter.sdkChildEnv({ gatewayBaseUrl: grant.baseUrl, config, wireModel }),
          denyProxyUrl: denied.proxyUrl,
        }),
        secrets,
        deps,
      });
    }
  } catch (error) {
    // Never let the error text carry the key or a grant/proxy token.
    const scrubbed = new Error(`Offering verification could not run: ${scrubSecrets(describeError(error), secrets, SUMMARY_MAX)}`);
    console.error(`[aiModels] offering ${offering.id}: ${scrubbed.message}`);
    captureException(scrubbed, undefined, { service: 'aiModels', stage: 'offering_verification' });
  } finally {
    for (const grant of grants) grant.revoke();
    proxy?.revoke(proxyKey);
  }

  const passed = result?.passed ?? false;
  const record: GatewayVerificationRecord = {
    harnessVersion: FIDELITY_HARNESS_VERSION,
    endpointFingerprint: fingerprint,
    at: new Date().toISOString(),
    passed,
    // Every harness step is a tool-calling step: passing IS verified tool use.
    toolUse: passed,
    adaptiveEffort: passed && (result?.verifiedCapabilities.adaptiveEffort ?? false),
    summary: result ? summarize(result, secrets) : COULD_NOT_RUN_SUMMARY,
  };
  credential.secret = null;

  // W07: a cloud offering linked to a platform row inherits that row's
  // thinking/effort subtree, only when the adaptive probe passed
  // (verifiedCapabilitiesTree enforces it). Never consulted otherwise.
  const thinkingSource = record.adaptiveEffort && offering.platformModelId
    ? (await systemRead(() => getPlatformModelById(offering.platformModelId!)))?.capabilities ?? null
    : null;

  const outcome = await writeOfferingVerification({
    partnerId: input.partnerId,
    offeringId: offering.id,
    connectionId,
    modelId: wireModel,
    configVersion: conn.configVersion,
    endpointFingerprint: fingerprint,
    startedAt,
    capabilities: verifiedCapabilitiesTree(record, thinkingSource),
    surfaceReadiness: surfaceStage.entries,
  });
  const state: OfferingVerificationState = outcome !== 'written' ? 'superseded' : passed ? 'verified' : 'failed';
  console.info(`[aiModels] offering ${offering.id} verification: ${state}`);
  return { offeringId: offering.id, state, connectionChanged: outcome === 'connection_changed', record, surfaceTurns: surfaceStage.turns };
}
