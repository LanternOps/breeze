import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useAiStore } from '@/stores/aiStore';
import { usePermissions } from '@/lib/permissions';
import type { AiInitiatorKind, AiOriginSummaryDto } from '@breeze/shared';

/**
 * Who DECIDED a device mutation (#5022 W02, spec OD-9 A / OD-10 A).
 *
 * Deliberately a SEPARATE chip from `RunContextChip`
 * (`components/common/RunContext.tsx:192-226`): that chip encodes OS
 * execution privilege (system/user/elevated), which is orthogonal to AI
 * initiation. Overloading it would hide the privilege a tech most needs to
 * see on an AI-run script — this chip is meant to render BESIDE it, not
 * replace it.
 *
 * `kind === null` renders NOTHING — an unmarked row is absence of a marker,
 * never "a human did this" (no "Human"/"Manual" chip, no implying tooltip).
 *
 * The click-to-open popover is a provenance-disclosure surface, not a
 * mutation: it only ever resolves an authorized summary the caller already
 * has access to (`GET /devices/:id/ai-origin`) and never fabricates a link
 * the viewer cannot actually open — `resolvable` on the loaded summary is the
 * only thing that decides whether a session/run link renders.
 */

type AiInitiatorChipProps = {
  kind: AiInitiatorKind | null;
  /**
   * Called (once, then cached) when the chip is opened. Its mere presence IS
   * "this row has an origin worth a popover" — there is deliberately no
   * separate `hasOrigin` boolean: two independently-settable props gating one
   * behavior let a caller pass `loadOrigin` and forget the flag (or vice
   * versa) with no type error, silently degrading the chip to non-clickable
   * (#5022 W02 code review finding). Pass `undefined` when there's nothing to
   * resolve.
   */
  loadOrigin?: () => Promise<AiOriginSummaryDto | null>;
  className?: string;
  testId?: string;
};

export function AiInitiatorChip({
  kind,
  loadOrigin,
  className,
  testId = 'ai-initiator-chip',
}: AiInitiatorChipProps) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [summary, setSummary] = useState<AiOriginSummaryDto | null>(null);
  // #6396: "open session" drives the assistant sidebar, which is unmounted
  // for roles without ai_sessions:use — hide the link rather than dead-click.
  const canUseAi = usePermissions().can('ai_sessions', 'use');

  if (kind === null) return null;

  const clickable = !!loadOrigin;
  const label = kind === 'ai_agent' ? t('aiInitiator.agent') : t('aiInitiator.assistant');

  const chip = (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        // Distinct colour families from RunContextChip's amber/sky/red so the
        // two chips are never visually confused when shown side by side.
        kind === 'ai_agent'
          ? 'border-violet-500/40 bg-violet-500/15 text-violet-700 dark:text-violet-400'
          : 'border-indigo-500/40 bg-indigo-500/15 text-indigo-700 dark:text-indigo-400',
        className,
      )}
    >
      <Sparkles className="h-3 w-3" />
      {label}
    </span>
  );

  if (!clickable) return chip;

  const handleToggle = () => {
    setOpen((prev) => !prev);
    if (!loaded && loadOrigin) {
      setLoading(true);
      void loadOrigin()
        .then((result) => setSummary(result))
        .catch(() => {
          // Defensive: today's callers already resolve to null on failure,
          // but the chip's own correctness shouldn't depend on every future
          // caller's discipline (#5022 W02 code review finding). A rejection
          // falls through to the "origin unavailable" state, same as null.
          setSummary(null);
        })
        .finally(() => {
          setLoading(false);
          setLoaded(true);
        });
    }
  };

  return (
    <span className="relative inline-block">
      <button type="button" onClick={handleToggle} className="cursor-pointer">
        {chip}
      </button>
      {open && (
        <div className="absolute z-10 mt-1 w-64 rounded-md border bg-card p-3 text-xs shadow-lg">
          {loading && !loaded ? (
            <p className="text-muted-foreground">…</p>
          ) : summary ? (
            <div className="space-y-1.5">
              <p className="font-medium">{summary.label}</p>
              <p className="text-muted-foreground">
                {t('aiInitiator.occurredAt', { time: formatDateTime(summary.occurredAt) })}
              </p>
              {summary.toolName && (
                <p className="text-muted-foreground">
                  {t('aiInitiator.tool', { name: summary.toolName })}
                </p>
              )}
              {summary.resolvable && summary.session && canUseAi ? (
                <button
                  type="button"
                  data-testid="ai-origin-open-session"
                  className="font-medium text-primary hover:underline"
                  onClick={() => {
                    // Sessions open through the store, not a URL — there is
                    // no deep-link route today.
                    void useAiStore.getState().switchSession(summary.session!.id);
                    useAiStore.getState().open();
                  }}
                >
                  {t('aiInitiator.openSession')}
                </button>
              ) : summary.resolvable && summary.agentRun ? (
                <a
                  data-testid="ai-origin-open-run"
                  className="font-medium text-primary hover:underline"
                  href={`/ai-agents/runs/${summary.agentRun.id}`}
                >
                  {t('aiInitiator.openAgentRun')}
                </a>
              ) : (
                <p data-testid="ai-origin-unavailable" className="text-muted-foreground">
                  {t('aiInitiator.originUnavailable')}
                </p>
              )}
            </div>
          ) : (
            <p data-testid="ai-origin-unavailable" className="text-muted-foreground">
              {t('aiInitiator.originUnavailable')}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
