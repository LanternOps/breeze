/**
 * State rules for the app-wide toast host.
 *
 * Pure module (no React, no React Native) because the mobile app has no
 * component test runtime — `vitest.config.ts` deliberately only collects
 * `src/**\/*.test.ts` so component imports never drag RN/Expo into Vitest. The
 * two rules that can silently break (a replaced toast's stale timer taking the
 * new one down, and a toast painted twice when a Modal is open) therefore live
 * here where they can be tested.
 */

export type ToastKind = 'success' | 'error';

export interface ToastRequest {
  kind: ToastKind;
  text: string;
  /**
   * Opaque id of the row this toast is about. Optional, and only ApprovalScreen
   * uses it: a decision confirmation is dropped once focus rolls onto a
   * DIFFERENT pending approval (see `approvalDecidedTransition.ts`).
   */
  sourceId?: string | null;
}

export interface ToastEntry {
  /** Monotonic per-show id. Identifies which toast a dismiss belongs to. */
  id: number;
  kind: ToastKind;
  text: string;
  sourceId: string | null;
}

export type ToastAction =
  | { type: 'show'; id: number; request: ToastRequest }
  | { type: 'dismiss'; id: number };

/**
 * One toast at a time: a second `show` REPLACES the first rather than queueing
 * behind it (matching the per-screen behaviour this host replaced, where the
 * screen's single `toast` state was simply overwritten).
 *
 * `dismiss` is id-scoped on purpose. The replaced toast still owns a running
 * hold timer and an exit-animation callback, both scheduled before the
 * replacement landed; an unscoped dismiss would let that stale timer cut the
 * new toast's hold short.
 */
export function toastReducer(state: ToastEntry | null, action: ToastAction): ToastEntry | null {
  switch (action.type) {
    case 'show':
      return {
        id: action.id,
        kind: action.request.kind,
        text: action.request.text,
        sourceId: action.request.sourceId ?? null,
      };
    case 'dismiss':
      return state !== null && state.id === action.id ? null : state;
  }
}

/**
 * Which mounted outlet renders the toast.
 *
 * The host's own outlet lives at the root, below every RN `Modal`; a surface
 * that posts toasts from INSIDE a Modal (the approval takeover, the settings
 * sheet) mounts its own outlet so the toast is not stranded behind the sheet.
 * Outlet ids are allocated in mount order, so the highest mounted id is the
 * one actually on top — and rendering in only that one keeps a transparent
 * sheet from showing the same toast twice (once through its scrim, once above).
 */
export function topOutletId(ids: readonly number[]): number | null {
  let top: number | null = null;
  for (const id of ids) {
    if (top === null || id > top) top = id;
  }
  return top;
}

/**
 * Hard ceiling on how long one toast may stay on screen, as a JS-timer backstop
 * to the animation's own completion callback.
 *
 * Reanimated only invokes an animation callback when the animation actually
 * finishes; an interruption (app backgrounded mid-exit, a fast remount) skips
 * it and would otherwise wedge a toast on screen forever. Toast's own lifecycle
 * is enter 240ms + hold 1800ms + exit 180ms; this is comfortably past it.
 */
export const TOAST_BACKSTOP_MS = 4500;
