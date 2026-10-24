import { useMemo, useState } from 'react';
import { RefreshCw, Power, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { useEntitlement } from '@/hooks/useEntitlement';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useOrgStore } from '@/stores/orgStore';
import WispGrantStepUpModal from './WispGrantStepUpModal';

export type WispThreadHeaderProps = {
  wisp: NonNullable<WispState>;
  /** Name of the grant's org; ignored for a partner-wide grant. */
  orgName: string | null;
  wideningAvailable: boolean;
};

const STATUS_TONE: Record<NonNullable<WispState>['status'], string> = {
  active: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  paused: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  revoked: 'bg-red-500/15 text-red-600 dark:text-red-400',
  expired: 'bg-muted text-muted-foreground',
};

/** Floor/ceiling from W01 `wispLimitsSchema`; the server stays the authority (w00 A6). */
const TICK_MIN = 15;
const TICK_MAX = 240;

function readLimits(raw: unknown): { budgetMax: number | null; tickMin: number } {
  const l = (raw ?? {}) as { budgetCentsPerDayCeiling?: unknown; minFloorTickMinutes?: unknown };
  const budgetMax = typeof l.budgetCentsPerDayCeiling === 'number' ? l.budgetCentsPerDayCeiling : null;
  const minTick = typeof l.minFloorTickMinutes === 'number' ? l.minFloorTickMinutes : TICK_MIN;
  return { budgetMax, tickMin: Math.min(TICK_MAX, Math.max(TICK_MIN, minTick)) };
}

const clamp = (n: number, lo: number, hi: number | null) => Math.min(hi ?? Number.POSITIVE_INFINITY, Math.max(lo, Math.round(n)));

function handleMutationError(err: unknown, fallback: string) {
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
}

/**
 * The Wisp thread's header in the chat panel (W04 Task 8, spec §4.4/§6.1/§9):
 * scope, customer focus, grant status, refresh (primary when the user's live
 * reach has outgrown the grant), operational settings, and turn-off.
 */
export default function WispThreadHeader({ wisp, orgName, wideningAvailable }: WispThreadHeaderProps) {
  const { t } = useTranslation('ai');
  const exitWispMode = useAiStore((s) => s.exitWispMode);
  const setWispFocus = useAiStore((s) => s.setWispFocus);
  const updateWisp = useAiStore((s) => s.updateWisp);
  const organizations = useOrgStore((s) => s.organizations);
  const { limits } = useEntitlement('wisp');
  const { budgetMax, tickMin } = readLimits(limits);

  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [budget, setBudget] = useState(String(wisp.budgetCentsPerDay));
  const [tick, setTick] = useState(String(wisp.floorTickMinutes));
  const [saving, setSaving] = useState(false);
  const [focusPending, setFocusPending] = useState(false);

  // One focus change at a time: two racing PATCHes could leave the header
  // showing a focus the server no longer holds.
  const changeFocus = async (id: string | null) => {
    setFocusPending(true);
    try {
      await setWispFocus(id, id ? (focusOptions.find((o) => o.id === id)?.name ?? null) : null);
    } finally {
      setFocusPending(false);
    }
  };

  // An org grant can only focus its own org; a partner-wide grant offers the
  // orgs this token reaches (the ceiling re-check is the server's, w00 A24).
  const focusOptions = useMemo(() => {
    const all = (organizations ?? []).map((o) => ({ id: o.id, name: o.name }));
    const scoped = wisp.scopeOrgId ? all.filter((o) => o.id === wisp.scopeOrgId) : all;
    if (wisp.scopeOrgId && scoped.length === 0) scoped.push({ id: wisp.scopeOrgId, name: orgName ?? wisp.scopeOrgId });
    if (wisp.focusOrgId && !scoped.some((o) => o.id === wisp.focusOrgId)) {
      scoped.push({ id: wisp.focusOrgId, name: wisp.focusOrgName ?? wisp.focusOrgId });
    }
    return scoped.sort((a, b) => a.name.localeCompare(b.name));
  }, [organizations, wisp.scopeOrgId, wisp.focusOrgId, wisp.focusOrgName, orgName]);

  const revoke = async () => {
    setRevoking(true);
    const errorFallback = t('wisp.toast.offFailed');
    try {
      await runAction({
        request: () => fetchWithAuth(`/wisp/grants/${wisp.grantId}/revoke`, { method: 'POST' }),
        errorFallback,
        successMessage: t('wisp.toast.off'),
      });
      setConfirmRevoke(false);
      await exitWispMode();
    } catch (err) {
      handleMutationError(err, errorFallback);
    } finally {
      setRevoking(false);
    }
  };

  const openSettings = () => {
    setBudget(String(wisp.budgetCentsPerDay));
    setTick(String(wisp.floorTickMinutes));
    setSettingsOpen((v) => !v);
  };

  const saveSettings = async () => {
    // An emptied or non-numeric field means "leave as is" — never a budget of 0.
    const typed = (raw: string, current: number) => (raw.trim() === '' || !Number.isFinite(Number(raw)) ? current : Number(raw));
    const nextBudget = clamp(typed(budget, wisp.budgetCentsPerDay), 0, budgetMax);
    const nextTick = clamp(typed(tick, wisp.floorTickMinutes), tickMin, TICK_MAX);
    const patch: { budgetCentsPerDay?: number; floorTickMinutes?: number } = {};
    if (nextBudget !== wisp.budgetCentsPerDay) patch.budgetCentsPerDay = nextBudget;
    if (nextTick !== wisp.floorTickMinutes) patch.floorTickMinutes = nextTick;
    if (Object.keys(patch).length === 0) {
      setSettingsOpen(false);
      return;
    }
    setSaving(true);
    const errorFallback = t('wisp.toast.settingsFailed');
    try {
      const dto = await runAction<{ budgetCentsPerDay?: number; floorTickMinutes?: number }>({
        request: () => fetchWithAuth(`/wisp/grants/${wisp.grantId}/settings`, { method: 'PATCH', body: JSON.stringify(patch) }),
        errorFallback,
        successMessage: t('wisp.toast.settingsSaved'),
      });
      updateWisp({
        budgetCentsPerDay: typeof dto?.budgetCentsPerDay === 'number' ? dto.budgetCentsPerDay : nextBudget,
        floorTickMinutes: typeof dto?.floorTickMinutes === 'number' ? dto.floorTickMinutes : nextTick,
      });
      setSettingsOpen(false);
    } catch (err) {
      handleMutationError(err, errorFallback);
    } finally {
      setSaving(false);
    }
  };

  const scopeLabel = wisp.scopeOrgId === null ? t('wisp.header.scopeAll') : (orgName ?? '');
  const iconButton = 'rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground';

  return (
    <div className="space-y-2 border-b px-4 py-2 text-xs" data-testid="wisp-thread-header">
      <div className="flex items-center gap-2">
        <span className="truncate font-medium text-foreground" data-testid="wisp-scope">{scopeLabel}</span>
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_TONE[wisp.status]}`} data-testid="wisp-grant-status">
          {t(/* i18n-dynamic */ `wisp.header.status.${wisp.status}`)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="wisp-refresh-grant"
            data-variant={wideningAvailable ? 'primary' : 'secondary'}
            onClick={() => setRefreshOpen(true)}
            title={t('wisp.header.refresh')}
            className={
              wideningAvailable
                ? 'flex items-center gap-1 rounded bg-primary px-2 py-1 text-primary-foreground'
                : iconButton
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {wideningAvailable && <span>{t('wisp.header.refresh')}</span>}
          </button>
          <button type="button" data-testid="wisp-settings" onClick={openSettings} title={t('wisp.settings.title')} className={iconButton} aria-expanded={settingsOpen}>
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </button>
          <button type="button" data-testid="wisp-revoke" onClick={() => setConfirmRevoke(true)} title={t('wisp.header.revoke')} className={iconButton}>
            <Power className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {wideningAvailable && (
        <p className="text-amber-600 dark:text-amber-400" data-testid="wisp-widening">{t('wisp.header.widening')}</p>
      )}

      <label className="flex items-center gap-2">
        <span className="shrink-0 text-muted-foreground">{t('wisp.focus.label')}</span>
        <select
          data-testid="wisp-focus"
          aria-label={t('wisp.focus.label')}
          value={wisp.focusOrgId ?? ''}
          disabled={focusPending}
          onChange={(e) => void changeFocus(e.target.value || null)}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
        >
          <option value="">{t('wisp.focus.none')}</option>
          {focusOptions.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </label>

      {settingsOpen && (
        <div className="space-y-2 rounded border p-2" data-testid="wisp-settings-panel">
          <p className="font-medium">{t('wisp.settings.title')}</p>
          <label className="flex items-center justify-between gap-2">
            {t('wisp.settings.budget')}
            <input
              type="number"
              data-testid="wisp-settings-budget"
              min={0}
              max={budgetMax ?? undefined}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="w-24 rounded border bg-background px-2 py-1"
            />
          </label>
          <label className="flex items-center justify-between gap-2">
            {t('wisp.settings.tick')}
            <input
              type="number"
              data-testid="wisp-settings-tick"
              min={tickMin}
              max={TICK_MAX}
              value={tick}
              onChange={(e) => setTick(e.target.value)}
              className="w-24 rounded border bg-background px-2 py-1"
            />
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              data-testid="wisp-settings-save"
              disabled={saving}
              onClick={() => void saveSettings()}
              className="rounded bg-primary px-3 py-1 text-primary-foreground disabled:opacity-50"
            >
              {t('wisp.settings.save')}
            </button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => void revoke()}
        title={t('wisp.header.revoke')}
        message={t('wisp.header.revokeConfirm')}
        confirmLabel={t('wisp.header.revoke')}
        variant="destructive"
        isLoading={revoking}
        confirmTestId="wisp-revoke-confirm"
      />

      <WispGrantStepUpModal
        open={refreshOpen}
        defaultOrgId={wisp.scopeOrgId}
        refresh={{ grantId: wisp.grantId, orgId: wisp.scopeOrgId }}
        onClose={() => setRefreshOpen(false)}
        onGranted={(fresh) => {
          setRefreshOpen(false);
          updateWisp(fresh);
        }}
      />
    </div>
  );
}
