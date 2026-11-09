/**
 * #10427 (W08 Task 2) — the post-turn promise linter.
 *
 * Wisp has said "Ask me to check back in about 5–10 minutes" after a tool that
 * dispatched nothing, and "I'll update or close that concern" without calling
 * a tool. This scans the finished reply for first-person commitments and
 * matches each against what this turn's tool results actually show
 * (`TurnEvidence`, built by `turnEvidence.ts`). A commitment with no backing
 * evidence yields one fixed, server-written correction line per class.
 *
 * Deliberately narrow, because a false correction is worse than a missed one:
 *  - a commitment is first person, future or completed ("I'll", "I will",
 *    "I've", "I have", "I'm going to") or a completed passive ("has been",
 *    "have been") within a few words of a verb in a known class;
 *  - an offer ("I can check back if you'd like", "you could schedule a scan")
 *    is not a commitment, nor is anything conditional on the user's say-so;
 *  - negations ("I will not follow up") are skipped;
 *  - a completed passive ("the scan has been queued") counts only when the
 *    turn tried a dispatch or called no tool at all: after a read-only call
 *    ("KB5034441 has been installed on 12 devices") it is a status report, and
 *    one with a time reference ("restarted 3 times since Monday") is a device
 *    fact either way;
 *  - a step that still needs approval ("which requires your approval") is a
 *    proposal, not a claim;
 *  - quoted (`>`) lines and fenced code are ignored.
 *
 * Pure: no I/O, no imports, so it is cheap to run before `done`.
 */

export type TurnEvidence = {
  /** A check-in was scheduled this turn, or a list call returned one that already exists. */
  checkInScheduled: boolean;
  /** A watch was created this turn, or a list call returned one that already exists. */
  watchCreated: boolean;
  /** A specialist was launched this turn; its report posts back to the thread on its own. */
  specialistLaunched: boolean;
  /** Dispatch-class tools that came back with evidence (an id) this turn. */
  dispatched: string[];
  /** Approval cards or intents raised this turn, or a step that waited for one. */
  pendingApprovals: number;
  /** An assessment was admitted, coalesced or upgraded this turn. */
  assessmentQueued: boolean;
  /** A concern was raised or changed this turn. */
  concernChanged: boolean;
  /** Tool calls this turn, of any kind (a passive claim after reads is a status report). */
  toolCalls: number;
  /** A dispatch-class tool was called this turn, whatever came back. */
  dispatchAttempted: boolean;
};

export type PromiseClass = 'follow_up' | 'dispatched' | 'concern';

export const FOLLOW_UP_CORRECTION = 'Correction: no follow-up is scheduled. Ask me to schedule a check-in, or set a watch.';
export const DISPATCH_CORRECTION = 'Correction: nothing was confirmed as dispatched this turn.';
export const CONCERN_CORRECTION = 'Correction: that concern was not changed this turn.';

const CORRECTIONS: Record<PromiseClass, string> = {
  follow_up: FOLLOW_UP_CORRECTION,
  dispatched: DISPATCH_CORRECTION,
  concern: CONCERN_CORRECTION,
};

/** Fixed report order, so two runs over the same text read the same. */
const CLASS_ORDER: readonly PromiseClass[] = ['follow_up', 'dispatched', 'concern'];

/** First-person commitments. Apostrophes are normalised to `'` before matching. */
const FIRST_PERSON = String.raw`\b(?:i'll|i will|i've|i have|i'm going to|i am going to)`;
/** Completed passive ("the scan has been queued"); dispatch class only. */
const PASSIVE = String.raw`\b(?:has|have) been`;
/** Up to three words between the marker and the verb ("I'll go ahead and check back"). */
const GAP = String.raw`((?:\s+[\w'-]+){0,3}?)`;

const FOLLOW_UP_VERBS = String.raw`(?:check(?:ing)? back|follow(?:ing)?[ -]up|let you know|remind(?:ing)?)`;
const DISPATCH_VERBS = String.raw`(?:queue[ds]?|sen[dt]|schedul(?:e|ed)|reboot(?:ed)?|restart(?:ed)?|install(?:ed)?|dispatch(?:ed)?)`;
const CONCERN_VERBS = String.raw`(?:updat(?:e|ed)|clos(?:e|ed)|resolv(?:e|ed)|dismiss(?:ed)?|snooz(?:e|ed))`;

const FOLLOW_UP_RE = new RegExp(`${FIRST_PERSON}${GAP}\\s+${FOLLOW_UP_VERBS}\\b`, 'i');
const DISPATCH_RE = new RegExp(`${FIRST_PERSON}${GAP}\\s+${DISPATCH_VERBS}\\b`, 'i');
const DISPATCH_PASSIVE_RE = new RegExp(`${PASSIVE}(\\s+\\w+ly)?\\s+${DISPATCH_VERBS}\\b`, 'i');
const CONCERN_RE = new RegExp(`${FIRST_PERSON}${GAP}\\s+${CONCERN_VERBS}(?:\\s+[\\w'-]+){0,3}?\\s+concerns?\\b`, 'i');

/** A word in the gap that turns the commitment around. */
const NEGATION_RE = /\b(?:not|never|no)\b|n't\b/i;
/** The sentence leaves the action to the user's say-so: an offer, not a promise. */
const OFFER_RE = /\bif (?:you(?:'d| would)? (?:like|want|prefer|approve)|needed|that helps)\b|\b(?:once|after|when) you approve\b|\bwith your approval\b|\b(?:requires?|needs?) (?:your )?approval\b|\bwant me to\b|\bwould you like\b|\b(?:shall|should) i\b/i;
/** A time reference makes a passive a historical fact about the device. */
const HISTORY_RE = /\b(?:\d+\s+times?|times|ago|since|last|recently|yesterday|earlier|previously|already|before)\b/i;

function lintableText(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n');
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s !== '');
}

function committed(re: RegExp, sentence: string): boolean {
  const m = re.exec(sentence);
  if (!m) return false;
  return !NEGATION_RE.test(m[1] ?? '');
}

function classesIn(sentence: string, lintPassive: boolean): PromiseClass[] {
  if (OFFER_RE.test(sentence)) return [];
  const out: PromiseClass[] = [];
  if (committed(FOLLOW_UP_RE, sentence)) out.push('follow_up');
  const passiveClaim = lintPassive && DISPATCH_PASSIVE_RE.test(sentence) && !HISTORY_RE.test(sentence);
  if (committed(DISPATCH_RE, sentence) || passiveClaim) {
    out.push('dispatched');
  }
  if (committed(CONCERN_RE, sentence)) out.push('concern');
  return out;
}

function backed(cls: PromiseClass, evidence: TurnEvidence): boolean {
  switch (cls) {
    case 'follow_up':
      return evidence.checkInScheduled || evidence.watchCreated || evidence.specialistLaunched;
    case 'dispatched':
      return evidence.dispatched.length > 0 || evidence.pendingApprovals > 0 || evidence.assessmentQueued;
    case 'concern':
      return evidence.concernChanged;
  }
}

export function lintTurnPromises(
  assistantText: string,
  evidence: TurnEvidence,
): { corrections: string[]; classes: PromiseClass[] } {
  const found = new Set<PromiseClass>();
  const lintPassive = evidence.dispatchAttempted || evidence.toolCalls === 0;
  for (const sentence of sentences(lintableText(assistantText))) {
    for (const cls of classesIn(sentence, lintPassive)) found.add(cls);
  }
  const classes = CLASS_ORDER.filter((cls) => found.has(cls) && !backed(cls, evidence));
  return { corrections: classes.map((cls) => CORRECTIONS[cls]), classes };
}
