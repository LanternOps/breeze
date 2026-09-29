/**
 * Fix-memory signature v1 (AI Suggested Fixes W1). PURE — no DB.
 *
 * A signature identifies a PROBLEM across orgs of one partner: source family,
 * condition semantics (never an org-local rule/monitor UUID), OS family and at
 * most one discriminator read from STRUCTURED fields only. A signature without
 * a discriminator is BROAD: it may appear under "Similar fixes" but is never
 * auto-attached as proven (spec "Broad signatures").
 */
import { createHash } from 'node:crypto';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import { FIX_SIGNATURE_VERSION, type FixDiscriminatorKind, type FixSignatureFamily } from '@breeze/shared';

export type FixOsFamily = 'windows' | 'macos' | 'linux';
export interface FixDiscriminator { kind: FixDiscriminatorKind; value: string }
export interface SignatureFacets {
  family: FixSignatureFamily;
  condition: string;
  osFamily: FixOsFamily;
  discriminator: FixDiscriminator | null;
  /** Correlation only: the root is the earliest alert, not an established cause. */
  rootInferred: boolean;
}
export interface FixSignature {
  version: typeof FIX_SIGNATURE_VERSION;
  key: string;
  broadKey: string;
  broad: boolean;
  facets: SignatureFacets;
}
export interface ConditionFacets { condition: string; discriminator: FixDiscriminator | null }

const CONDITION_MAX = 200;
const DISCRIMINATOR_MAX = 120;
const MAX_GROUP_DEPTH = 4;

export function isFixOsFamily(value: unknown): value is FixOsFamily {
  return value === 'windows' || value === 'macos' || value === 'linux';
}

function digest(parts: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalizeArguments(parts), 'utf8').digest('hex');
}

export function computeSignature(facets: SignatureFacets): FixSignature | null {
  if (!facets.condition || facets.condition.length > CONDITION_MAX) return null;
  const base = { v: FIX_SIGNATURE_VERSION, family: facets.family, condition: facets.condition, os: facets.osFamily };
  const broadKey = digest({ ...base, d: null });
  const key = facets.discriminator
    ? digest({ ...base, d: [facets.discriminator.kind, facets.discriminator.value] })
    : broadKey;
  return { version: FIX_SIGNATURE_VERSION, key, broadKey, broad: facets.discriminator === null, facets };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function disc(kind: FixDiscriminatorKind, value: unknown): FixDiscriminator | null {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : str(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ');
  return normalized.length > DISCRIMINATOR_MAX ? null : { kind, value: normalized };
}

function direction(operator: unknown): string {
  if (operator === 'gt' || operator === 'gte') return 'high';
  if (operator === 'lt' || operator === 'lte') return 'low';
  if (operator === 'eq' || operator === 'neq') return operator;
  return 'unknown';
}

interface Leaf { token: string; discriminator: FixDiscriminator | null }

function leafFor(c: Record<string, unknown>): Leaf | null {
  const type = str(c.type);
  switch (type) {
    case 'threshold':
    case 'metric': {
      const metric = str(c.metric);
      return metric ? { token: `metric:${metric}:${direction(c.operator)}`, discriminator: null } : null;
    }
    case 'offline':
    case 'patch_compliance':
    case 'cert_expiry':
    case 'script_monitor':
    case 'network_check':
      return { token: type, discriminator: null };
    case 'event_log': {
      const category = str(c.category);
      const level = str(c.level);
      return category && level ? { token: `event_log:${category}:${level}`, discriminator: null } : null;
    }
    case 'service_stopped':
      return { token: type, discriminator: disc('service', c.serviceName) };
    case 'process_stopped':
    case 'process_cpu_high':
    case 'process_memory_high':
      return { token: type, discriminator: disc('process', c.processName) };
    case 'bandwidth_high':
    case 'disk_io_high': {
      const dir = str(c.direction);
      return dir ? { token: `${type}:${dir}`, discriminator: null } : null;
    }
    case 'network_errors': {
      const errorType = str(c.errorType);
      return errorType ? { token: `network_errors:${errorType}`, discriminator: null } : null;
    }
    case 'antivirus':
    case 'backup_continuity': {
      const check = str(c.check);
      return check ? { token: `${type}:${check}`, discriminator: null } : null;
    }
    case 'software_presence': {
      const presence = str(c.presence);
      return presence ? { token: `software_presence:${presence}`, discriminator: disc('software', c.name) } : null;
    }
    case 'hardware_health': {
      const kinds = Array.isArray(c.componentTypes) ? c.componentTypes.filter((k): k is string => typeof k === 'string') : [];
      return kinds.length ? { token: `hardware_health:${[...kinds].sort().join('+')}`, discriminator: null } : null;
    }
    default:
      return null;
  }
}

function walk(node: unknown, leaves: Leaf[], depth: number): string | null {
  if (depth > MAX_GROUP_DEPTH || node === null || typeof node !== 'object') return null;
  const children = Array.isArray(node) ? node : Array.isArray((node as Record<string, unknown>).conditions) ? (node as { conditions: unknown[] }).conditions : null;
  if (children) {
    if (children.length === 0) return null;
    const tokens: string[] = [];
    for (const child of children) {
      const token = walk(child, leaves, depth + 1);
      if (!token) return null;
      tokens.push(token);
    }
    if (tokens.length === 1) return tokens[0]!;
    const logic = !Array.isArray(node) && (node as Record<string, unknown>).logic === 'or' ? 'or' : 'and';
    return `${logic}(${tokens.sort().join(',')})`;
  }
  const leaf = leafFor(node as Record<string, unknown>);
  if (!leaf) return null;
  leaves.push(leaf);
  return leaf.token;
}

export function ruleConditionFacets(root: unknown): ConditionFacets | null {
  const leaves: Leaf[] = [];
  const token = walk(root, leaves, 0);
  if (!token) return null;
  const discriminators = leaves.map((l) => l.discriminator).filter((d): d is FixDiscriminator => d !== null);
  return { condition: `rule:${token}`, discriminator: discriminators.length === 1 ? discriminators[0]! : null };
}

export function sourcedAlertFacets(context: Record<string, unknown> | null): ConditionFacets | null {
  switch (str(context?.source)) {
    case 'network_monitor': {
      const monitorType = str(context!.monitorType);
      return monitorType ? { condition: `sourced:network_monitor:${monitorType}`, discriminator: null } : null;
    }
    case 'script_exit_code': {
      const scriptId = str(context!.scriptId);
      const exit = disc('exit_code', context!.exitCode);
      return scriptId && exit ? { condition: `sourced:script_exit_code:${scriptId}`, discriminator: exit } : null;
    }
    case 'patch-job-finalizer':
      return { condition: `sourced:patch_failed:${str(context!.category) ?? 'any'}`, discriminator: null };
    case 'maintenance-reboot-sweep':
      return { condition: 'sourced:reboot_pending', discriminator: null };
    case 'warranty_evaluator':
      return { condition: 'sourced:warranty_expiry', discriminator: null };
    case 'backup_provider': {
      const providerKey = str(context!.providerKey);
      const condition = str(context!.condition);
      return providerKey && condition ? { condition: `sourced:backup_provider:${providerKey}:${condition}`, discriminator: null } : null;
    }
    case 'network_baseline':
      return { condition: 'sourced:network_baseline', discriminator: null };
    case 'policy-evaluation':
      return { condition: 'sourced:policy_violation', discriminator: null };
    default:
      // monitor_recurrence is a human escalation; metric_anomaly is routed to
      // the anomaly family by the loader; anything unknown gets no signature.
      return null;
  }
}

export function alertConditionFacets(input: {
  requiresHuman: boolean;
  context: Record<string, unknown> | null;
  ruleConditions: unknown | null;
}): ConditionFacets | null {
  if (input.requiresHuman) return null;
  const source = str(input.context?.source);
  if (source === 'monitor_recurrence' || source === 'metric_anomaly') return null;
  if (input.ruleConditions !== null && input.ruleConditions !== undefined) {
    const fromRule = ruleConditionFacets(input.ruleConditions);
    if (fromRule) return fromRule;
  }
  return sourcedAlertFacets(input.context);
}

export function anomalyConditionFacets(episodeKey: string): ConditionFacets {
  return { condition: `anomaly:${episodeKey}`, discriminator: null };
}
