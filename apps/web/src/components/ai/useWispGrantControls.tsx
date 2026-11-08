import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { showToast } from '@/components/shared/Toast';
import { useEntitlement } from '@/hooks/useEntitlement';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '@/stores/auth';
import { useAiStore, type WispState } from '@/stores/aiStore';
import { useOrgStore } from '@/stores/orgStore';
import WispGrantStepUpModal from './WispGrantStepUpModal';
import { spendMeterState } from '../wisp/wispSpend';

type Wisp = NonNullable<WispState>;

/** Floor/ceiling from W01 `wispLimitsSchema`; the server stays the authority (w00 A6). */
export const TICK_MIN = 15;
export const TICK_MAX = 240;

function readLimits(raw: unknown): { budgetMax: number | null; tickMin: number } {
  const l = (raw ?? {}) as { budgetCentsPerDayCeiling?: unknown; minFloorTickMinutes?: unknown };
  const budgetMax = typeof l.budgetCentsPerDayCeiling === 'number' ? l.budgetCentsPerDayCeiling : null;
  const minTick = typeof l.minFloorTickMinutes === 'number' ? l.minFloorTickMinutes : TICK_MIN;
  return { budgetMax, tickMin: Math.min(TICK_MAX, Math.max(TICK_MIN, minTick)) };
}

/** Daily budget is stored in cents; the input shows dollars with two decimals. */
export const centsToDollars = (cents: number) => (cents / 100).toFixed(2);

const clamp = (n: number, lo: number, hi: number | null) => Math.min(hi ?? Number.POSITIVE_INFINITY, Math.max(lo, Math.round(n)));

function handleMutationError(err: unknown, fallback: string) {
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: 'error', message: fallback });
}

export type WispGrantSettingsControls = {
  open: boolean;
  budget: string;
  setBudget: (v: string) => void;
  tick: string;
  setTick: (v: string) => void;
  saving: boolean;
  save: () => Promise<void>;
  budgetMax: number | null;
  tickMin: number;
  unattendedReadsOn: boolean;
  unattendedReadsSaving: boolean;
  toggleUnattendedReads: () => Promise<void>;
  summaryRefineOn: boolean;
  summaryRefineSaving: boolean;
  toggleSummaryRefine: () => Promise<void>;
};

export type WispGrantControls = {
  updateWisp: (patch: Partial<Wisp>) => void;
  focusOptions: Array<{ id: string; name: string }>;
  focusPending: boolean;
  changeFocus: (id: string | null) => Promise<void>;
  /** `enableUnattendedReads`: the same refresh, also turning the switch on (#10973). */
  openRefresh: (enableUnattendedReads: boolean) => void;
  askRevoke: () => void;
  /** Toggles the settings panel, or opens it whatever its state with `force`. */
  openSettings: (force?: boolean) => void;
  closeSettings: () => void;
  settings: WispGrantSettingsControls;
  /** #10142: the open conversation keeps the previous grant terms after a refresh. */
  showRefreshHint: boolean;
  startNewConversation: () => Promise<void>;
  dismissRefreshHint: () => void;
  /** An active grant whose day's budget is spent (the digest keeps running, w00). */
  budgetReached: boolean;
  scopeLabel: string;
  /** The turn-off confirm and the step-up refresh modal; render once. */
  dialogs: ReactNode;
};

export type UseWispGrantControlsArgs = {
  wisp: Wisp;
  orgName: string | null;
  onWispChange?: (patch: Partial<Wisp>) => void;
  onRevoked?: () => void | Promise<void>;
};

/**
 * The Wisp grant header's state and mutations (W04 Task 8, W06, #10142,
 * #10390, #10973), shared by the docked pane's header and the Wisp rail:
 * focus, refresh, turn-off, operational settings, and the refresh-keeps-terms
 * note. Layout lives with the callers.
 */
export function useWispGrantControls({ wisp, orgName, onWispChange, onRevoked }: UseWispGrantControlsArgs): WispGrantControls {
  const { t } = useTranslation('ai');
  const exitWispMode = useAiStore((s) => s.exitWispMode);
  const setWispFocus = useAiStore((s) => s.setWispFocus);
  const storeUpdateWisp = useAiStore((s) => s.updateWisp);
  const updateWisp = onWispChange ?? storeUpdateWisp;
  const chatSessionId = useAiStore((s) => s.sessionId);
  const chatGrantId = useAiStore((s) => s.wisp?.grantId ?? null);
  const closeSession = useAiStore((s) => s.closeSession);
  const enterWispMode = useAiStore((s) => s.enterWispMode);
  const organizations = useOrgStore((s) => s.organizations);
  const { limits } = useEntitlement('wisp');
  const { budgetMax, tickMin } = readLimits(limits);

  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [refreshEnables, setRefreshEnables] = useState(false);
  const [unattendedReadsSaving, setUnattendedReadsSaving] = useState(false);
  const [summaryRefineSaving, setSummaryRefineSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [budget, setBudget] = useState(centsToDollars(wisp.budgetCentsPerDay));
  const [tick, setTick] = useState(String(wisp.floorTickMinutes));
  const [saving, setSaving] = useState(false);
  const [focusPending, setFocusPending] = useState(false);
  /**
   * #10142: set by a refresh while a chat was open under this grant. A
   * session's grant revision is immutable (the server refuses to move it), so
   * that conversation keeps the previous terms; the note offers a fresh one.
   */
  const [refreshedUnder, setRefreshedUnder] = useState<{ sessionId: string; fresh: Wisp } | null>(null);
  const showRefreshHint = refreshedUnder !== null && refreshedUnder.sessionId === chatSessionId;

  const startNewConversation = async () => {
    const fresh = refreshedUnder?.fresh ?? wisp;
    setRefreshedUnder(null);
    try {
      // As the side panel's "New conversation": the old session's summary
      // lands on the thread, then the new one runs on the refreshed grant.
      if (chatSessionId) await closeSession();
      await enterWispMode(fresh);
    } catch (err) {
      console.error('[wisp] starting a new conversation after a refresh failed', err);
      showToast({ type: 'error', message: t('wisp.home.threadOpenFailed') });
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
      await (onRevoked ?? exitWispMode)();
    } catch (err) {
      handleMutationError(err, errorFallback);
    } finally {
      setRevoking(false);
    }
  };

  const openRefresh = (enableUnattendedReads: boolean) => {
    setRefreshEnables(enableUnattendedReads);
    setRefreshOpen(true);
  };

  // #10973: on widens what Wisp may do without asking, so it is a step-up
  // refresh (the modal); off never widens, so it autosaves here.
  const unattendedReadsOn = wisp.unattendedReads === true;
  const toggleUnattendedReads = async () => {
    if (!unattendedReadsOn) {
      openRefresh(true);
      return;
    }
    setUnattendedReadsSaving(true);
    const errorFallback = t('wisp.toast.unattendedReadsOffFailed');
    try {
      await runAction({
        request: () => fetchWithAuth(`/wisp/grants/${wisp.grantId}/settings`, { method: 'PATCH', body: JSON.stringify({ unattendedReads: false }) }),
        errorFallback,
        successMessage: t('wisp.toast.unattendedReadsOff'),
      });
      updateWisp({ unattendedReads: false });
    } catch (err) {
      handleMutationError(err, errorFallback);
    } finally {
      setUnattendedReadsSaving(false);
    }
  };

  // #10390: spend, not authority, so both directions autosave with no step-up.
  const summaryRefineOn = wisp.summaryRefine === true;
  const toggleSummaryRefine = async () => {
    const next = !summaryRefineOn;
    setSummaryRefineSaving(true);
    const errorFallback = t('wisp.toast.summaryRefineFailed');
    try {
      await runAction({
        request: () => fetchWithAuth(`/wisp/grants/${wisp.grantId}/settings`, { method: 'PATCH', body: JSON.stringify({ summaryRefine: next }) }),
        errorFallback,
        successMessage: next ? t('wisp.toast.summaryRefineOn') : t('wisp.toast.summaryRefineOff'),
      });
      updateWisp({ summaryRefine: next });
    } catch (err) {
      handleMutationError(err, errorFallback);
    } finally {
      setSummaryRefineSaving(false);
    }
  };

  const openSettings = (force = false) => {
    setBudget(centsToDollars(wisp.budgetCentsPerDay));
    setTick(String(wisp.floorTickMinutes));
    setSettingsOpen((v) => force || !v);
  };

  const saveSettings = async () => {
    // An emptied or non-numeric field means "leave as is" — never a budget of 0.
    const typed = (raw: string, current: number) => (raw.trim() === '' || !Number.isFinite(Number(raw)) ? current : Number(raw));
    // The field shows dollars; the API stays in cents.
    const typedBudgetCents = budget.trim() === '' || !Number.isFinite(Number(budget)) ? wisp.budgetCentsPerDay : Math.round(Number(budget) * 100);
    const nextBudget = clamp(typedBudgetCents, 0, budgetMax);
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

  // The grant stays active when the day's budget is spent (w00: the digest keeps running), so say so here.
  const budgetReached =
    wisp.status === 'active' && typeof wisp.spentTodayCents === 'number' && spendMeterState(wisp.spentTodayCents, wisp.budgetCentsPerDay) === 'exhausted';
  const scopeLabel = wisp.scopeOrgId === null ? t('wisp.header.scopeAll') : (orgName ?? '');

  const dialogs = (
    <>
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
        refresh={{ grantId: wisp.grantId, orgId: wisp.scopeOrgId, ...(refreshEnables ? { unattendedReads: true as const } : {}) }}
        onClose={() => setRefreshOpen(false)}
        onRefreshed={(grant) => {
          if (typeof grant?.unattendedReads === 'boolean') updateWisp({ unattendedReads: grant.unattendedReads });
        }}
        onGranted={(fresh) => {
          setRefreshOpen(false);
          updateWisp(fresh);
          setRefreshedUnder(chatSessionId && chatGrantId === wisp.grantId ? { sessionId: chatSessionId, fresh } : null);
        }}
      />
    </>
  );

  return {
    updateWisp,
    focusOptions,
    focusPending,
    changeFocus,
    openRefresh,
    askRevoke: () => setConfirmRevoke(true),
    openSettings,
    closeSettings: () => setSettingsOpen(false),
    settings: {
      open: settingsOpen,
      budget,
      setBudget,
      tick,
      setTick,
      saving,
      save: saveSettings,
      budgetMax,
      tickMin,
      unattendedReadsOn,
      unattendedReadsSaving,
      toggleUnattendedReads,
      summaryRefineOn,
      summaryRefineSaving,
      toggleSummaryRefine,
    },
    showRefreshHint,
    startNewConversation,
    dismissRefreshHint: () => setRefreshedUnder(null),
    budgetReached,
    scopeLabel,
    dialogs,
  };
}
