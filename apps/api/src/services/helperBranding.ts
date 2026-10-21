import { createHash } from 'node:crypto';
import { isReadableBrandColor } from './helperBrandingContrast';

/**
 * Runtime Helper branding: validation, field merge and the effective
 * set/cleared decision (Phase 2, #7567 / #8277). Pure functions only; the
 * resolver that loads partner + organization candidates lives elsewhere.
 */

/** Approved text limits, counted in Unicode code points. */
export const TEXT_LIMITS = {
  displayName: 60,
  companyName: 60,
  welcomeTitle: 120,
  welcomeMessage: 500,
  supportLabel: 40,
  portalLabel: 40,
} as const;

export const COLOR_FIELDS = ['primaryColor', 'accentColor'] as const;

export type BrandingTextField = keyof typeof TEXT_LIMITS;
export type BrandingColorField = (typeof COLOR_FIELDS)[number];
export type BrandingField = BrandingTextField | BrandingColorField;
export type BrandingValues = Partial<Record<BrandingField, string>>;

const BRANDING_FIELDS: ReadonlySet<string> = new Set<string>([...Object.keys(TEXT_LIMITS), ...COLOR_FIELDS]);
/**
 * Characters that can reorder or hide sender text in the Helper and the toast
 * (#9396): control (Cc), format (Cf: bidi embeddings/overrides U+202A-U+202E and
 * isolates U+2066-U+2069, U+200B, U+2060, U+FEFF, ...), surrogate (Cs), private
 * use (Co), and the line/paragraph separators U+2028/U+2029 (Zl/Zp).
 *
 * Allowlist: U+200C (ZWNJ) and U+200D (ZWJ) are allowed because Persian and
 * Indic names and emoji sequences need them. Unassigned code points (Cn) are
 * not rejected, so an emoji newer than Node's Unicode table is not refused.
 */
const DISALLOWED_TEXT_CHARS = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export type BrandingValidation = { ok: true; value: BrandingValues } | { ok: false; errors: string[] };

export function validateBrandingValues(input: unknown): BrandingValidation {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['not-an-object'] };
  }
  const errors: string[] = [];
  const value: BrandingValues = {};
  for (const [key, raw] of Object.entries(input)) {
    if (!BRANDING_FIELDS.has(key)) {
      errors.push(`unknown:${key}`);
      continue;
    }
    if (typeof raw !== 'string') {
      errors.push(`type:${key}`);
      continue;
    }
    if ((COLOR_FIELDS as readonly string[]).includes(key)) {
      if (!HEX_COLOR.test(raw)) errors.push(`color:${key}`);
      else if (!isReadableBrandColor(raw)) errors.push(`contrast:${key}`);
      else value[key as BrandingColorField] = raw;
      continue;
    }
    if (raw.length === 0) {
      errors.push(`empty:${key}`);
    } else if (DISALLOWED_TEXT_CHARS.test(raw)) {
      errors.push(`control:${key}`);
    } else if ([...raw].length > TEXT_LIMITS[key as BrandingTextField]) {
      errors.push(`length:${key}`);
    } else {
      value[key as BrandingTextField] = raw;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** Field-level merge; later layers win. Undefined fields are skipped (absent = Breeze default). */
export function mergeBrandingLayers(...layers: Array<BrandingValues | null | undefined>): BrandingValues {
  const out: Record<string, string> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [field, value] of Object.entries(layer)) {
      if (value !== undefined) out[field] = value;
    }
  }
  return out as BrandingValues;
}

export type BrandingDecision =
  | { state: 'set'; scopeId: string; values: BrandingValues }
  | { state: 'cleared' };

/** No effective field means the branding is explicitly cleared on the device. */
export function buildBrandingDecision(values: BrandingValues, scopeId: string): BrandingDecision {
  if (Object.keys(values).length === 0) return { state: 'cleared' };
  return { state: 'set', scopeId, values };
}

// ---------------------------------------------------------------------------
// Partner + organization resolution and write gates.
// ---------------------------------------------------------------------------


/** Candidate row from the already-loaded policy set (same shape the operational resolver uses). */
export interface BrandingCandidate {
  level: string;
  priority: number;
  inlineSettings: unknown;
}

/** Levels below organization: never contribute branding and cannot take branding writes. */
const LOWER_LEVELS: ReadonlySet<string> = new Set(['site', 'device_group', 'device']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lowest priority wins within a level; the sort is stable, so ties keep input
 * order. A winner without branding contributes nothing and does not fall
 * through to a sibling.
 */
function levelWinnerValues(candidates: readonly BrandingCandidate[], level: string): BrandingValues {
  const winner = candidates
    .filter((c) => c.level === level)
    .sort((a, b) => a.priority - b.priority)[0];
  if (!winner || !isPlainObject(winner.inlineSettings)) return {};
  const raw = winner.inlineSettings.branding;
  if (raw === undefined) return {};
  const validated = validateBrandingValues(raw);
  return validated.ok ? validated.value : {};
}

/**
 * Partner + organization branding only. Site, device-group and device
 * candidates are ignored even if invalid data reached the database by hand.
 * Effective fields merge defaults <- partner <- organization.
 */
export function resolvePartnerOrgBranding(candidates: readonly BrandingCandidate[]): BrandingValues {
  return mergeBrandingLayers(
    levelWinnerValues(candidates, 'partner'),
    levelWinnerValues(candidates, 'organization'),
  );
}

/** Opaque scope id: the Agent compares it and never parses it. */
export function brandingScopeId(partnerId: string, orgId: string): string {
  return createHash('sha256').update(`helper-branding:${partnerId}:${orgId}`).digest('hex').slice(0, 32);
}

/** Setting branding (non-empty) is rejected when the policy also carries a lower-level assignment. */
export function brandingWriteAllowed(incomingBranding: unknown, existingLevels: readonly string[]): boolean {
  if (incomingBranding === undefined) return true;
  if (!isPlainObject(incomingBranding) || Object.keys(incomingBranding).length === 0) return true; // clearing
  return !existingLevels.some((level) => LOWER_LEVELS.has(level));
}

/** Adding a lower-level assignment is rejected when the policy already carries branding. */
export function assignmentWriteAllowed(newLevel: string, policyHasBranding: boolean): boolean {
  return !(LOWER_LEVELS.has(newLevel) && policyHasBranding);
}

/** True when a policy's helper inline settings carry at least one branding field. */
export function hasHelperBranding(inlineSettings: unknown): boolean {
  if (!isPlainObject(inlineSettings)) return false;
  const branding = inlineSettings.branding;
  return isPlainObject(branding) && Object.keys(branding).length > 0;
}

export interface BrandingWriteError {
  status: 400 | 409;
  error: string;
  details?: string[];
}

/**
 * Write-time check for a helper feature link's inline settings. Only the
 * branding subtree is validated; the rest of the helper settings keep their
 * existing behaviour. Clearing (null or an empty object) is always allowed.
 */
export function brandingWriteError(inlineSettings: unknown, existingLevels: readonly string[]): BrandingWriteError | null {
  if (!isPlainObject(inlineSettings) || !('branding' in inlineSettings)) return null;
  const branding = inlineSettings.branding;
  if (branding === undefined || branding === null) return null;
  if (isPlainObject(branding) && Object.keys(branding).length === 0) return null;
  const validated = validateBrandingValues(branding);
  if (!validated.ok) return { status: 400, error: 'Invalid Helper branding', details: validated.errors };
  if (!brandingWriteAllowed(branding, existingLevels)) {
    return {
      status: 409,
      error: 'Helper branding is partner- and organization-scoped; remove site, device group and device assignments first',
    };
  }
  return null;
}
