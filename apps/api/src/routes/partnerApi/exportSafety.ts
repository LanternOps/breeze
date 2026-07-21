import { createHash } from 'node:crypto';
import {
  partnerExportBlockedRecordSchema,
  type PartnerExportBlockedRecord,
  type PartnerExportResource,
} from './schemas';
import { shouldRunStructuralLayer } from './exportSafety.classification';

const MAX_FIELD_PATHS = 20;
const MAX_FIELD_PATH_LENGTH = 256;
const MAX_DEPTH = 32;
const MAX_VISITED_VALUES = 10_000;
export const PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH = 12_288;

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
  'recoverykey',
  'bitlockerrecoverykey',
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
  /\b[a-z][a-z0-9+.-]{1,31}:\/\/[^\s/:@]+:[^\s/@]+@/iu,
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

function boundedWindows(value: string, windowSize: number): string[] {
  if (value.length <= windowSize) return [value];
  const offsets = [0, Math.floor((value.length - windowSize) / 2), value.length - windowSize];
  return [...new Set(offsets)].map((offset) => value.slice(offset, offset + windowSize));
}

function candidateLooksHighEntropy(candidate: string): boolean {
  if (candidate.length < 32 || UUID_PATTERN.test(candidate)) return false;
  const sampleSize = Math.min(64, candidate.length);
  return boundedWindows(candidate, sampleSize).some((sample) => shannonEntropy(sample) >= 3.2);
}

function windowContainsHighEntropyToken(window: string): boolean {
  const candidates = window.match(/[A-Za-z0-9+/_=-]{32,}/gu) ?? [];
  return candidates.some(candidateLooksHighEntropy);
}

interface ScriptToken {
  value: string;
  quoted: boolean;
}

function tokenizeCredentialSyntax(value: string): { tokens: ScriptToken[]; operations: number; complete: boolean } {
  const tokens: ScriptToken[] = [];
  let operations = 0;
  let index = 0;
  while (index < value.length && tokens.length < MAX_VISITED_VALUES) {
    operations += 1;
    const character = value[index]!;
    if (character === '\n' || character === '\r' || character === ';' || character === '|' || character === '&') {
      tokens.push({ value: ';', quoted: false });
      index += 1;
      continue;
    }
    if (/\s|[,{}()[\]]/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '=' || character === ':' || character === '$') {
      tokens.push({ value: character, quoted: false });
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let content = '';
      index += 1;
      while (index < value.length && value[index] !== quote) {
        operations += 1;
        if (value[index] === '\\' && index + 1 < value.length) index += 1;
        content += value[index]!;
        index += 1;
      }
      if (index < value.length) index += 1;
      tokens.push({ value: content, quoted: true });
      continue;
    }
    const start = index;
    while (index < value.length && !/[\s,{}()[\];|&=:$"']/u.test(value[index]!)) {
      operations += 1;
      index += 1;
    }
    if (index > start) tokens.push({ value: value.slice(start, index), quoted: false });
    else index += 1;
  }
  return { tokens, operations, complete: index >= value.length };
}

function isSecretSemanticIdentifier(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value)
    && splitFieldName(value).some((part) => FORBIDDEN_FIELD_TOKENS.has(part));
}

function inspectScriptCredentialIdentifiers(value: string): { secretLike: boolean; operations: number } {
  // Script content is deliberately conservative: once quotes and CLI prefixes
  // are treated as boundaries, any credential-semantic identifier blocks the
  // complete record even when the surrounding command grammar is unfamiliar.
  const identifiers = value.match(/[A-Za-z][A-Za-z0-9_.-]*/gu) ?? [];
  return {
    secretLike: identifiers.some(isSecretSemanticIdentifier),
    operations: value.length,
  };
}

function hasFollowingValue(tokens: ScriptToken[], index: number): boolean {
  const value = tokens[index];
  return value !== undefined && value.value.length > 0 && !['=', ':', '$'].includes(value.value);
}

export function inspectCredentialSyntax(
  value: string,
  conservativeIdentifiers = true,
): { secretLike: boolean; operations: number } {
  const identifierInspection = conservativeIdentifiers
    ? inspectScriptCredentialIdentifiers(value)
    : { secretLike: false, operations: 0 };
  if (identifierInspection.secretLike) return identifierInspection;
  const tokenized = tokenizeCredentialSyntax(value);
  const { tokens } = tokenized;
  let operations = identifierInspection.operations + tokenized.operations;
  if (!tokenized.complete) return { secretLike: true, operations };
  for (let index = 0; index < tokens.length; index += 1) {
    operations += 1;
    const current = tokens[index]!.value;
    const lower = current.toLowerCase();

    if ((lower === 'set' || lower === 'setx') && tokens[index + 1]?.quoted) {
      const nested = inspectCredentialSyntax(tokens[index + 1]!.value);
      operations += nested.operations;
      if (nested.secretLike) return { secretLike: true, operations };
    }
    if (lower === 'setx') {
      let identifierIndex = index + 1;
      while (/^[/-][A-Za-z]+$/u.test(tokens[identifierIndex]?.value ?? '')) {
        operations += 1;
        identifierIndex += 1;
      }
      if (isSecretSemanticIdentifier(tokens[identifierIndex]?.value ?? '')
        && hasFollowingValue(tokens, identifierIndex + 1)) {
        return { secretLike: true, operations };
      }
    }

    let identifierIndex = index;
    if (current === '$') identifierIndex += 1;
    if ((tokens[identifierIndex]?.value ?? '').toLowerCase() === 'env'
      && tokens[identifierIndex + 1]?.value === ':') identifierIndex += 2;
    if (isSecretSemanticIdentifier(tokens[identifierIndex]?.value ?? '')
      && ['=', ':'].includes(tokens[identifierIndex + 1]?.value ?? '')
      && hasFollowingValue(tokens, identifierIndex + 2)) return { secretLike: true, operations };

    if (lower === 'convertto-securestring') {
      let hasPlainText = false;
      let hasNamedValue = false;
      let hasPositionalValue = false;
      let cursor = index + 1;
      while (cursor < tokens.length && tokens[cursor]!.value !== ';') {
        operations += 1;
        const commandValue = tokens[cursor]!.value;
        const commandLower = commandValue.toLowerCase();
        if (commandLower === '-asplaintext') hasPlainText = true;
        if (commandLower === '-string' && hasFollowingValue(tokens, cursor + 1)) hasNamedValue = true;
        if (commandValue && !commandValue.startsWith('-')) hasPositionalValue = true;
        cursor += 1;
      }
      if (hasPlainText && (hasNamedValue || hasPositionalValue)) return { secretLike: true, operations };
      index = cursor;
    }
  }
  return { secretLike: false, operations };
}

function containsCredentialAssignment(value: string, conservativeIdentifiers: boolean): boolean {
  return inspectCredentialSyntax(value, conservativeIdentifiers).secretLike;
}

function isSecretLikeValue(value: string, inspectScriptIdentifiers: boolean, runStructural: boolean): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    || containsCredentialAssignment(value, inspectScriptIdentifiers)
    || (runStructural && windowContainsHighEntropyToken(value));
}

function isSemanticIdentifierPath(path: string): boolean {
  const key = path.split('.').at(-1)?.toLowerCase();
  return key === 'fieldkey' || key === 'name';
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

export function inspectDefinitionForSecrets(
  definition: unknown,
  resource?: PartnerExportResource,
): DefinitionInspectionResult {
  const fieldPaths: string[] = [];
  const seenPaths = new Set<string>();
  const ancestors = new Set<object>();
  let visited = 0;
  let traversalStopped = false;

  const addPath = (path: string) => {
    const bounded = (path || '_').slice(0, MAX_FIELD_PATH_LENGTH);
    if (fieldPaths.length < MAX_FIELD_PATHS && !seenPaths.has(bounded)) {
      seenPaths.add(bounded);
      fieldPaths.push(bounded);
    }
  };

  const canDereferenceChild = (path: string, depth: number): boolean => {
    if (depth > MAX_DEPTH || visited >= MAX_VISITED_VALUES) {
      addPath(path);
      traversalStopped = true;
      return false;
    }
    return true;
  };

  const visit = (value: unknown, path: string, depth: number, trustedRevision = false): void => {
    if (traversalStopped) return;
    visited += 1;
    if (depth > MAX_DEPTH || visited > MAX_VISITED_VALUES) {
      addPath(path);
      traversalStopped = true;
      return;
    }
    if (typeof value === 'string') {
      if (value.length > PARTNER_EXPORT_MAX_INSPECTABLE_STRING_LENGTH) {
        addPath(path);
        traversalStopped = true;
        return;
      }
      const runStructural = resource === undefined || shouldRunStructuralLayer(resource, path);
      if (!(trustedRevision && SHA256_PATTERN.test(value)) && (
        isSecretLikeValue(value, path.split('.').at(-1)?.toLowerCase() === 'content', runStructural)
        || (isSemanticIdentifierPath(path) && isSecretSemanticIdentifier(value))
      )) addPath(path);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (ancestors.has(value)) {
      addPath(path);
      traversalStopped = true;
      return;
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (traversalStopped) break;
          const childPath = appendArrayPath(path, index);
          const childDepth = depth + 1;
          if (!canDereferenceChild(childPath, childDepth)) break;
          visit(value[index], childPath, childDepth);
        }
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key in record) {
        if (traversalStopped) break;
        if (!Object.hasOwn(record, key)) continue;
        const childPath = appendObjectPath(path, key);
        if (isForbiddenFieldName(key)) addPath(childPath);
        const childDepth = depth + 1;
        if (!canDereferenceChild(childPath, childDepth)) break;
        const child = record[key];
        visit(child, childPath, childDepth, childPath === 'revision');
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
  const inspection = inspectDefinitionForSecrets(definition, identity.resource);
  if (inspection.safe) return { safe: true, definition };
  return { safe: false, blocked: buildSafeBlockedRecord(identity, inspection) };
}
