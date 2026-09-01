/**
 * Phase 2 wave P2-3 (weekly org narrative) — the wire/type contract for the
 * `narrative`-profile run: what the MODEL submits, what the SERVER stores,
 * and how the stored shape renders into the weekly report.
 *
 * The split matters and is the whole point of this file. The model submits a
 * `NarrativeSubmission` — a headline plus eight keyed bullet lists, and
 * NOTHING else. It never authors section titles (the server attaches them
 * from `NARRATIVE_SECTION_TITLES`), never chooses section ORDER (the server
 * re-orders to `NARRATIVE_SECTION_KEYS`), and never authors markdown (the
 * server derives it with `renderNarrativeMarkdown`). A model that could emit
 * markdown directly could emit arbitrary document structure — headings,
 * links, images, HTML — into a report an MSP forwards to their customer.
 * Constraining it to bullets means the worst a bad submission can produce is
 * a wrong bullet, never a forged document.
 *
 * See `validators/orgNarrative.ts` for the schema and the two builders.
 */

/**
 * The eight sections of a weekly org narrative, in the order they render.
 * A closed, exhaustive list on purpose: the submission schema requires every
 * key exactly once, so a section can never silently go missing from a
 * customer-facing report because the model forgot it that week.
 */
export const NARRATIVE_SECTION_KEYS = [
  'overview',
  'alerts',
  'sweeps_and_fixes',
  'tickets',
  'patching_and_security',
  'backups',
  'fleet',
  'recommendations',
] as const;
export type NarrativeSectionKey = (typeof NARRATIVE_SECTION_KEYS)[number];

/**
 * Human titles the SERVER attaches to each section. Deliberately not part of
 * the model's submission: a title is chrome the customer reads as the
 * product's own voice, not content the model gets to choose per run (which
 * would make two consecutive weeks' reports structurally different).
 */
export const NARRATIVE_SECTION_TITLES: Readonly<Record<NarrativeSectionKey, string>> = Object.freeze({
  overview: 'Overview',
  alerts: 'Alerts',
  sweeps_and_fixes: 'Sweeps & fixes',
  tickets: 'Tickets',
  patching_and_security: 'Patching & security',
  backups: 'Backups',
  fleet: 'Fleet',
  recommendations: 'Recommendations',
});

/** Max characters in one bullet, enforced by `narrativeSubmissionSchema`. */
export const NARRATIVE_BULLET_MAX_CHARS = 240;
/** Max bullets in one section, enforced by `narrativeSubmissionSchema`. */
export const NARRATIVE_BULLETS_PER_SECTION_MAX = 8;
/** Max characters in the headline, enforced by `narrativeSubmissionSchema`. */
export const NARRATIVE_HEADLINE_MAX_CHARS = 160;
/**
 * Hard ceiling on the DERIVED markdown. The per-bullet and per-section caps
 * already bound a well-formed narrative (8 × 8 × 240 ≈ 15.5 KB worst case),
 * so this is the belt to those braces: whatever `renderNarrativeMarkdown` is
 * handed — including a legacy or hand-built `NarrativeSection[]` that never
 * went through the submission schema — the string it returns is bounded, and
 * truncation lands on a line boundary so the result is still valid markdown.
 */
export const NARRATIVE_MARKDOWN_MAX_CHARS = 12288;

/**
 * One section as STORED and RENDERED — the submission's `{ key, bullets }`
 * with the server-attached `title`. This is the shape that reaches the report
 * payload, the run DTO, and the web renderer.
 */
export interface NarrativeSection {
  key: NarrativeSectionKey;
  title: string;
  bullets: string[];
}

/**
 * `AgentRunOutcome.narrative` — built by `narrativeOutcomeFromSubmission`
 * from a validated `NarrativeSubmission`, never by the model directly.
 * `version` is the outcome's own schema version (independent of
 * `AI_AGENT_POLICY_SNAPSHOT_VERSION`); read sites must tolerate an unknown
 * future value rather than assuming 1.
 */
export interface NarrativeOutcome {
  version: 1;
  headline: string;
  sections: NarrativeSection[];
  markdown: string;
}

/**
 * `report_runs.result.summary.narrative` — the report-side snapshot of a
 * narrative. EVERY field is optional, including `narrative` itself: this is
 * persisted jsonb, so a snapshot written by an older build must still render
 * rather than throwing in the PDF renderer. Same convention as
 * `executiveSummaryReport.ts` and `postureReport.ts`.
 */
export interface OrgNarrativeReportSummary {
  narrative?: {
    version?: number;
    headline?: string;
    sections?: NarrativeSection[];
    markdown?: string;
    orgName?: string;
    partnerName?: string;
    /** ISO-8601. The reporting window the narrative covers. */
    periodStart?: string;
    periodEnd?: string;
    generatedAt?: string;
    runId?: string;
    agentName?: string;
    /**
     * True when the run's bounded context was cut short — the narrative is
     * still valid, but it did not see the whole week. Surfaced so the report
     * can say so rather than implying completeness it does not have.
     */
    contextTruncated?: boolean;
  };
}

/**
 * The safe projection of a `narrative`-profile run's outcome for
 * `GET /ai/agents/runs/:runId`'s detail DTO. Deliberately carries the
 * structured `sections` and NOT the derived `markdown`: the run detail view
 * renders the sections itself, and shipping a second copy of the same content
 * as a markdown blob doubles the payload for no reader.
 *
 * `reportRunId`/`reportId`/`downloadPath` are null until the narrative has
 * been materialised into a report run (and stay null for a run that never
 * produced one).
 */
export interface AiAgentRunNarrativeDto {
  headline: string;
  sections: NarrativeSection[];
  reportRunId: string | null;
  reportId: string | null;
  downloadPath: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  contextTruncated: boolean;
}
