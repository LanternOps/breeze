import type { TFunction } from 'i18next';
import { REARM_MODES, type LifecycleSource, type RearmMode } from '@breeze/shared';

const SOURCE_KEYS: Record<LifecycleSource, string> = {
  monitor: 'alertDetailPage.lifecycleLine.sources.monitor',
  org: 'alertDetailPage.lifecycleLine.sources.org',
  partner: 'alertDetailPage.lifecycleLine.sources.partner',
  builtin: 'alertDetailPage.lifecycleLine.sources.builtin',
  legacy: 'alertDetailPage.lifecycleLine.sources.legacy',
};

function isSource(value: unknown): value is LifecycleSource {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_KEYS, value);
}

/**
 * The line for the lifecycle this alert's episode opened with
 * (`alerts.context.lifecycle`), or null when it has no usable snapshot: opened
 * before W2, or a W1 context holding only the evidence cursor. The current
 * settings are deliberately not shown instead, because they may not be what
 * this episode runs on.
 */
export function alertLifecycleLine(t: TFunction, context: unknown): string | null {
  if (context === null || typeof context !== 'object') return null;
  const lifecycle = (context as { lifecycle?: unknown }).lifecycle;
  if (lifecycle === null || typeof lifecycle !== 'object') return null;
  const { rearmMode, rearmDelayMinutes, cooldownMinutes, sources } = lifecycle as Record<string, unknown>;

  if (!(REARM_MODES as readonly unknown[]).includes(rearmMode)) return null;
  if (!Number.isInteger(cooldownMinutes) || (cooldownMinutes as number) < 0) return null;
  const source = (sources as { cooldownMinutes?: unknown } | null | undefined)?.cooldownMinutes;
  if (!isSource(source)) return null;
  if ((rearmMode as RearmMode) === 'after_delay' && !Number.isInteger(rearmDelayMinutes)) return null;

  const rearm = rearmMode === 'after_delay'
    ? t('alerts:alertDetailPage.lifecycleLine.rearmAfterDelay', { minutes: rearmDelayMinutes })
    : t('alerts:alertDetailPage.lifecycleLine.rearmNewEvidence');
  return t('alerts:alertDetailPage.lifecycleLine.text', {
    rearm,
    minutes: cooldownMinutes,
    source: t(/* i18n-dynamic */ SOURCE_KEYS[source]),
  });
}
