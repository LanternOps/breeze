import common from '@prompt-catalog/catalog/common.json';
import { DEFAULT_PROMPT_LOCALE, negotiatePromptLocale } from '@prompt-catalog/negotiate';

/*
 * Assist-owned chrome strings for prompt cards and the Notifications tab
 * (#10190, W03), read from the shared `common` catalog namespace through the
 * `@prompt-catalog` alias (plan P3). The agent renders the prompt copy itself;
 * these are only the strings Assist draws around it.
 *
 * Not renderPromptMessage: that throws on a missing parameter (right for the
 * agent and API), and a UI path must never throw. Here a missing parameter
 * stays literal.
 */

export type ChromeKey = keyof typeof common.messages;

const MESSAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = common.messages;

/** `{name}` only: `{remaining}` / `{time:<unixMs>}` are filled by placeholders.ts. */
const PARAM = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * The chrome string `key` in `locale` (any OS / BCP 47 / POSIX tag; negotiated
 * onto the eight prompt locales), falling back to `en`. Parameters are
 * substituted in a single pass, so a value is never re-read as a placeholder.
 */
export function chromeString(
  key: ChromeKey,
  locale: string | null | undefined,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const byLocale = MESSAGES[key];
  const text = byLocale?.[negotiatePromptLocale(locale ?? '')] ?? byLocale?.[DEFAULT_PROMPT_LOCALE] ?? key;
  return text.replace(PARAM, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}
