import common from './catalog/common.json';
import notice from './catalog/notice.json';
import { negotiatePromptLocale, type PromptLocale } from './negotiate';

/**
 * One file per namespace (plan P3). A wave that adds a namespace adds one
 * import and one line here, plus the agent embed copy.
 */
export const PROMPT_CATALOG = {
  common,
  notice,
} as const;

export type PromptNamespace = keyof typeof PROMPT_CATALOG;

/** Mirrors the Go sentinels ErrUnknownKey / ErrMissingParam. */
export type PromptCatalogErrorCode = 'unknown_key' | 'missing_param';

export class PromptCatalogError extends Error {
  readonly code: PromptCatalogErrorCode;

  constructor(code: PromptCatalogErrorCode, message: string) {
    super(message);
    this.name = 'PromptCatalogError';
    this.code = code;
  }
}

/** Placeholders the renderer fills itself; the catalog never substitutes them. */
const RENDERER_OWNED = new Set(['remaining', 'time']);

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)(?::[^{}]*)?\}/g;

/** Named parameters a message needs, sorted, excluding renderer-owned ones. */
export function promptMessagePlaceholders(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (!RENDERER_OWNED.has(m[1]!)) names.add(m[1]!);
  }
  return [...names].sort();
}

/**
 * Substitute `{name}` parameters in one pass, so a value is never re-read as a
 * placeholder; `{remaining}` and `{time:<unixMs>}` pass through for the
 * renderer. Throws PromptCatalogError('missing_param'). Mirrors Go `substitute`.
 */
export function substitutePromptParams(text: string, params: Readonly<Record<string, string>>, where = 'message'): string {
  return text.replace(PLACEHOLDER, (match, name: string) => {
    if (RENDERER_OWNED.has(name)) return match;
    if (!Object.hasOwn(params, name)) {
      throw new PromptCatalogError('missing_param', `${where} needs parameter "${name}"`);
    }
    return params[name]!;
  });
}

/**
 * Render one catalog message in `locale` (negotiated; anything outside the
 * eight renders en). Throws PromptCatalogError: 'unknown_key' for an unknown
 * namespace or key, 'missing_param' for a missing parameter (mirrors
 * promptcatalog.Render).
 */
export function renderPromptMessage(
  ns: PromptNamespace,
  key: string,
  locale: PromptLocale | string,
  params: Readonly<Record<string, string>> = {},
): string {
  if (!Object.hasOwn(PROMPT_CATALOG, ns)) {
    throw new PromptCatalogError('unknown_key', `unknown prompt catalog namespace "${ns}"`);
  }
  const messages = (PROMPT_CATALOG[ns] as { messages: Record<string, Record<string, string>> }).messages;
  if (!Object.hasOwn(messages, key)) {
    throw new PromptCatalogError('unknown_key', `unknown prompt catalog key "${ns}/${key}"`);
  }
  const byLocale = messages[key]!;
  const text = byLocale[negotiatePromptLocale(locale)] ?? byLocale.en!;
  return substitutePromptParams(text, params, `prompt catalog key "${ns}/${key}"`);
}
