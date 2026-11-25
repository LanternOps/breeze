import type { GoldenCase } from './goldenPrompts';

/**
 * Tuning prompts for `ai:tool-eval --suite tuning` (#12421): paraphrases used
 * to compare descriptions/examples A/B (`--examples off|on`) before a change.
 *
 * Synthetic paraphrases only: never a production query, never promoted to
 * GOLDEN_CASES (the golden set is the regression gate; a prompt tuned against
 * would inflate it). A prompt must not name a registry tool as a word, or the
 * case measures reading, not discovery (`tuningPromptNamesTool`, pinned by test).
 */
export const TUNING_CASES: readonly GoldenCase[] = [];

/** True when `prompt` contains any tool name as a whole word (snake_case names are one word). */
export function tuningPromptNamesTool(prompt: string, toolNames: readonly string[]): boolean {
  const words = new Set(prompt.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  return toolNames.some((name) => words.has(name.toLowerCase()));
}
