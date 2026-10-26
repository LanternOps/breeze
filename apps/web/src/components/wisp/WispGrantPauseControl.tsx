import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { showToast } from '@/components/shared/Toast';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import type { WispGrantStatus, WispState } from '@/stores/aiStore';
import { canPause, canResume } from './wispSpend';

type Patch = Partial<NonNullable<WispState>>;

export type WispGrantPauseControlProps = {
  wisp: NonNullable<WispState>;
  onChange: (patch: Patch) => void;
};

const STATUSES: ReadonlySet<string> = new Set<WispGrantStatus>(['active', 'paused', 'revoked', 'expired']);

/** The W02 grant DTO the pause/resume routes answer with; tolerant of an older body. */
function patchFromDto(dto: unknown, fallback: { status: WispGrantStatus; pausedReason: string | null }): Patch {
  const d = (dto ?? {}) as { status?: unknown; pausedReason?: unknown };
  return {
    status: typeof d.status === 'string' && STATUSES.has(d.status) ? (d.status as WispGrantStatus) : fallback.status,
    pausedReason: typeof d.pausedReason === 'string' ? d.pausedReason : d.pausedReason === null ? null : fallback.pausedReason,
  };
}

/**
 * "Pause Wisp" / "Resume" (W06 Task 15, w00 A29). Pausing needs no step-up —
 * it never widens anything; resume is offered only for a user pause.
 */
export default function WispGrantPauseControl({ wisp, onChange }: WispGrantPauseControlProps) {
  const { t } = useTranslation('ai');
  const [busy, setBusy] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The thread payload does not carry `pausedReason` (W04 shape); learn it
  // once from the grant list so a user-paused grant can be resumed after a reload.
  const lookupFor = useRef<string | null>(null);
  useEffect(() => {
    if (wisp.status !== 'paused' || wisp.pausedReason !== undefined || lookupFor.current === wisp.grantId) return;
    lookupFor.current = wisp.grantId;
    let live = true;
    void (async () => {
      try {
        const res = await fetchWithAuth('/wisp/grants');
        if (!res.ok) throw new Error(`wisp grants list failed: ${res.status}`);
        const body = (await res.json()) as { grants?: Array<{ id?: unknown; pausedReason?: unknown }> } | null;
        const row = body?.grants?.find((g) => g.id === wisp.grantId);
        if (!row) {
          console.error('[WispGrantPauseControl] grant missing from GET /wisp/grants; Resume stays disabled', wisp.grantId);
          return;
        }
        if (live) onChangeRef.current({ pausedReason: typeof row.pausedReason === 'string' ? row.pausedReason : null });
      } catch (err) {
        // Resume stays disabled (the safe default); the server would refuse a system pause anyway.
        console.error('[WispGrantPauseControl] reading the pause reason failed', err);
      }
    })();
    return () => { live = false; };
  }, [wisp.grantId, wisp.status, wisp.pausedReason]);

  const mutate = async (verb: 'pause' | 'resume') => {
    if (busy) return;
    setBusy(true);
    const errorFallback = verb === 'pause' ? t('wisp.toast.pauseFailed') : t('wisp.toast.resumeFailed');
    try {
      const dto = await runAction<unknown>({
        request: () => fetchWithAuth(`/wisp/grants/${wisp.grantId}/${verb}`, { method: 'POST' }),
        errorFallback,
        successMessage: verb === 'pause' ? t('wisp.toast.paused') : t('wisp.toast.resumed'),
      });
      onChange(patchFromDto(dto, verb === 'pause' ? { status: 'paused', pausedReason: 'user_paused' } : { status: 'active', pausedReason: null }));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: errorFallback }); // ActionError already toasted
    } finally {
      setBusy(false);
    }
  };

  if (wisp.status !== 'active' && wisp.status !== 'paused') return null;

  const button = 'flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-muted disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="wisp-pause-control">
      {canPause(wisp.status) ? (
        <button type="button" data-testid="wisp-pause" disabled={busy} onClick={() => void mutate('pause')} className={button}>
          <Pause className="h-3 w-3" />
          {t('wisp.pause')}
        </button>
      ) : (
        wisp.pausedReason === 'partner_disabled' ? (
          // A partner administrator's switch, not the grantor's pause: nothing to resume here (#10145).
          <span className="text-amber-600 dark:text-amber-400" data-testid="wisp-paused-partner-disabled">{t('wisp.paused.partnerDisabled')}</span>
        ) : (
        <>
          {wisp.pausedReason === 'user_paused' && (
            <span className="text-amber-600 dark:text-amber-400" data-testid="wisp-paused-by-you">{t('wisp.paused.byYou')}</span>
          )}
          <button
            type="button"
            data-testid="wisp-resume"
            disabled={busy || !canResume(wisp.status, wisp.pausedReason)}
            onClick={() => void mutate('resume')}
            className={button}
          >
            <Play className="h-3 w-3" />
            {t('wisp.resume')}
          </button>
        </>
        )
      )}
    </div>
  );
}
