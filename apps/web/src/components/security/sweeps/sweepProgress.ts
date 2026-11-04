/**
 * Progress summary for one IOC sweep row (#6263 W05, PR C).
 *
 * `percent` is terminal children ÷ targeted devices; the tone turns to
 * `warning` whenever coverage is not clean (failed, expired or degraded
 * children, or a sweep that was cancelled or ran out of time).
 *
 * The label never calls a terminal child "done" (#10078): it says how many
 * devices finished, then names each non-zero terminal state, so a cancelled
 * sweep reads "2 of 2 devices finished · 1 completed · 1 cancelled".
 */
import type { SweepProgress, SweepSummary } from '@breeze/shared';
import { i18n } from '@/lib/i18n';

export type SweepProgressTone = 'info' | 'success' | 'warning';

export interface SweepProgressDescription {
  percent: number;
  label: string;
  tone: SweepProgressTone;
}

/** Terminal child states, in label order. Each maps to `sweeps.progress.<state>`. */
const TERMINAL_STATES = ['completed', 'timedOut', 'failed', 'cancelled', 'expired'] as const satisfies readonly (keyof SweepProgress)[];

export function describeSweepProgress(s: SweepSummary): SweepProgressDescription {
  const p = s.progress;
  const terminal = TERMINAL_STATES.reduce((sum, state) => sum + p[state], 0);
  const percent = s.targeted > 0 ? Math.min(100, Math.round((terminal / s.targeted) * 100)) : 0;
  const warn = p.failed + p.expired + p.degraded > 0 || s.state === 'cancelled' || s.state === 'expired';
  const tone: SweepProgressTone = warn ? 'warning' : s.state === 'completed' ? 'success' : 'info';
  const parts = [
    i18n.t('security:sweeps.progress.finished', { finished: terminal, count: s.targeted }),
    ...TERMINAL_STATES.filter((state) => p[state] > 0).map((state) =>
      i18n.t(/* i18n-dynamic */ `security:sweeps.progress.${state}`, { count: p[state] }),
    ),
  ];
  return { percent, tone, label: parts.join(' · ') };
}
