import {
  YARA_BUNDLE_FORMAT,
  YARA_BUNDLE_FORMAT_VERSION,
  type YaraBundleInput,
} from '../types/yara';

/**
 * Serializes a rule set to the canonical W02 §C2 bundle. The agent pins the
 * sha256 of these exact bytes (W02 §C1), so this function is a wire contract,
 * tested byte for byte against the agent's golden fixture:
 *
 *  - keys in exactly the contract order — objects are built literally, never
 *    spread, so an extra property on a caller's row cannot leak in;
 *  - `rules` sorted by `id` ascending in UTF-16 code-unit order (the agent's
 *    byte order for the ASCII UUIDs it is given; never `localeCompare`);
 *  - `JSON.stringify` escaping, no whitespace.
 *
 * Browser-safe on purpose (no hashing here): the API wraps it with sha256.
 */
export function buildYaraBundleJson(input: YaraBundleInput): string {
  const rules = [...input.rules].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return JSON.stringify({
    format: YARA_BUNDLE_FORMAT,
    v: YARA_BUNDLE_FORMAT_VERSION,
    ruleSetId: input.ruleSetId,
    version: input.version,
    autoQuarantine: input.autoQuarantine,
    rules: rules.map((r) => ({ id: r.id, name: r.name, severity: r.severity, source: r.source })),
  });
}
