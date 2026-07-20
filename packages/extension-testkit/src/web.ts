import type { ConformanceResult, Issue } from './manifest';

/**
 * A host-context contract to exercise. `parse` is the web-sdk `parse*` function
 * the element relies on; `badInput` is a deliberately invalid context that a
 * conforming contract must reject (throw) rather than accept.
 */
export interface WebContractProbe {
  label: string;
  parse: (input: unknown) => unknown;
  badInput: unknown;
}

export interface WebConformanceOptions {
  /** The extension manifest (raw or parsed); `web.pages`/`web.slots` are read for element names. */
  manifest: unknown;
  /**
   * Loads the extension's web entry, registering its custom elements. Called
   * TWICE.
   *
   * IMPORTANT — `customElements` is a process-global registry and ES modules are
   * cached by specifier, which shapes what this check can and cannot prove:
   *
   * - Registration is verified by an **undefined → defined transition across the
   *   first call**, not merely by "is defined now". An element already present
   *   before load (from a prior test, a shared entry, or another extension)
   *   cannot be attributed to this entry and is reported as `element_preexisting`
   *   unless {@link allowPreexistingElements} is set. Run each entry against a
   *   fresh registry (e.g. a new happy-dom window per case) for a clean result.
   * - Idempotency is only meaningfully tested when the second call **re-executes**
   *   the entry's `customElements.define` logic. A bare `() => import('./web.js')`
   *   returns the cached module on the second call WITHOUT re-running top-level
   *   code, so an unguarded `define` will silently pass. To exercise idempotency,
   *   make `loadEntry` re-run the registration (e.g. a cache-busted import, or a
   *   function that calls the entry's `register()` directly).
   */
  loadEntry: () => unknown | Promise<unknown>;
  /**
   * Skip the `element_preexisting` check — for callers that deliberately verify
   * against an already-populated registry and manage its lifecycle themselves.
   */
  allowPreexistingElements?: boolean;
  /** Optional host-context contracts to prove reject invalid input. */
  contracts?: WebContractProbe[];
}

function declaredElements(manifest: unknown): string[] {
  const web = (manifest as { web?: unknown } | null | undefined)?.web as
    | { pages?: unknown; slots?: unknown }
    | undefined;
  if (!web) return [];
  const pages = Array.isArray(web.pages) ? web.pages : [];
  const slots = Array.isArray(web.slots) ? web.slots : [];
  return [...pages, ...slots]
    .map((entry) => (entry as { element?: unknown } | null)?.element)
    .filter((element): element is string => typeof element === 'string');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate an extension's web contributions in a DOM (e.g. happy-dom) WITHOUT
 * importing any host component:
 * - every element declared in `web.pages`/`web.slots` becomes defined across the
 *   load (undefined -> defined); already-defined elements are flagged rather than
 *   silently passed (see {@link WebConformanceOptions.loadEntry});
 * - re-loading the entry does not throw (definitions are idempotent — only
 *   meaningful when `loadEntry` re-executes; see its docs);
 * - each supplied host-context contract rejects invalid input.
 */
export async function assertWebContributionConformance(
  options: WebConformanceOptions,
): Promise<ConformanceResult> {
  if (typeof customElements === 'undefined') {
    throw new Error(
      'assertWebContributionConformance requires a DOM environment; `customElements` is undefined. '
      + 'Run this test under happy-dom (e.g. `// @vitest-environment happy-dom`).',
    );
  }

  const issues: Issue[] = [];
  const declared = declaredElements(options.manifest);

  // Snapshot BEFORE the first load so registration is judged by an
  // undefined -> defined transition, not by a global registry that some other
  // test or import may already have populated (see `loadEntry` docs).
  const definedBeforeLoad = new Set(declared.filter((name) => customElements.get(name)));

  try {
    await options.loadEntry();
  } catch (error) {
    return { ok: false, issues: [{ path: 'web.entry', code: 'entry_threw', message: errorMessage(error) }] };
  }

  for (const name of declared) {
    if (!customElements.get(name)) {
      issues.push({ path: `web.element.${name}`, code: 'element_not_registered', message: `custom element "${name}" was not defined after loading the web entry` });
    } else if (definedBeforeLoad.has(name) && !options.allowPreexistingElements) {
      issues.push({ path: `web.element.${name}`, code: 'element_preexisting', message: `custom element "${name}" was already defined before the entry loaded, so this entry's registration of it cannot be verified; run against a fresh registry or set allowPreexistingElements` });
    }
  }

  try {
    await options.loadEntry();
  } catch (error) {
    issues.push({ path: 'web.entry', code: 'entry_not_idempotent', message: `re-loading the web entry threw (likely an unguarded customElements.define): ${errorMessage(error)}` });
  }

  for (const probe of options.contracts ?? []) {
    let rejected = false;
    try {
      probe.parse(probe.badInput);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      issues.push({ path: `web.contract.${probe.label}`, code: 'context_not_validated', message: `host-context contract "${probe.label}" accepted an invalid context instead of rejecting it` });
    }
  }

  return { ok: issues.length === 0, issues };
}
