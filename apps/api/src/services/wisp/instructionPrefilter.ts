/**
 * Standing-instruction prefilter (#10428).
 *
 * At the end of each chat turn Wisp runs this cheap deterministic check over
 * the USER's message. Only on a hit is a small model call made to extract
 * standing instructions ("don't reboot PC-01") to save as memory.
 *
 * Pasted-content hazard: consulting mode pastes customer email threads, so
 * "never reply to Bob" inside a quoted email is not the user's instruction.
 * Quoted lines (`>`) and fenced blocks (``` / ~~~) are removed before
 * matching. An unclosed fence removes everything to the end of the message.
 *
 * Matching runs on the capped text (the same text a model would see), not on
 * the uncapped cleaned text.
 */

export const INSTRUCTION_PREFILTER_MAX_CHARS = 4000;

const TRIGGER =
  /\b(?:don['’]t|do\s+not|never|always|avoid|prefer|stop|from\s+now\s+on|make\s+sure\s+(?:you|to))\b/i;

const FENCE_OPEN = /^\s*(```|~~~)/;

function stripQuotedAndFenced(message: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of message.split(/\r?\n/)) {
    const m = FENCE_OPEN.exec(line);
    if (fence) {
      if (m && m[1] === fence) fence = null;
      continue;
    }
    if (m) {
      fence = m[1]!;
      continue;
    }
    if (line.trimStart().startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

export function prefilterInstruction(userMessage: string): { hit: boolean; text: string } {
  const cleaned = stripQuotedAndFenced(userMessage).trim();
  const text = Array.from(cleaned).slice(0, INSTRUCTION_PREFILTER_MAX_CHARS).join('');
  return { hit: TRIGGER.test(text), text };
}
