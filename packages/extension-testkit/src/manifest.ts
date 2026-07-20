import { safeParseExtensionManifestV1 } from '@breeze/extension-sdk';

/** A single conformance problem, addressed by a dotted `path` and a stable `code`. */
export interface Issue {
  path: string;
  code: string;
  message: string;
}

/** Result shape shared by the in-process conformance assertions. */
export interface ConformanceResult {
  ok: boolean;
  issues: Issue[];
}

/**
 * Validate a manifest against the frozen v1 schema and report **every** problem
 * in one pass. Unlike the SDK's throwing `parseExtensionManifestV1` (which
 * flattens to a prettified string), this maps each Zod issue to a structured
 * `{ path, code, message }` so an author's test can assert on specific fields.
 */
export function assertManifestConformance(manifest: unknown): ConformanceResult {
  const result = safeParseExtensionManifestV1(manifest);
  if (result.success) return { ok: true, issues: [] };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  };
}
