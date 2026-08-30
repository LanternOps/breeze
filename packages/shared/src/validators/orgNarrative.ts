import { z } from 'zod';
import {
  NARRATIVE_BULLETS_PER_SECTION_MAX,
  NARRATIVE_BULLET_MAX_CHARS,
  NARRATIVE_HEADLINE_MAX_CHARS,
  NARRATIVE_MARKDOWN_MAX_CHARS,
  NARRATIVE_SECTION_KEYS,
  NARRATIVE_SECTION_TITLES,
  type NarrativeOutcome,
  type NarrativeSection,
  type NarrativeSectionKey,
} from '../types/orgNarrativeReport';

/**
 * Every control/format codepoint — C0, DEL, C1, and the bidi overrides that
 * can visually reorder a rendered line. Mirrors `sanitizeSweepText`'s
 * treatment in `apps/api/src/services/aiAgents/runnerPrompt.ts`, and for the
 * same reason: a narrative bullet is interpolated into a LINE-ORIENTED
 * markdown document that an MSP forwards to their customer, so a bullet
 * containing a newline would forge extra document structure.
 *
 * The submission schema REJECTS these outright (the model has no legitimate
 * use for one); the renderer additionally FLATTENS them, because it also
 * renders sections that never went through the schema — a legacy stored
 * snapshot, or a hand-built `NarrativeSection[]`.
 *
 * `\p{C}` rather than a literal control-character class on purpose: the
 * escape is not itself a control character, so it neither trips
 * `no-control-regex` nor needs an eslint-disable for it.
 */
const CONTROL_OR_FORMAT = /\p{C}/u;

/**
 * Collapses one bullet (or the headline) to a single markdown-safe line.
 *
 * Two things happen, and both are load-bearing:
 *   1. every control/format codepoint becomes a space and runs of whitespace
 *      collapse — so the text can only ever occupy ONE line, whatever it
 *      contains;
 *   2. a leading run of markdown block markers (`#`, `-`, `*`, `+`, `>`) is
 *      stripped — so a bullet reading `## Forged heading` renders as a bullet
 *      saying "Forged heading", and `- - nested` cannot open a sub-list
 *      inside the list item we wrap it in.
 *
 * Only a REAL marker is stripped: CommonMark requires whitespace (or
 * end-of-line) after the marker, so `-5% free disk` and `#3 by ticket volume`
 * are ordinary text and survive intact. Stripping those would silently
 * rewrite what the bullet says, which is its own kind of wrong.
 *
 * Idempotent: `narrativeOutcomeFromSubmission` applies it when it builds the
 * stored sections, and the renderer applies it again, so the stored bullets
 * and the rendered markdown never disagree about what a bullet says.
 */
const LEADING_MARKDOWN_MARKER = /^[#\-*+>]+(\s|$)/;
function flattenNarrativeLine(value: string): string {
  let line = value.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  // Loop rather than a single pass: `- - nested` carries two markers, and
  // each iteration consumes at least one character, so this terminates.
  while (LEADING_MARKDOWN_MARKER.test(line)) {
    line = line.replace(/^[#\-*+>]+\s*/, '');
  }
  return line.trim();
}

/**
 * One model-authored string. Order of the checks matters: the length bound
 * and the control-character rejection both run against the RAW value, so a
 * 300-char bullet cannot slip through by being whitespace-padded and a
 * control character cannot be laundered by the collapse below. Only then does
 * the transform normalise runs of whitespace and trim.
 */
const narrativeText = (max: number, label: string) => z.string()
  .min(1, { message: `${label} must not be empty` })
  .max(max, { message: `${label} must be at most ${max} characters` })
  .refine((v) => v.trim().length > 0, { message: `${label} must not be blank` })
  .refine((v) => !CONTROL_OR_FORMAT.test(v), {
    message: `${label} must not contain control or format characters`,
  })
  // A string can be non-blank and still carry NO content once the renderer
  // has stripped its leading markdown markers — `'#'`, `'- '`, `'>'`. Left
  // to the builder to filter out, that produced a section with an h2 and
  // zero bullets, breaking the >=1-bullet invariant this schema promises
  // every downstream reader. So the schema refuses it here, against exactly
  // the transformation the renderer will apply.
  .refine((v) => flattenNarrativeLine(v).length > 0, {
    message: `${label} has no content once markdown markers are stripped`,
  })
  .transform((v) => v.replace(/\s+/g, ' ').trim());

const narrativeSectionSubmissionSchema = z.object({
  key: z.enum(NARRATIVE_SECTION_KEYS),
  bullets: z.array(narrativeText(NARRATIVE_BULLET_MAX_CHARS, 'bullet'))
    .min(1, { message: 'each section needs at least one bullet' })
    .max(NARRATIVE_BULLETS_PER_SECTION_MAX, {
      message: `each section may have at most ${NARRATIVE_BULLETS_PER_SECTION_MAX} bullets`,
    }),
}).strict();

/**
 * What the MODEL submits through the `submit_narrative` outcome tool.
 * `.strict()` at both levels so a model that invents `title`, `markdown`, or
 * `order` is rejected rather than silently having its extra key dropped — the
 * server owns all three (see `orgNarrativeReport.ts`'s file docstring).
 */
export interface NarrativeSubmission {
  headline: string;
  sections: Array<{ key: NarrativeSectionKey; bullets: string[] }>;
}

export const narrativeSubmissionSchema: z.ZodType<NarrativeSubmission> = z.object({
  headline: narrativeText(NARRATIVE_HEADLINE_MAX_CHARS, 'headline'),
  // Bounded at the exact section count so a submission cannot be arbitrarily
  // large before the superRefine below gets to name what is wrong with it.
  sections: z.array(narrativeSectionSubmissionSchema).max(NARRATIVE_SECTION_KEYS.length),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<NarrativeSectionKey>();
  const duplicated = new Set<NarrativeSectionKey>();
  for (const section of value.sections) {
    if (seen.has(section.key)) duplicated.add(section.key);
    else seen.add(section.key);
  }
  const missing = NARRATIVE_SECTION_KEYS.filter((key) => !seen.has(key));
  // Name the offending keys, not just a count: the model reads this message
  // back as a tool error and has to be able to fix its own submission from it.
  if (missing.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['sections'],
      message: `narrative is missing section(s): ${missing.join(', ')}`,
    });
  }
  if (duplicated.size > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['sections'],
      message: `narrative repeats section(s): ${[...duplicated].join(', ')}`,
    });
  }
});

/**
 * Derives the markdown body of a narrative. The SERVER is the only producer
 * of this string — see `orgNarrativeReport.ts`'s file docstring for why the
 * model never authors it.
 *
 * The result is capped at `NARRATIVE_MARKDOWN_MAX_CHARS`, truncated on a LINE
 * boundary: a mid-line cut could leave a half-written bullet that reads as a
 * complete (and wrong) statement, and could split a multi-byte character.
 */
export function renderNarrativeMarkdown(headline: string, sections: NarrativeSection[]): string {
  const lines: string[] = [`# ${flattenNarrativeLine(headline)}`];
  for (const section of sections) {
    lines.push('', `## ${flattenNarrativeLine(section.title)}`);
    for (const bullet of section.bullets) {
      const flattened = flattenNarrativeLine(bullet);
      if (flattened.length > 0) lines.push(`- ${flattened}`);
    }
  }

  const full = lines.join('\n');
  if (full.length <= NARRATIVE_MARKDOWN_MAX_CHARS) return full;

  let kept = '';
  for (const line of lines) {
    const next = kept.length === 0 ? line : `${kept}\n${line}`;
    if (next.length > NARRATIVE_MARKDOWN_MAX_CHARS) break;
    kept = next;
  }
  // Degenerate case: even the first line is over the cap (only reachable for
  // a headline that never went through the submission schema). Hard-slice
  // rather than return an empty document.
  return kept.length > 0 ? kept : full.slice(0, NARRATIVE_MARKDOWN_MAX_CHARS);
}

/**
 * Turns a validated `NarrativeSubmission` into the `NarrativeOutcome` stored
 * on the run: canonical section order, server-attached titles, and derived
 * markdown. This is the ONLY way a `NarrativeOutcome` should be constructed.
 *
 * The `?? []` on the lookup is defensive, not expected: a submission that
 * reached here through `narrativeSubmissionSchema` carries every key. A
 * caller that hand-builds a `NarrativeSubmission` gets an empty section
 * rather than a crash.
 */
export function narrativeOutcomeFromSubmission(submission: NarrativeSubmission): NarrativeOutcome {
  const byKey = new Map(submission.sections.map((section) => [section.key, section]));
  const sections: NarrativeSection[] = NARRATIVE_SECTION_KEYS.map((key) => ({
    key,
    title: NARRATIVE_SECTION_TITLES[key],
    // The `.filter` is belt-and-braces only: `narrativeSubmissionSchema` is
    // the gate that guarantees every bullet still has content after the
    // flatten (see `narrativeText`). It stays for a caller that hand-builds
    // a submission without parsing it first.
    bullets: (byKey.get(key)?.bullets ?? [])
      .map(flattenNarrativeLine)
      .filter((bullet) => bullet.length > 0),
  }));
  const headline = flattenNarrativeLine(submission.headline);
  return { version: 1, headline, sections, markdown: renderNarrativeMarkdown(headline, sections) };
}
