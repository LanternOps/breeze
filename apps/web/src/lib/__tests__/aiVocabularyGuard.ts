import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared helper for the AI vocabulary guard suites (aiVocabulary.*.test.ts).
 * Scans the English catalogue as plain JSON — no i18n runtime — so a retired
 * noun cannot hide behind a lazy-loaded namespace.
 */
export interface VocabularyRule {
  name: string;
  pattern: RegExp;
  /** When set, the rule only scans these namespaces (file names without .json). */
  namespaces?: string[];
  /**
   * When set, the rule only scans keys starting with one of these
   * `namespace:dotted.path` prefixes. Use it when only part of a namespace is
   * an AI surface (e.g. `security:aiRisk` inside `security`).
   */
  keyPrefixes?: string[];
}

export interface VocabularyViolation {
  /** `namespace:dotted.path` (array entries as `[n]`). */
  key: string;
  value: string;
  rule: string;
}

const enDir = join(__dirname, '..', '..', 'locales', 'en');

export function scanEnglishCatalogue(
  rules: VocabularyRule[],
  allow: ReadonlySet<string>,
): VocabularyViolation[] {
  const violations: VocabularyViolation[] = [];

  const visit = (namespace: string, path: string, node: unknown): void => {
    if (typeof node === 'string') {
      const key = `${namespace}:${path}`;
      if (allow.has(key)) return;
      for (const rule of rules) {
        if (rule.namespaces && !rule.namespaces.includes(namespace)) continue;
        if (rule.keyPrefixes && !rule.keyPrefixes.some((prefix) => key.startsWith(prefix))) continue;
        if (rule.pattern.test(node)) violations.push({ key, value: node, rule: rule.name });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(namespace, `${path}[${index}]`, entry));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, entry] of Object.entries(node as Record<string, unknown>)) {
        visit(namespace, path ? `${path}.${k}` : k, entry);
      }
    }
  };

  for (const file of readdirSync(enDir).filter((f) => f.endsWith('.json')).sort()) {
    const namespace = file.slice(0, -'.json'.length);
    visit(namespace, '', JSON.parse(readFileSync(join(enDir, file), 'utf8')));
  }
  return violations;
}
