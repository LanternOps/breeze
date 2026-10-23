/**
 * Recipe readiness: `ready | setup_required | unavailable`, the named missing
 * capabilities, and the per-provider degradation map (Recipe Library spec
 * §4.1, §6.5, D-R1-12; W06 R1a Task 8).
 *
 * Computed from ROWS only — connection status, observed Graph grants (M1's
 * `m365RoleReadiness`), Google connection health, and the effective agent's
 * tool allowlist — on every call. Spec §12: "a cached catalog is never
 * authority".
 *
 * THE RULE, stated once:
 *  - flag off (tasks or the recipe's own) → `unavailable`, no gaps reported;
 *  - every provider connection the recipe declares is unusable → `unavailable`;
 *  - otherwise `setup_required` iff some `tenant_fixable` capability is
 *    unsatisfied, else `ready`. `always_manual` gaps (the three pre-M2
 *    Exchange capabilities) are reported in `alwaysManualCapabilities` and
 *    never change the state.
 *
 * DEGRADATION is the same for both partitions: a tool is degraded when its
 * provider's connection is unusable, when a non-agent capability that names
 * it is unsatisfied, or when the agent's allowlist does not admit it. A
 * degraded tool is frozen out of the plan at `discover` and becomes a manual
 * item; an approver is never asked to authorize an effect that can only fail.
 *
 * A Graph connection whose grants were never verified (`grantsVerifiedAt`
 * null) reports every role false (M1's rule), so every Graph effect degrades.
 * That is deliberately stricter than the write ladder's fall-through: an
 * offboarding plan is built ahead of time, and "Graph might answer" is not a
 * fact an approval can rest on.
 */
import { and, eq } from 'drizzle-orm';
import {
  M365_PERMISSION_PROFILES,
  M365_WRITE_ACTION_REQUIRED_ROLES,
  type CanonicalAppRoleAssignment,
  type M365ExecutorActionId,
} from '@breeze/shared/m365';
import type {
  AiAgentKind,
  AiOperatorCapabilityActionDto,
  AiOperatorMissingCapabilityDto,
  AiOperatorRecipeReadinessState,
  AiOperatorWorkflowDto,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema/m365';
import { googleWorkspaceConnections } from '../../db/schema/google';
import type { AuthContext } from '../../middleware/auth';
import { callerVerificationEnabled } from '../../config/env';
import { m365RoleReadiness } from '../m365ControlPlane/grantReadiness';
import { M365_HEADLESS_ACTIONS } from '../m365ToolsHeadless';
import { isToolAllowlisted } from '../aiAgents/toolAllowlist';
import { resolveEffectiveAgent, resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';
import { RECIPES } from './recipes';
import { recipeEnabled } from './taskService';
import type { AnyRecipeDefinition, CapabilityRequirement } from './recipes/types';

/** The M365 connection profile write effects execute under. */
const M365_ACTIONS_PROFILE = 'customer-graph-actions' as const;

/**
 * The agent kind each recipe's tasks are delegated to. `service_recovery` is
 * the triage agent's lane (routes/aiOperatorTasks.ts, #7015);
 * `identity_offboarding` runs under the helpdesk agent (spec §6.8 / D3 — no
 * new agent kind). Admission pins the effective agent of this kind.
 */
export const RECIPE_AGENT_KINDS: Readonly<Record<string, AiAgentKind>> = Object.freeze({
  service_recovery: 'triage',
  identity_offboarding: 'helpdesk',
});

/** Library-card copy, per recipe. */
const RECIPE_COPY: Readonly<Record<string, { name: string; summary: string }>> = Object.freeze({
  service_recovery: {
    name: 'Restore a stopped service',
    summary: 'Investigate a stopped Windows service, restart it with approval, and verify it stays up.',
  },
  identity_offboarding: {
    name: 'Offboard a person',
    summary: 'Confirm who is leaving, route their mail, remove their access across Microsoft 365 and Google Workspace '
      + 'in a safe order with one approval, and track the hand work on the ticket.',
  },
});

export interface ReadinessInputs {
  orgId: string;
  m365: {
    status: string;
    permissionManifestVersion: number;
    observedGrants: readonly CanonicalAppRoleAssignment[];
    grantsVerifiedAt: Date | null;
  } | null;
  google: { status: string; lastVerifiedAt: Date | null } | null;
  /** The org's EFFECTIVE agent of the recipe's kind; null when none is enabled. */
  agent: { id: string; kind: string; toolAllowlist: readonly string[] } | null;
  flagEnabled: boolean;
  /**
   * Caller-gated tools (`CALLER_GATED_TOOLS`) this org's caller-verification
   * policy would refuse to the Operator: a mint of one throws
   * `CallerVerificationRequiredError`, so it can only fail. Absent = none.
   */
  callerVerificationBlocked?: readonly string[];
}

export interface RecipeReadiness {
  recipeKey: string;
  recipeVersion: number;
  readiness: AiOperatorRecipeReadinessState;
  /** capability key → satisfied. Every requirement of the recipe appears. */
  capabilityReadiness: Readonly<Record<string, boolean>>;
  /** Unsatisfied `tenant_fixable` capabilities — the ONLY driver of `setup_required`. */
  missing: AiOperatorMissingCapabilityDto[];
  /** Unsatisfied `always_manual` capabilities — reported, never blocking. */
  alwaysManualCapabilities: AiOperatorMissingCapabilityDto[];
  manualStepCount: number;
  /** Effect tools NOT dispatchable for this org; each becomes human work. */
  degradedEffects: string[];
  /** The subset of `degradedEffects` held back by caller verification (not a setup gap). */
  callerVerificationBlocked: string[];
  agentId: string | null;
  agentKind: string | null;
}

function providerUsable(inputs: ReadinessInputs, provider: CapabilityRequirement['provider']): boolean {
  if (provider === 'm365') return inputs.m365?.status === 'active';
  if (provider === 'google') return inputs.google?.status === 'active';
  return true;
}

function m365ActionFor(tool: string): M365ExecutorActionId | null {
  return Object.hasOwn(M365_HEADLESS_ACTIONS, tool) ? M365_HEADLESS_ACTIONS[tool]! : null;
}

function allowlisted(inputs: ReadinessInputs, tool: string): boolean {
  return inputs.agent !== null && isToolAllowlisted(inputs.agent.toolAllowlist, tool);
}

function satisfied(cap: CapabilityRequirement, inputs: ReadinessInputs, roles: Readonly<Record<string, boolean>>): boolean {
  const tools = cap.toolNames ?? [];
  switch (cap.kind) {
    case 'provider_connection':
      return providerUsable(inputs, cap.provider);
    case 'permission_grant': {
      if (!providerUsable(inputs, cap.provider)) return false;
      if (cap.provider !== 'm365') return false; // no other provider has observable grants
      return tools.length > 0 && tools.every((tool) => {
        const actionId = m365ActionFor(tool);
        if (!actionId) return false; // fail closed: a tool with no known roles is never ready
        return (M365_WRITE_ACTION_REQUIRED_ROLES[actionId] ?? ['__unknown__']).every((role) => roles[role] === true);
      });
    }
    case 'tool_source':
      // No executor exists for any declared tool source in this wave (spec §7.3).
      return false;
    case 'agent_tool':
      return providerUsable(inputs, cap.provider) && tools.every((tool) => allowlisted(inputs, tool));
    default:
      return false;
  }
}

function actionFor(cap: CapabilityRequirement, inputs: ReadinessInputs): AiOperatorCapabilityActionDto {
  const none = { href: null, toolNames: [] as string[], agentId: null };
  switch (cap.kind) {
    case 'provider_connection':
      return { ...none, kind: cap.provider === 'google' ? 'connect_google' : cap.provider === 'm365' ? 'connect_m365' : 'none' };
    case 'permission_grant':
      return { ...none, kind: 'reconsent_m365' };
    case 'agent_tool':
      return {
        kind: 'add_agent_tools',
        href: null,
        toolNames: (cap.toolNames ?? []).filter((t) => !allowlisted(inputs, t)),
        agentId: inputs.agent?.id ?? null,
      };
    default:
      return { ...none, kind: 'none' };
  }
}

function toDto(cap: CapabilityRequirement, inputs: ReadinessInputs): AiOperatorMissingCapabilityDto {
  return {
    key: cap.key,
    kind: cap.kind,
    provider: cap.provider,
    detail: cap.detail,
    degradesToHumanWork: cap.kind !== 'provider_connection',
    availability: cap.availability ?? 'tenant_fixable',
    action: actionFor(cap, inputs),
  };
}

/** PURE — the whole rule, testable without a database. */
export function computeRecipeReadiness(recipe: AnyRecipeDefinition, inputs: ReadinessInputs): RecipeReadiness {
  const roles = inputs.m365
    ? m365RoleReadiness(
      {
        permissionManifestVersion: inputs.m365.permissionManifestVersion,
        grantsVerifiedAt: inputs.m365.grantsVerifiedAt,
        observedGrants: inputs.m365.observedGrants,
      },
      M365_PERMISSION_PROFILES[M365_ACTIONS_PROFILE],
    )
    : {};

  const capabilityReadiness: Record<string, boolean> = {};
  for (const cap of recipe.requires) capabilityReadiness[cap.key] = satisfied(cap, inputs, roles);

  const base = {
    recipeKey: recipe.key,
    recipeVersion: recipe.version,
    capabilityReadiness,
    agentId: inputs.agent?.id ?? null,
    agentKind: inputs.agent?.kind ?? null,
  };
  if (!inputs.flagEnabled) {
    // A disabled recipe reports no gaps: its capability list is not a hint
    // about an unshipped feature.
    return {
      ...base, readiness: 'unavailable', missing: [], alwaysManualCapabilities: [], manualStepCount: 0,
      degradedEffects: [], callerVerificationBlocked: [],
    };
  }

  // One partition, computed once, so the two lists cannot drift.
  const unsatisfied = recipe.requires.filter((c) => !capabilityReadiness[c.key]);
  const missing = unsatisfied.filter((c) => (c.availability ?? 'tenant_fixable') === 'tenant_fixable');
  const alwaysManual = unsatisfied.filter((c) => c.availability === 'always_manual');

  const providerCaps = recipe.requires.filter((c) => c.kind === 'provider_connection');
  const noUsableProvider = providerCaps.length > 0 && providerCaps.every((c) => !capabilityReadiness[c.key]);

  // Degradation, per tool.
  const tools = new Set(recipe.requires.flatMap((c) => c.toolNames ?? []));
  // Caller verification is a POLICY choice, not a setup gap: it degrades the
  // tool to human work but never changes the badge (default policies require
  // tier 2, so every org would otherwise read "setup required" forever).
  const callerBlocked = new Set((inputs.callerVerificationBlocked ?? []).filter((t) => tools.has(t)));
  const degradedEffects = [...tools].filter((tool) => {
    if (callerBlocked.has(tool)) return true;
    const naming = recipe.requires.filter((c) => (c.toolNames ?? []).includes(tool));
    const providers = new Set(naming.map((c) => c.provider).filter((p) => p !== null));
    for (const p of providers) {
      const conn = providerCaps.find((c) => c.provider === p);
      if (conn && !capabilityReadiness[conn.key]) return true;
    }
    if (naming.some((c) => c.kind !== 'agent_tool' && !capabilityReadiness[c.key])) return true;
    if (naming.some((c) => c.kind === 'agent_tool') && !allowlisted(inputs, tool)) return true;
    return false;
  }).sort();

  const readiness: AiOperatorRecipeReadinessState = noUsableProvider
    ? 'unavailable'
    : missing.length > 0 ? 'setup_required' : 'ready';

  return {
    ...base,
    readiness,
    missing: missing.map((c) => toDto(c, inputs)),
    alwaysManualCapabilities: alwaysManual.map((c) => toDto(c, inputs)),
    manualStepCount: alwaysManual.length,
    degradedEffects,
    callerVerificationBlocked: [...callerBlocked].sort(),
  };
}

/**
 * Which caller-gated tools the Operator could NOT mint for this org. The gate
 * (`callerVerification/gate.ts`) refuses everything when the feature is off,
 * and otherwise requires a verified caller unless the action's tier is 0 —
 * an Operator plan has no caller to verify. Read in system scope: the
 * partner-level policy row must be visible.
 */
export async function loadCallerVerificationBlocked(orgId: string): Promise<string[]> {
  const { CALLER_GATED_TOOLS, callerAction } = await import('../actionIntents/callerTarget');
  if (!callerVerificationEnabled()) return [...CALLER_GATED_TOOLS];
  const { getEffectivePolicy } = await import('../callerVerification/policy');
  const policy = await runOutsideDbContext(() => withSystemDbAccessContext(() => getEffectivePolicy(orgId)));
  return CALLER_GATED_TOOLS.filter((tool) => {
    const action = callerAction(tool);
    const tier = action === 'reset_password' ? policy.requiredTierResetPassword : policy.requiredTierDisableUser;
    return tier !== 0;
  });
}

/** Effect tool names that are NOT dispatchable for this org and must become human work. */
export function degradedEffectTools(readiness: RecipeReadiness): string[] {
  return [...readiness.degradedEffects];
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

type Reader = typeof db;

async function loadConnections(dbh: Reader, orgId: string): Promise<Pick<ReadinessInputs, 'm365' | 'google'>> {
  const [m365] = await dbh
    .select({
      status: m365Connections.status,
      permissionManifestVersion: m365Connections.permissionManifestVersion,
      observedGrants: m365Connections.observedGrants,
      grantsVerifiedAt: m365Connections.grantsVerifiedAt,
    })
    .from(m365Connections)
    .where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.profile, M365_ACTIONS_PROFILE)))
    .limit(1);
  const [google] = await dbh
    .select({ status: googleWorkspaceConnections.status, lastVerifiedAt: googleWorkspaceConnections.lastVerifiedAt })
    .from(googleWorkspaceConnections)
    .where(eq(googleWorkspaceConnections.orgId, orgId))
    .limit(1);
  return {
    m365: m365
      ? { ...m365, observedGrants: Array.isArray(m365.observedGrants) ? m365.observedGrants : [] }
      : null,
    google: google ?? null,
  };
}

function agentFrom(resolved: Awaited<ReturnType<typeof resolveEffectiveAgentSystem>>): ReadinessInputs['agent'] {
  if (!resolved || !resolved.effective.enabled) return null;
  return { id: resolved.agentId, kind: resolved.kind, toolAllowlist: resolved.effective.toolAllowlist ?? [] };
}

/**
 * Readiness for ONE recipe in system scope — the coordinator's path
 * (`discover` freezes it; `effects` re-checks it as a veto). Every read is
 * pinned to `orgId` by an explicit predicate. I/O errors THROW so the
 * coordinator's wake retries; they are never read as "not ready".
 */
export async function computeRecipeReadinessSystem(
  orgId: string,
  recipe: AnyRecipeDefinition,
  opts: { ignoreFlag?: boolean } = {},
): Promise<RecipeReadiness> {
  const kind = Object.hasOwn(RECIPE_AGENT_KINDS, recipe.key) ? RECIPE_AGENT_KINDS[recipe.key]! : null;
  const [connections, resolved, callerVerificationBlocked] = await Promise.all([
    runOutsideDbContext(() => withSystemDbAccessContext(() => loadConnections(db, orgId))),
    kind ? resolveEffectiveAgentSystem(orgId, kind) : Promise.resolve(null),
    loadCallerVerificationBlocked(orgId),
  ]);
  // The coordinator passes `ignoreFlag`: a recipe flag turned off mid-task
  // fences NEW admissions, never the capability facts of a running task — and
  // a flag-off readiness reports nothing degraded, which must never be read
  // as "everything is dispatchable".
  return computeRecipeReadiness(recipe, {
    orgId, ...connections, agent: agentFrom(resolved), callerVerificationBlocked,
    flagEnabled: opts.ignoreFlag === true || recipeEnabled(recipe.key),
  });
}

/**
 * The I/O half for the Library route: load the rows in the CALLER's db
 * context (RLS-scoped) and compute readiness for every registered recipe.
 * The caller has already checked `auth.canAccessOrg(orgId)`.
 */
export async function listWorkflowReadiness(orgId: string, auth: AuthContext): Promise<RecipeReadiness[]> {
  const connections = await loadConnections(db, orgId);
  const callerVerificationBlocked = await loadCallerVerificationBlocked(orgId);
  const out: RecipeReadiness[] = [];
  for (const key of Object.keys(RECIPES).sort()) {
    const recipe = RECIPES[key]!;
    const kind = Object.hasOwn(RECIPE_AGENT_KINDS, key) ? RECIPE_AGENT_KINDS[key]! : null;
    const resolved = kind ? await resolveEffectiveAgent(auth, orgId, kind) : null;
    out.push(computeRecipeReadiness(recipe, {
      orgId, ...connections, agent: agentFrom(resolved), callerVerificationBlocked, flagEnabled: recipeEnabled(key),
    }));
  }
  return out;
}

/** The Library DTO for one recipe's readiness. */
export function toWorkflowDto(readiness: RecipeReadiness): AiOperatorWorkflowDto {
  const recipe = RECIPES[readiness.recipeKey]!;
  const copy = RECIPE_COPY[readiness.recipeKey] ?? { name: readiness.recipeKey, summary: '' };
  return {
    recipeKey: readiness.recipeKey,
    recipeVersion: readiness.recipeVersion,
    name: copy.name,
    summary: copy.summary,
    gateClass: recipe.gateClass,
    targetKinds: [...recipe.targetKinds],
    readiness: readiness.readiness,
    missingCapabilities: readiness.missing,
    alwaysManualCapabilities: readiness.alwaysManualCapabilities,
    manualStepCount: readiness.manualStepCount,
    degradedEffects: readiness.degradedEffects,
    agentId: readiness.agentId,
    agentKind: readiness.agentKind,
  };
}
