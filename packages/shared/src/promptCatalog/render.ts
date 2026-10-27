import common from './catalog/common.json';
import { negotiatePromptLocale, type PromptLocale } from './negotiate';

/**
 * One file per namespace (plan P3). A wave that adds a namespace adds one
 * import and one line here, plus the agent embed copy.
 */
export const PROMPT_CATALOG = {
  common,
} as const;

export type PromptNamespace = keyof typeof PROMPT_CATALOG;

export class PromptCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptCatalogError';
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
 * Render one catalog message. Parameters are substituted in a single pass, so a
 * value is never re-read as a placeholder. `{remaining}` and `{time:<unixMs>}`
 * pass through for the renderer. Throws on an unknown namespace or key, or a
 * missing parameter (mirrors promptcatalog.Render).
 */
export function renderPromptMessage(
  ns: PromptNamespace,
  key: string,
  locale: PromptLocale | string,
  params: Readonly<Record<string, string>> = {},
): string {
  const file = (PROMPT_CATALOG as Record<string, { messages: Record<string, Record<string, string>> }>)[ns];
  if (!file) throw new PromptCatalogError(`unknown prompt catalog namespace "${ns}"`);
  const byLocale = Object.prototype.hasOwnProperty.call(file.messages, key) ? file.messages[key] : undefined;
  if (!byLocale) throw new PromptCatalogError(`unknown prompt catalog key "${ns}/${key}"`);
  const text = byLocale[negotiatePromptLocale(locale)] ?? byLocale.en;
  if (text === undefined) throw new PromptCatalogError(`prompt catalog key "${ns}/${key}" has no en text`);
  return text.replace(PLACEHOLDER, (match, name: string) => {
    if (RENDERER_OWNED.has(name)) return match;
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new PromptCatalogError(`prompt catalog key "${ns}/${key}" needs parameter "${name}"`);
    }
    return params[name]!;
  });
}
