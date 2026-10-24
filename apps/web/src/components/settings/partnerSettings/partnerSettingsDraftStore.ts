import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { UNIT_TABS, type SaveOutcome, type SaveUnit, type SaveUnitId, type TabValidity } from './saveUnits';

/**
 * Drafts for the five self-contained partner-settings save units (Gate B 2).
 *
 * Page-scoped and never persisted: `PartnerSettingsPage` calls `reset()` on
 * unmount and `setPartner()` on every partner change, which resets when the
 * partner differs. Panels mount and unmount on every tab switch without losing
 * their draft, because the draft lives here rather than in the panel.
 *
 * Stale responses are dropped. Every load captures the store epoch (bumped by
 * `reset`) and a per-slice load generation; every save captures the epoch. A
 * response from an older epoch or an older load generation is ignored.
 */
export type DraftUnitId = Exclude<SaveUnitId, 'partnersMe'>;

export type SliceStatus = 'idle' | 'loading' | 'ready' | 'error';

export type Slice<T = unknown> = {
  status: SliceStatus;
  baseline: T | null;
  draft: T | null;
  revision?: number;
  validity: TabValidity;
  lastOutcome: SaveOutcome | null;
  savedAt: number | null;
};

export type LoadResult<T> = { value: T; revision?: number };
export type Loader<T> = () => Promise<LoadResult<T>>;

const DRAFT_UNIT_IDS: readonly DraftUnitId[] = ['callerVerification', 'loginBranding', 'trustCenter', 'aiFeatureDefaults', 'aiDataPolicy'];

const VALID: TabValidity = { isValid: true, invalidCount: 0, firstInvalidFieldId: null };

function emptySlice(): Slice {
  return { status: 'idle', baseline: null, draft: null, validity: VALID, lastOutcome: null, savedAt: null };
}

function emptySlices(): Record<DraftUnitId, Slice> {
  return Object.fromEntries(DRAFT_UNIT_IDS.map(id => [id, emptySlice()])) as Record<DraftUnitId, Slice>;
}

/** JSON with object keys sorted at every depth, so dirty checks ignore key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map(k => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

export function isSliceDirty(slice: Slice): boolean {
  return slice.status === 'ready' && stableStringify(slice.draft) !== stableStringify(slice.baseline);
}

// Non-serialisable bookkeeping lives outside the state object.
const inflight = new Map<DraftUnitId, Promise<void>>();
const loadGen = new Map<DraftUnitId, number>();
const lastLoader = new Map<DraftUnitId, Loader<unknown>>();

type DraftStore = {
  partnerId: string | null;
  epoch: number;
  slices: Record<DraftUnitId, Slice>;
  /** Records the current partner; a different partner resets every slice. */
  setPartner(partnerId: string | null): void;
  /** Loads a slice once per page session; concurrent callers share one request. */
  ensureLoaded<T>(id: DraftUnitId, loader: Loader<T>): Promise<void>;
  setDraft<T>(id: DraftUnitId, next: T | ((prev: T) => T)): void;
  setValidity(id: DraftUnitId, validity: TabValidity): void;
  /** baseline = draft = value (a fresh server copy). */
  rebaseline<T>(id: DraftUnitId, value: T, revision?: number): void;
  /** baseline = the snapshot that was sent; the draft is left as the user has it now. */
  markSaved<T>(id: DraftUnitId, sent: T, revision?: number): void;
  markOutcome(id: DraftUnitId, outcome: SaveOutcome | null): void;
  /** Forces a fresh load (the conflict notice's "Reload theirs"). */
  reloadFromServer<T>(id: DraftUnitId, loader?: Loader<T>): Promise<void>;
  /** The next `ensureLoaded` refetches. */
  invalidate(id: DraftUnitId): void;
  reset(): void;
};

export const usePartnerSettingsDraftStore = create<DraftStore>()((set, get) => {
  const patchSlice = (id: DraftUnitId, patch: Partial<Slice>) =>
    set(s => ({ slices: { ...s.slices, [id]: { ...s.slices[id], ...patch } } }));

  const load = (id: DraftUnitId, loader: Loader<unknown>): Promise<void> => {
    lastLoader.set(id, loader);
    const epoch = get().epoch;
    const gen = (loadGen.get(id) ?? 0) + 1;
    loadGen.set(id, gen);
    const isCurrent = () => get().epoch === epoch && loadGen.get(id) === gen;
    patchSlice(id, { status: 'loading' });
    const promise = (async () => {
      try {
        const { value, revision } = await loader();
        if (!isCurrent()) return;
        patchSlice(id, { status: 'ready', baseline: value, draft: value, revision, validity: VALID });
      } catch (err) {
        if (!isCurrent()) return;
        console.error(`[partnerSettings] loading ${id} failed`, err);
        patchSlice(id, { status: 'error' });
      } finally {
        // A newer load (reload, invalidate) owns the in-flight slot now.
        if (loadGen.get(id) === gen) inflight.delete(id);
      }
    })();
    inflight.set(id, promise);
    return promise;
  };

  return {
    partnerId: null,
    epoch: 0,
    slices: emptySlices(),

    setPartner(partnerId) {
      if (get().partnerId === partnerId) return;
      get().reset();
      set({ partnerId });
    },

    ensureLoaded(id, loader) {
      const pending = inflight.get(id);
      if (pending) return pending;
      if (get().slices[id].status === 'ready') return Promise.resolve();
      return load(id, loader as Loader<unknown>);
    },

    setDraft(id, next) {
      const slice = get().slices[id];
      if (slice.status !== 'ready') return;
      const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(slice.draft) : next;
      patchSlice(id, { draft: value });
    },

    setValidity(id, validity) {
      const current = get().slices[id].validity;
      if (current.isValid === validity.isValid && current.invalidCount === validity.invalidCount
        && current.firstInvalidFieldId === validity.firstInvalidFieldId) return;
      patchSlice(id, { validity });
    },

    rebaseline(id, value, revision) {
      patchSlice(id, { status: 'ready', baseline: value, draft: value, ...(revision !== undefined ? { revision } : {}) });
    },

    markSaved(id, sent, revision) {
      const savedAt = Date.now();
      patchSlice(id, {
        baseline: sent,
        ...(revision !== undefined ? { revision } : {}),
        lastOutcome: { status: 'saved', savedAt },
        savedAt,
      });
    },

    markOutcome(id, outcome) {
      patchSlice(id, { lastOutcome: outcome });
    },

    reloadFromServer(id, loader) {
      const fn = (loader as Loader<unknown> | undefined) ?? lastLoader.get(id);
      if (!fn) return Promise.resolve();
      patchSlice(id, { lastOutcome: null });
      return load(id, fn);
    },

    invalidate(id) {
      inflight.delete(id);
      loadGen.set(id, (loadGen.get(id) ?? 0) + 1);
      if (get().slices[id].status !== 'idle') patchSlice(id, { status: 'idle' });
    },

    reset() {
      inflight.clear();
      set(s => ({ epoch: s.epoch + 1, slices: emptySlices(), partnerId: null }));
    },
  };
});

/**
 * What a unit's request reports back. `value` is the server's copy of what was
 * saved; it replaces the draft only when the user has not edited since the
 * request was sent.
 */
export type SendResult<T> = { revision?: number; value?: T } | void;

/**
 * The shared body of a draft unit's `save()`: snapshot the draft, send it,
 * then re-baseline to that snapshot (or the server's copy of it). Drops the
 * result after a partner switch or page reset. Never throws: a request that
 * went through `runAction` has already toasted its error; anything else gets
 * the `errorFallback` toast here.
 */
export async function saveSlice<T>(
  id: DraftUnitId,
  send: (draft: T, revision: number | undefined) => Promise<SendResult<T>>,
  opts: { classifyError?: (err: unknown) => 'failed' | 'conflict'; errorFallback?: string } = {}
): Promise<SaveOutcome> {
  const store = usePartnerSettingsDraftStore.getState();
  const slice = store.slices[id] as Slice<T>;
  if (slice.status !== 'ready' || slice.draft === null) return { status: 'failed' };
  const sent = slice.draft;
  const epoch = store.epoch;
  const current = () => usePartnerSettingsDraftStore.getState();
  try {
    const result = await send(sent, slice.revision);
    if (current().epoch !== epoch) return { status: 'cancelled' };
    const revision = result ? result.revision : undefined;
    const untouched = current().slices[id].draft === sent;
    if (result && result.value !== undefined && untouched) {
      current().rebaseline(id, result.value, revision);
      current().markSaved(id, result.value);
    } else {
      // An edit made during the request stays dirty against what was sent.
      current().markSaved(id, sent, revision);
    }
    return current().slices[id].lastOutcome ?? { status: 'saved', savedAt: Date.now() };
  } catch (err) {
    if (current().epoch !== epoch) return { status: 'cancelled' };
    if (!(err instanceof ActionError)) {
      console.error(`[partnerSettings] saving ${id} failed`, err);
      if (opts.errorFallback) showToast({ type: 'error', message: opts.errorFallback });
    }
    const outcome: SaveOutcome = { status: opts.classifyError?.(err) ?? 'failed' };
    current().markOutcome(id, outcome);
    return outcome;
  }
}

/**
 * A panel's view of its slice: loads it on mount (once per page session) and
 * exposes the draft setter plus a retry for the error state.
 */
export function useDraftSlice<T>(id: DraftUnitId, loader: Loader<T>) {
  const slice = usePartnerSettingsDraftStore(s => s.slices[id]) as Slice<T>;
  const ensureLoaded = usePartnerSettingsDraftStore(s => s.ensureLoaded);
  useEffect(() => {
    void ensureLoaded(id, loader);
    // The loader is a stable module-level function per unit; one load per mount is the contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, ensureLoaded]);
  const setDraft = useCallback(
    (next: T | ((prev: T) => T)) => usePartnerSettingsDraftStore.getState().setDraft<T>(id, next),
    [id]
  );
  const retry = useCallback(() => { void usePartnerSettingsDraftStore.getState().ensureLoaded(id, loader); }, [id, loader]);
  return { slice, setDraft, retry };
}

/**
 * A draft slice as a header-Save unit. Subscribes to the slice, so the page
 * re-renders its status line and dirty dots as the draft changes.
 */
export function useDraftSaveUnit<T>(
  id: DraftUnitId,
  save: () => Promise<SaveOutcome>,
  opts: {
    /** Derives validity from the draft; without it the slice's stored validity is used. */
    validate?: (draft: T) => TabValidity;
    /** A unit-specific dirty check (e.g. set-valued fields); defaults to a stable JSON compare. */
    isDirty?: (baseline: T, draft: T) => boolean;
  } = {}
): SaveUnit {
  const slice = usePartnerSettingsDraftStore(s => s.slices[id]) as Slice<T>;
  const { validate, isDirty } = opts;
  return useMemo(() => {
    const [tab] = UNIT_TABS[id];
    const ready = slice.status === 'ready' && slice.draft !== null && slice.baseline !== null;
    const validity = validate && ready ? validate(slice.draft as T) : slice.validity;
    const dirty = ready && isDirty ? isDirty(slice.baseline as T, slice.draft as T) : isSliceDirty(slice);
    return {
      id,
      tabs: UNIT_TABS[id],
      isDirty: () => dirty,
      validity: () => ({ [tab]: validity }),
      save,
    };
  }, [id, slice, save, validate, isDirty]);
}
