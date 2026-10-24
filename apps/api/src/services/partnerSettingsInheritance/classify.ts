/**
 * In-memory classification of ONE org for ONE catalog field (#9170, spec §5.4).
 *
 * Used only to label the rows of a drill-down page (≤50 orgs). Tab counts come
 * from the SQL predicates in `bindings.ts`, never from a per-org loop. Whether
 * an org's own value is in effect is decided by the runtime resolvers (through
 * the binding); this module only composes the §5.4 words from that answer:
 *
 * - ownValue: the org has stored a value the resolver treats as set.
 * - inEffect: that value is what the resolver gives the org.
 * - shadowed: it has its own value, but the value is not in effect.
 * - overrides: it has its own value, in effect, while the partner has set a
 *   different one. `null` for secret fields (sealed values cannot be compared).
 * - clamped (cap only): its own value is above the partner ceiling.
 *
 * The integration contract test proves these labels equal the SQL buckets.
 */
import { isDeepStrictEqual } from 'node:util';
import type { CatalogEntry } from '@breeze/shared';
import { BINDINGS, type FieldBinding } from './bindings';

export interface OrgClassification {
  ownValue: boolean;
  overrides: boolean | null;
  shadowed: boolean;
  inEffect: boolean;
  clamped?: boolean;
}

/** One Pushover channel's raw value at the field's config key (undefined = key absent). */
export interface ChannelRaw {
  value: unknown;
}

function bindingOf(entry: CatalogEntry): FieldBinding {
  const binding = BINDINGS[entry.id];
  if (!binding) throw new Error(`partner settings catalog entry has no binding: ${entry.id}`);
  return binding;
}

export function fieldPartnerSet(entry: CatalogEntry, partnerSettings: unknown): boolean {
  return bindingOf(entry).partnerSet(partnerSettings);
}

export function fieldInForce(entry: CatalogEntry, partnerSettings: unknown): boolean {
  return bindingOf(entry).inForce(partnerSettings);
}

function classifyValue(entry: CatalogEntry, binding: FieldBinding, partnerSettings: unknown, raw: unknown): OrgClassification {
  const ownValue = binding.hasOwnValue(raw);
  const inEffect = ownValue && binding.orgValueInEffect(partnerSettings, raw);
  const overrides = entry.secret
    ? null
    : entry.kind === 'overridable'
      && ownValue
      && inEffect
      && binding.partnerSet(partnerSettings)
      && !isDeepStrictEqual(raw, binding.partnerValue(partnerSettings));
  const result: OrgClassification = { ownValue, overrides, shadowed: ownValue && !inEffect, inEffect };
  if (entry.qualifier === 'cap') result.clamped = ownValue && (binding.clamped?.(partnerSettings, raw) ?? false);
  return result;
}

/** Per-channel classification for channel-sourced fields (Pushover). */
export function classifyChannel(entry: CatalogEntry, partnerSettings: unknown, channel: ChannelRaw): OrgClassification {
  return classifyValue(entry, bindingOf(entry), partnerSettings, channel.value);
}

/**
 * Classify one org. `orgRaw` is the org's raw value at the binding's source;
 * for channel-sourced fields it is the org's channels (`ChannelRaw[]`), and an
 * org counts once when any channel matches.
 */
export function classifyOrg(entry: CatalogEntry, partnerSettings: unknown, orgRaw: unknown): OrgClassification {
  const binding = bindingOf(entry);
  if (binding.orgSource === null) {
    return { ownValue: false, overrides: entry.secret ? null : false, shadowed: false, inEffect: false };
  }
  if (binding.orgSource.kind !== 'pushoverChannels') {
    return classifyValue(entry, binding, partnerSettings, orgRaw);
  }
  const channels = Array.isArray(orgRaw) ? (orgRaw as ChannelRaw[]) : [];
  const perChannel = channels.map((channel) => classifyValue(entry, binding, partnerSettings, channel.value));
  return {
    ownValue: perChannel.some((c) => c.ownValue),
    inEffect: perChannel.some((c) => c.inEffect),
    shadowed: perChannel.some((c) => c.shadowed),
    overrides: entry.secret ? null : perChannel.some((c) => c.overrides === true),
  };
}
