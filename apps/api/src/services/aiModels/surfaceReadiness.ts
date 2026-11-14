/**
 * Per-surface tool readiness of a gateway offering (#11393 W04 T11): the
 * `surface_turn` verdicts, stored beside `breeze_verification` in
 * `partner_ai_models.capabilities.breeze_surface_readiness` (plan Decision
 * 2) and written only through `writeOfferingVerification`.
 *
 * An entry is CURRENT for a surface when it was recorded against the
 * connection's current endpoint fingerprint, at the current stage version,
 * and under the profile key the offering resolves to on that surface now
 * (`toolProfileKey` of its facts, `full` for the identity exposure). Only a
 * current `failed` entry refuses that surface (`tools_unverified_surface`).
 * Absent, stale and `inconclusive` entries refuse nothing, so every model
 * that works today keeps working until an operator re-verifies it and the
 * model fails the round trip on that exact surface and profile.
 *
 * The profile key, not the exposure fingerprint, binds the entry: eligibility
 * computes it from the offering's facts alone, without the tool registry.
 * The exposure fingerprint is stored for provenance (it is what the ledger's
 * `tool_exposure_fingerprint` carries). Pure; no I/O.
 */
import { z } from 'zod';
import { TOOL_REQUIRING_SURFACES, type AiSurface, type AiToolAllowlist, type AiToolProfile } from '@breeze/shared';
import { resolveEffectiveContextWindow, type ContextWindowFields } from './contextWindowFacts';
import { FULL_IDENTITY_FINGERPRINT, toolProfileKey, type ResolvedToolProfile } from './toolExposure';
import { toolProfileFactsFrom, type ToolProfileFacts } from './toolProfileFacts';

/** Bump when the `surface_turn` stage gets stricter: every entry at an older version reads as stale. */
export const SURFACE_TURN_VERSION = '1';
export const SURFACE_READINESS_KEY = 'breeze_surface_readiness';

export type ToolSurface = (typeof TOOL_REQUIRING_SURFACES)[number];
export type SurfaceReadinessOutcome = 'passed' | 'failed' | 'inconclusive';
export type SurfaceReadinessState = SurfaceReadinessOutcome | 'stale' | 'absent';

export interface SurfaceReadinessRecord {
  state: SurfaceReadinessOutcome;
  /** `readinessProfileKey(facts, surface)` when the turn ran. */
  profileKey: string;
  /** The exposure's fingerprint (provenance). */
  exposureFingerprint: string;
  profile: ResolvedToolProfile;
  endpointFingerprint: string;
  version: string;
  /** ISO time the turn finished. */
  at: string;
  promptTokens: number | null;
  cachedTokens: number | null;
  /** Scrubbed, ≤ 200 chars. */
  summary: string | null;
}

export type SurfaceReadinessMap = Partial<Record<ToolSurface, SurfaceReadinessRecord>>;

const recordSchema = z.object({
  state: z.enum(['passed', 'failed', 'inconclusive']),
  profileKey: z.string().min(1).max(64),
  exposureFingerprint: z.string().min(1).max(64),
  profile: z.enum(['full', 'standard', 'minimal', 'custom']),
  endpointFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.string().min(1).max(20),
  at: z.string().datetime(),
  promptTokens: z.number().int().nonnegative().nullable(),
  cachedTokens: z.number().int().nonnegative().nullable(),
  summary: z.string().max(200).nullable(),
}).strict();

/**
 * The surfaces whose new entry the reader would drop as malformed. Checked at
 * write time, so a writer/schema drift is reported instead of silently
 * turning every refusal off.
 */
export function invalidReadinessSurfaces(entries: SurfaceReadinessMap): ToolSurface[] {
  return (Object.entries(entries) as Array<[ToolSurface, unknown]>)
    .filter(([, entry]) => !recordSchema.safeParse(entry).success)
    .map(([surface]) => surface);
}

function isToolSurface(surface: string): surface is ToolSurface {
  return (TOOL_REQUIRING_SURFACES as readonly string[]).includes(surface);
}

/** The key an entry is bound to: the facts-level profile key, `full` for the identity exposure. */
export function readinessProfileKey(facts: ToolProfileFacts, surface: AiSurface): string {
  return toolProfileKey(facts, surface) ?? FULL_IDENTITY_FINGERPRINT;
}

/** The valid entries on a capabilities tree; a malformed entry is dropped (reads as absent). */
export function readSurfaceReadiness(raw: unknown): SurfaceReadinessMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const tree = (raw as Record<string, unknown>)[SURFACE_READINESS_KEY];
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) return {};
  const out: SurfaceReadinessMap = {};
  for (const [surface, value] of Object.entries(tree as Record<string, unknown>)) {
    if (!isToolSurface(surface)) continue;
    const parsed = recordSchema.safeParse(value);
    if (parsed.success) out[surface] = parsed.data;
  }
  return out;
}

export function surfaceReadinessState(
  entry: SurfaceReadinessRecord | undefined,
  current: { endpointFingerprint: string; profileKey: string },
): SurfaceReadinessState {
  if (!entry) return 'absent';
  if (entry.version !== SURFACE_TURN_VERSION || entry.endpointFingerprint !== current.endpointFingerprint || entry.profileKey !== current.profileKey) {
    return 'stale';
  }
  return entry.state;
}

/** The tool surfaces a current `failed` entry refuses. */
export function failedToolSurfaces(raw: unknown, current: { endpointFingerprint: string; facts: ToolProfileFacts }): ToolSurface[] {
  const readiness = readSurfaceReadiness(raw);
  return (TOOL_REQUIRING_SURFACES as readonly ToolSurface[]).filter((surface) => surfaceReadinessState(readiness[surface], {
    endpointFingerprint: current.endpointFingerprint,
    profileKey: readinessProfileKey(current.facts, surface),
  }) === 'failed');
}

/**
 * Under the write lock: the entries still bound to the profile each surface
 * resolves to NOW (the row as locked, the connection's current version). An
 * entry whose profile changed while the run was in flight (an operator edit,
 * a window learned or lapsed) is dropped — it describes an exposure the
 * surface no longer uses. Superseded per surface; the others are kept.
 */
export function currentReadinessEntries(
  entries: SurfaceReadinessMap,
  row: ContextWindowFields & { toolProfile: AiToolProfile | null; toolAllowlist: unknown },
  currentConfigVersion: number,
): { kept: SurfaceReadinessMap; dropped: ToolSurface[] } {
  const facts = toolProfileFactsFrom(
    { toolProfile: row.toolProfile, toolAllowlist: row.toolAllowlist as AiToolAllowlist | null },
    'gateway',
    resolveEffectiveContextWindow(row, currentConfigVersion).value,
  );
  const kept: SurfaceReadinessMap = {};
  const dropped: ToolSurface[] = [];
  for (const [surface, entry] of Object.entries(entries) as Array<[ToolSurface, SurfaceReadinessRecord]>) {
    if (entry.profileKey === readinessProfileKey(facts, surface)) kept[surface] = entry;
    else dropped.push(surface);
  }
  return { kept, dropped };
}

/** The stored map with `entries` replacing their surfaces; other surfaces' entries are kept. */
export function mergeSurfaceReadiness(existingCapabilities: unknown, entries: SurfaceReadinessMap): SurfaceReadinessMap {
  return { ...readSurfaceReadiness(existingCapabilities), ...entries };
}
