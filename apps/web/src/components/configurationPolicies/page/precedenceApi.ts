import { fetchWithAuth } from '../../../stores/auth';
import { FEATURE_META, type FeatureType } from '../featureTabs/types';
import type { FeatureState } from './featureState';

// "Outranked on N devices" per feature (#12472, plan W05a O3): the client and
// wire parser for `GET /configuration-policies/:id/precedence` (#12553).
//
// The API answers `{ capped: true }`, or `{ capped: false, features: {
// <featureType>: { reached, outranked } } }`, or 404. Counts cover only the
// devices the caller can see. The web keeps three states apart and never
// turns one into another:
//  - unknown (null): not loaded, a refused read, or a body of another shape;
//  - capped: too many devices to count, so there is no number at all;
//  - counts: a feature the answer does not mention has NO data, not zero.

export interface FeaturePrecedence {
  /** Devices this policy's own rows reach that the caller can see. */
  reached: number;
  /** Of those, the devices where another policy wins this feature. */
  outranked: number;
}

export type PolicyPrecedence =
  | { capped: true }
  | { capped: false; features: Partial<Record<FeatureType, FeaturePrecedence>> };

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isFeatureType = (key: string): key is FeatureType => Object.prototype.hasOwnProperty.call(FEATURE_META, key);

function parseFeaturePrecedence(raw: unknown): FeaturePrecedence | null {
  if (!isRecord(raw)) return null;
  const { reached, outranked } = raw;
  if (!isCount(reached) || !isCount(outranked) || outranked > reached) return null;
  return { reached, outranked };
}

/** The precedence answer, or null when the body is not that shape. */
export function parsePrecedence(raw: unknown): PolicyPrecedence | null {
  if (!isRecord(raw)) return null;
  if (raw.capped === true) return { capped: true };
  if (raw.capped !== false || !isRecord(raw.features)) return null;
  const features: Partial<Record<FeatureType, FeaturePrecedence>> = {};
  for (const [key, value] of Object.entries(raw.features)) {
    if (!isFeatureType(key)) continue;
    const parsed = parseFeaturePrecedence(value);
    if (parsed) features[key] = parsed;
  }
  return { capped: false, features };
}

/** Throws on a refused read; a 200 of another shape is unknown (null). */
export async function fetchPolicyPrecedence(policyId: string): Promise<PolicyPrecedence | null> {
  const response = await fetchWithAuth(`/configuration-policies/${policyId}/precedence`);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`precedence ${response.status}`);
  const parsed = parsePrecedence(body);
  // The page shows nothing either way; say why for whoever is looking.
  if (!parsed) console.warn('[configuration policies] precedence answer has an unexpected shape');
  return parsed;
}

/** What one feature has to say: capped, a count above zero, or nothing (null). */
export type FeatureOutranked = { kind: 'capped' } | { kind: 'outranked'; count: number; reached: number };

export function featureOutranked(
  precedence: PolicyPrecedence | null,
  featureType: FeatureType,
): FeatureOutranked | null {
  if (!precedence) return null;
  if (precedence.capped) return { kind: 'capped' };
  const entry = precedence.features[featureType];
  if (!entry || entry.outranked === 0) return null;
  return { kind: 'outranked', count: entry.outranked, reached: entry.reached };
}

/** A feature this policy has in effect: its own, or inherited from its parent. */
export function featureInEffect(state: FeatureState): boolean {
  return state === 'set_here' || state === 'changed_from_parent' || state === 'from_parent';
}

/** The outranked answer for one feature, or null when there is nothing to say. */
export function outrankedFor(
  precedence: PolicyPrecedence | null,
  featureType: FeatureType,
  state: FeatureState,
): FeatureOutranked | null {
  return featureInEffect(state) ? featureOutranked(precedence, featureType) : null;
}
