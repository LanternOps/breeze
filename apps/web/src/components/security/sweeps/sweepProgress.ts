/**
 * Progress summary for one IOC sweep row (#6263 W05, PR C).
 *
 * `percent` is terminal children ÷ targeted devices; the tone turns to
 * `warning` whenever coverage is not clean (failed, expired or degraded
 * children, or a sweep that was cancelled or ran out of time).
 */
import type { SweepSummary } from '@breeze/shared';
import { i18n } from '@/lib/i18n';

export type SweepProgressTone = 'info' | 'success' | 'warning';

export interface SweepProgressDescription {
  percent: number;
  label: string;
  tone: SweepProgressTone;
}

export function describeSweepProgress(s: SweepSummary): SweepProgressDescription {
  const p = s.progress;
  const terminal = p.completed + p.timedOut + p.failed + p.cancelled + p.expired;
  const percent = s.targeted > 0 ? Math.min(100, Math.round((terminal / s.targeted) * 100)) : 0;
  const warn = p.failed + p.expired + p.degraded > 0 || s.state === 'cancelled' || s.state === 'expired';
  const tone: SweepProgressTone = warn ? 'warning' : s.state === 'completed' ? 'success' : 'info';
  return {
    percent,
    tone,
    label: i18n.t('security:sweeps.progress.label', { done: terminal, total: s.targeted }),
  };
}
