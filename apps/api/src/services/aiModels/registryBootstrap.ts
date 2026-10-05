/**
 * Registry-native partner bootstrap (AI model registry W08, #7606).
 *
 * Replaces the W02 legacy projection behind W03's per-partner gate
 * (registryCutover.ts → ensurePartnerCutover). A partner gets its registry rows
 * exactly once, in the same transaction that inserts its
 * ai_model_registry_partner_cutover row: one offering of the platform default
 * model and a partner-level `default` assignment for every surface. Nothing
 * here reads a legacy table or column.
 *
 * Destination (spec §9.1, §10 — funding never moves implicitly): a partner that
 * already owns exactly one live (not soft-disconnected) anthropic_byok/catalog
 * connection is bootstrapped onto it. That happens only on a deployment whose
 * W02 migration copied a legacy key but which never ran W03's cutover (it
 * upgraded straight past R0); the caller reports it. More than one such
 * connection fails closed (no defaults). Everyone else starts on the platform.
 * patch_test always stays on the platform key (#5557).
 *
 * Default model (spec §11): on self-host ANTHROPIC_MODEL when set; otherwise
 * the operator's is_platform_default row, else the code fallback. A missing
 * platform row is created ONLY for the self-hosted ANTHROPIC_MODEL id, at the
 * documented conservative rate — never on hosted (spec §15 #3: no guessed rate).
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  AI_SURFACES,
  ANTHROPIC_API_CONNECTION_KINDS,
  type AiSurface,
  type AnthropicApiConnectionKind,
  type ModelRates,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { aiModelAssignments, aiPlatformModels, partnerAiConnections, partnerAiModels } from '../../db/schema';
import { isHosted } from '../../config/env';
import { resolveDefaultModel } from '../aiModel';

/** Documented self-host rate for an ANTHROPIC_MODEL the registry does not list (deploy/environment.mdx): Opus-tier $5/$25 per MTok, an over-estimate, never $0. */
export const ENV_DEFAULT_MODEL_BOOTSTRAP_RATES: Readonly<ModelRates> = Object.freeze({
  inputCentsPerM: 500,
  outputCentsPerM: 2500,
  cacheReadCentsPerM: 50,
  cacheWriteCentsPerM: 625,
});

/** Surfaces whose techs may pick among permitted models from day one (W02 projection values). */
const USER_CHOICE_SURFACES: ReadonlySet<AiSurface> = new Set<AiSurface>(['chat']);
/** Never moved onto a partner connection (legacy: patch tests always use the platform key, #5557). */
const PLATFORM_PINNED: ReadonlySet<AiSurface> = new Set<AiSurface>(['patch_test']);

export interface BootstrapPlanInput {
  modelId: string;
  platformRow: { id: string; created: boolean } | null;
  /** The partner's live Anthropic API connections (soft-disconnected rows excluded by the caller). */
  connections: ReadonlyArray<{ id: string; kind: AnthropicApiConnectionKind }>;
}

export interface BootstrapPlan {
  /** 'ambiguous': more than one Anthropic connection and no registry row yet — fail closed, never pick one, never fall back to platform funding. */
  destination: 'platform' | 'connection' | 'ambiguous';
  connectionOffering: null | {
    connectionId: string;
    source: 'discovered' | 'manual' | 'catalog';
    platformModelId: string | null;
    enabled: boolean;
  };
  assignments: Array<{ surface: AiSurface; target: 'platform' | 'connection' | null; allowUserChoice: boolean }>;
}

export interface BootstrapReport {
  destination: 'platform' | 'connection' | 'ambiguous';
  connectionId: string | null;
  defaultModelId: string;
  /** The offering the non-pinned surfaces point at; null when nothing could be offered. */
  offeringId: string | null;
  platformOfferingId: string | null;
  assignmentsCreated: number;
  createdPlatformRow: boolean;
}

/** Pure: what the bootstrap writes for a partner. */
export function planBootstrap(input: BootstrapPlanInput): BootstrapPlan {
  if (input.connections.length > 1) {
    // Unreachable through the app (connections are created only after the gate),
    // but if it happens, choosing one connection or the platform would both move
    // funding implicitly. Every non-pinned surface gets no default instead.
    return {
      destination: 'ambiguous',
      connectionOffering: null,
      assignments: AI_SURFACES.map((surface) => ({
        surface,
        target: PLATFORM_PINNED.has(surface) && input.platformRow ? 'platform' as const : null,
        allowUserChoice: USER_CHOICE_SURFACES.has(surface),
      })),
    };
  }
  const connection = input.connections.length === 1 ? input.connections[0]! : null;
  const connectionOffering = connection === null ? null : connection.kind === 'catalog'
    ? { connectionId: connection.id, source: 'catalog' as const, platformModelId: null, enabled: true }
    : input.platformRow
      ? { connectionId: connection.id, source: 'discovered' as const, platformModelId: input.platformRow.id, enabled: true }
      // No platform row to inherit a price from, and no guessed rate: the admin prices and enables it.
      : { connectionId: connection.id, source: 'manual' as const, platformModelId: null, enabled: false };
  const platformTarget = input.platformRow ? 'platform' as const : null;
  return {
    destination: connection ? 'connection' : 'platform',
    connectionOffering,
    assignments: AI_SURFACES.map((surface) => ({
      surface,
      target: connection && !PLATFORM_PINNED.has(surface) ? 'connection' as const : platformTarget,
      allowUserChoice: USER_CHOICE_SURFACES.has(surface),
    })),
  };
}

/** Pure: may `modelId` create a GLOBAL ai_platform_models row? Only the self-hosted deployment's own ANTHROPIC_MODEL. */
export function mayCreateEnvPlatformModel(modelId: string, opts: { hosted: boolean; env: NodeJS.ProcessEnv }): boolean {
  const envModel = opts.env.ANTHROPIC_MODEL?.trim();
  return !opts.hosted && Boolean(envModel) && modelId === envModel;
}

function assertSystemContext(): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('registryBootstrap requires a held system DB context');
  }
}

/**
 * Pure. Self-host: ANTHROPIC_MODEL when set (the operator's backend may serve
 * nothing else, #1412). Hosted: never the env — the operator's /admin/ai-models
 * default is the authority (spec §11: env vars are only a fresh-self-host
 * bootstrap). Then the is_platform_default row, then the code fallback.
 */
export function pickBootstrapDefaultModelId(input: {
  hosted: boolean; env: NodeJS.ProcessEnv; platformDefaultModelId: string | null;
}): string {
  const override = input.env.ANTHROPIC_MODEL?.trim();
  if (!input.hosted && override) return override;
  return input.platformDefaultModelId ?? resolveDefaultModel(input.hosted ? {} : input.env);
}

/** Reads the is_platform_default row on the ambient connection. */
export async function resolveBootstrapDefaultModelId(
  opts: { hosted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const [row] = await db.select({ modelId: aiPlatformModels.modelId }).from(aiPlatformModels)
    .where(eq(aiPlatformModels.isPlatformDefault, true)).limit(1);
  return pickBootstrapDefaultModelId({
    hosted: opts.hosted ?? isHosted(), env: opts.env ?? process.env, platformDefaultModelId: row?.modelId ?? null,
  });
}

/**
 * The platform row for `modelId`. Creates it (offered, at the bootstrap rate)
 * only when mayCreateEnvPlatformModel allows; an existing row is never touched
 * (ON CONFLICT DO NOTHING), so seeded and operator-edited rows win.
 */
export async function ensurePlatformModelRow(
  modelId: string,
  opts: { hosted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ id: string; created: boolean } | null> {
  const find = async () => (await db.select({ id: aiPlatformModels.id }).from(aiPlatformModels)
    .where(eq(aiPlatformModels.modelId, modelId)).limit(1))[0];
  const existing = await find();
  if (existing) return { id: existing.id, created: false };
  if (!mayCreateEnvPlatformModel(modelId, { hosted: opts.hosted ?? isHosted(), env: opts.env ?? process.env })) return null;
  const r = ENV_DEFAULT_MODEL_BOOTSTRAP_RATES;
  await db.execute(sql`
    INSERT INTO ai_platform_models (provider, model_id, display_name, platform_offered, is_platform_default, lifecycle,
                                    input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m)
    VALUES ('anthropic', ${modelId}, ${modelId}, true, false, 'available',
            ${r.inputCentsPerM}, ${r.outputCentsPerM}, ${r.cacheReadCentsPerM}, ${r.cacheWriteCentsPerM})
    ON CONFLICT (model_id) DO NOTHING`);
  const created = await find();
  if (!created) throw new Error('registryBootstrap: could not create the env default platform model row');
  return { id: created.id, created: true };
}

/**
 * Writes the partner's registry rows. Runs inside withPartnerCutoverTx's system
 * transaction (it never opens, commits or rolls back one), so a throw leaves the
 * partner un-rowed and the next request retries. Existing rows are never
 * overwritten: offerings are enabled if present, assignments are insert-if-absent.
 */
export async function bootstrapPartnerRegistryInTx(
  partnerId: string,
  deps: { defaultModelId?: string; hosted?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<BootstrapReport> {
  assertSystemContext();
  const env = deps.env ?? process.env;
  const modelId = deps.defaultModelId ?? await resolveBootstrapDefaultModelId({ hosted: deps.hosted, env });
  const platformRow = await ensurePlatformModelRow(modelId, { hosted: deps.hosted, env });
  const connections = await db.select({ id: partnerAiConnections.id, kind: partnerAiConnections.kind })
    .from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, [...ANTHROPIC_API_CONNECTION_KINDS]),
      // A soft-disconnected row (#7700) is provenance only: keyless, its
      // offerings disabled. It is never a bootstrap destination.
      ne(partnerAiConnections.status, 'disconnected'),
    ))
    .orderBy(asc(partnerAiConnections.createdAt)) as Array<{ id: string; kind: AnthropicApiConnectionKind }>;
  const plan = planBootstrap({ modelId, platformRow, connections });

  let platformOfferingId: string | null = null;
  if (platformRow) {
    const [row] = await db.insert(partnerAiModels)
      .values({ partnerId, platformModelId: platformRow.id, source: 'platform', enabled: true })
      .onConflictDoUpdate({
        target: [partnerAiModels.partnerId, partnerAiModels.platformModelId],
        targetWhere: sql`connection_id IS NULL`,
        set: { enabled: true, updatedAt: new Date() },
      })
      .returning({ id: partnerAiModels.id });
    platformOfferingId = row!.id;
  }

  let connectionOfferingId: string | null = null;
  if (plan.connectionOffering) {
    const o = plan.connectionOffering;
    const [row] = await db.insert(partnerAiModels)
      .values({
        partnerId, connectionId: o.connectionId, modelId, source: o.source,
        platformModelId: o.platformModelId, enabled: o.enabled,
      })
      .onConflictDoUpdate({
        target: [partnerAiModels.connectionId, partnerAiModels.modelId],
        targetWhere: sql`connection_id IS NOT NULL`,
        set: { enabled: o.enabled, updatedAt: new Date() },
      })
      .returning({ id: partnerAiModels.id });
    connectionOfferingId = row!.id;
  }

  let assignmentsCreated = 0;
  for (const a of plan.assignments) {
    const defaultOfferingId = a.target === 'connection' ? connectionOfferingId : a.target === 'platform' ? platformOfferingId : null;
    const inserted = await db.insert(aiModelAssignments)
      .values({
        partnerId, orgId: null, offeringPartnerId: partnerId, surface: a.surface, role: 'default',
        defaultOfferingId, permittedOfferingIds: null, allowUserChoice: a.allowUserChoice,
        options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: false,
      })
      .onConflictDoNothing({
        target: [aiModelAssignments.partnerId, aiModelAssignments.surface, aiModelAssignments.role],
        where: sql`org_id IS NULL`,
      })
      .returning({ id: aiModelAssignments.id });
    assignmentsCreated += inserted.length;
  }

  return {
    destination: plan.destination,
    connectionId: plan.connectionOffering?.connectionId ?? null,
    defaultModelId: modelId,
    offeringId: plan.destination === 'connection' ? connectionOfferingId : plan.destination === 'platform' ? platformOfferingId : null,
    platformOfferingId,
    assignmentsCreated,
    createdPlatformRow: platformRow?.created ?? false,
  };
}
