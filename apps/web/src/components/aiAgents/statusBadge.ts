/**
 * Shared badge tone system for AI Agents surfaces (runs list, run detail,
 * graduation panel). Consolidates the light-only `bg-<hue>-500/10
 * text-<hue>-700` badge pattern found in RunsListPage/RunDetailPage into a
 * dark-mode-aware `bg-<hue>-100 text-<hue>-800 dark:bg-<hue>-950/50
 * dark:text-<hue>-200` pattern, matching the convention already used by
 * ApprovalsInbox's `riskClass` map.
 */

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent' | 'muted';

/**
 * Light/dark class pairs per tone. Every entry MUST carry a `dark:`
 * counterpart for each colour utility — this is what keeps AA contrast in
 * both themes and is asserted by statusBadge.test.ts.
 */
const TONE_CLASSES: Record<BadgeTone, string> = {
  // Matches the muted-slate convention used elsewhere (NotificationCenter,
  // SeverityBadge) for "no strong signal" states.
  neutral: 'bg-slate-100 text-slate-800 dark:bg-slate-950/50 dark:text-slate-200',
  // Distinct from `neutral`: lower-emphasis, for explicitly "off"/inactive
  // states rather than "no signal yet".
  muted: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-400',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200',
  success: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  danger: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200',
  // Matches the violet used for the "narrative" run-profile tag in
  // RunsListPage/RunDetailPage.
  accent: 'bg-violet-100 text-violet-800 dark:bg-violet-950/50 dark:text-violet-200',
};

const SIZE_CLASSES: Record<'sm' | 'md', string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2.5 py-0.5 text-xs',
};

/**
 * Tailwind classes for a pill badge; light + dark, AA contrast in both.
 * Includes padding/rounded/text-xs/font-medium/inline-flex.
 */
export function badgeClass(tone: BadgeTone, opts?: { size?: 'sm' | 'md' }): string {
  const size = opts?.size ?? 'md';
  return `inline-flex items-center rounded-full font-medium ${SIZE_CLASSES[size]} ${TONE_CLASSES[tone]}`;
}

/**
 * Run status → tone. Covers every `AiAgentRunStatus` value referenced in
 * RunsListPage/RunDetailPage's status maps and label switches (queued,
 * running, awaiting_approval, completed, failed, cancelled, expired,
 * skipped), plus the `succeeded`/`errored` synonyms used elsewhere.
 */
export function runStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'queued':
    case 'running':
      return 'info';
    case 'awaiting_approval':
      return 'warning';
    case 'succeeded':
    case 'completed':
      return 'success';
    case 'failed':
    case 'errored':
      return 'danger';
    // Operator-initiated stop, not a failure — see statusBadge.test.ts.
    case 'cancelled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** Verdict → tone, matching RunsListPage's verdictBadgeClass map. */
export function verdictTone(verdict: string): BadgeTone {
  switch (verdict) {
    case 'remediated':
      return 'success';
    case 'partial':
      return 'warning';
    case 'needs_attention':
      return 'danger';
    default:
      return 'neutral';
  }
}

/**
 * Graduation state → tone, matching AI_AGENT_GRADUATION_STATES
 * (`tracking` | `eligible` | `promoted` | `demoted`) from
 * AiAgentGraduationPanel / packages/shared/src/types/aiAgentGraduation.ts.
 */
export function graduationTone(state: string): BadgeTone {
  switch (state) {
    case 'tracking':
      return 'neutral';
    case 'eligible':
      return 'info';
    case 'promoted':
      return 'success';
    case 'demoted':
      return 'danger';
    default:
      return 'neutral';
  }
}

/**
 * Agent mode → tone, matching AI_AGENT_MODES (`off` | `shadow` | `act`) from
 * packages/shared/src/types/aiAgents.ts.
 */
export function modeTone(mode: string): BadgeTone {
  switch (mode) {
    case 'off':
      return 'muted';
    case 'shadow':
      return 'info';
    case 'act':
      return 'warning';
    default:
      return 'neutral';
  }
}
