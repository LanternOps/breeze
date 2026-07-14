import { createHash } from 'node:crypto';
import {
  partnerExportBlockedRecordSchema,
  type PartnerExportBlockedRecord,
  type PartnerExportResource,
} from './schemas';

const MAX_FIELD_PATHS = 20;
const MAX_FIELD_PATH_LENGTH = 256;
const MAX_DEPTH = 32;
const MAX_VISITED_VALUES = 10_000;

const FORBIDDEN_FIELD_TOKENS = new Set([
  'authorization',
  'credential',
  'credentials',
  'encryptionkey',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'providerconfig',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/iu,
  /\bauthorization\s*:\s*(?:bearer|basic)\s+[A-Za-z0-9+/=_-]{12,}/iu,
  /\b(?:gh[oprsu]_|sk-(?:live|test)?-?|xox[baprs]-)[A-Za-z0-9_-]{20,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/iu,
] as const;

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

function canonicalize(value: unknown, ancestors: Set<object>): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') throw new TypeError('Partner export revisions require JSON-compatible values.');
  if (ancestors.has(value)) throw new TypeError('Partner export revisions cannot contain cycles.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Partner export revisions require plain JSON objects.');
    }
    const result: Record<string, CanonicalJson> = Object.create(null) as Record<string, CanonicalJson>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = canonicalize((value as Record<string, unknown>)[key], ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set()));
}

export function computePartnerExportRevision(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}

function splitFieldName(name: string): string[] {
  const words = name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const compact = words.join('');
  return [...words, compact];
}

function isForbiddenFieldName(name: string): boolean {
  return splitFieldName(name).some((token) => FORBIDDEN_FIELD_TOKENS.has(token));
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function resemblesHighEntropySecret(value: string): boolean {
  if (value.length < 32 || UUID_PATTERN.test(value)) return false;
  const boundedSample = value.slice(0, 4096);
  if (!/^[A-Za-z0-9+/_=-]+$/u.test(boundedSample)) return false;
  return shannonEntropy(boundedSample) >= 3.2;
}

function isSecretLikeValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    || resemblesHighEntropySecret(value);
}

function safePathComponent(component: string): string {
  const sanitized = component.replace(/[^A-Za-z0-9_$-]/gu, '_');
  return (sanitized || '_').slice(0, 64);
}

function appendObjectPath(path: string, key: string): string {
  const component = safePathComponent(key);
  return (path ? `${path}.${component}` : component).slice(0, MAX_FIELD_PATH_LENGTH);
}

function appendArrayPath(path: string, index: number): string {
  return `${path}[${index}]`.slice(0, MAX_FIELD_PATH_LENGTH);
}

export type DefinitionInspectionResult =
  | { safe: true }
  | { safe: false; reason: 'secret_detected'; fieldPaths: string[] };

export function inspectDefinitionForSecrets(definition: unknown): DefinitionInspectionResult {
  const fieldPaths: string[] = [];
  const seenPaths = new Set<string>();
  const ancestors = new Set<object>();
  let visited = 0;

  const addPath = (path: string) => {
    const bounded = (path || '_').slice(0, MAX_FIELD_PATH_LENGTH);
    if (fieldPaths.length < MAX_FIELD_PATHS && !seenPaths.has(bounded)) {
      seenPaths.add(bounded);
      fieldPaths.push(bounded);
    }
  };

  const visit = (value: unknown, path: string, depth: number, trustedRevision = false): void => {
    visited += 1;
    if (depth > MAX_DEPTH || visited > MAX_VISITED_VALUES) {
      addPath(path);
      return;
    }
    if (typeof value === 'string') {
      if (!(trustedRevision && SHA256_PATTERN.test(value)) && isSecretLikeValue(value)) addPath(path);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (ancestors.has(value)) {
      addPath(path);
      return;
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          visit(value[index], appendArrayPath(path, index), depth + 1);
        }
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        const childPath = appendObjectPath(path, key);
        if (isForbiddenFieldName(key)) addPath(childPath);
        visit(child, childPath, depth + 1, childPath === 'revision');
      }
    } finally {
      ancestors.delete(value);
    }
  };

  visit(definition, '', 0);
  return fieldPaths.length === 0
    ? { safe: true }
    : { safe: false, reason: 'secret_detected', fieldPaths };
}

export interface PartnerExportBlockedIdentity {
  resource: PartnerExportResource;
  id: string;
  orgId: string;
}

export function buildSafeBlockedRecord(
  identity: PartnerExportBlockedIdentity,
  inspection: DefinitionInspectionResult,
): PartnerExportBlockedRecord {
  if (inspection.safe) throw new TypeError('A safe definition cannot produce blocked metadata.');
  return partnerExportBlockedRecordSchema.parse({
    resource: identity.resource,
    id: identity.id,
    orgId: identity.orgId,
    reason: inspection.reason,
    fieldPaths: inspection.fieldPaths.slice(0, MAX_FIELD_PATHS),
  });
}

export function safelyExportDefinition<T>(
  identity: PartnerExportBlockedIdentity,
  definition: T,
): { safe: true; definition: T } | { safe: false; blocked: PartnerExportBlockedRecord } {
  const inspection = inspectDefinitionForSecrets(definition);
  if (inspection.safe) return { safe: true, definition };
  return { safe: false, blocked: buildSafeBlockedRecord(identity, inspection) };
}
