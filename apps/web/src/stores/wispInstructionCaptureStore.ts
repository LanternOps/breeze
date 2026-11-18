import { create } from 'zustand';
import type { CapturedInstructionDto, WispInstructionCaptureStatusResponse } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { registerLogoutHook } from './logoutHooks';

/**
 * Standing-instruction capture chips (Wisp self-knowledge). The API extracts a
 * standing instruction after the reply's `done`; the web polls the capture
 * status a handful of times, then shows the saved instruction under the reply.
 */

/** Waits before each poll: the first request goes out 2 s after the turn ends. */
const POLL_DELAYS_MS = [2000, 4000, 8000, 16000, 30000, 30000];
/** Answers that will not change on a retry: unknown or not yours (404), or no longer signed in. */
const FINAL_HTTP_STATUSES = new Set([401, 403, 404]);

interface WispInstructionCaptureState {
  bySession: Record<string, CapturedInstructionDto[]>;
  trackCapture: (sessionId: string, captureId: string) => void;
  loadSessionCaptures: (sessionId: string) => Promise<void>;
  applyInstructions: (sessionId: string, instructions: CapturedInstructionDto[]) => void;
  keep: (sessionId: string, instructionId: string) => Promise<void>;
  forget: (sessionId: string, instructionId: string) => Promise<void>;
  keepForOrg: (sessionId: string, instructionId: string) => Promise<void>;
  reset: () => void;
}

// Module-level bookkeeping, not render state. `generation` invalidates anything
// still in flight when the store is reset (sign-out is same-document).
let generation = 0;
const polling = new Map<string, ReturnType<typeof setTimeout>>();
const loadedSessions = new Set<string>();

function merge(
  current: CapturedInstructionDto[] | undefined,
  incoming: CapturedInstructionDto[],
): CapturedInstructionDto[] {
  const next = [...(current ?? [])];
  for (const dto of incoming) {
    const i = next.findIndex((d) => d.instructionId === dto.instructionId);
    if (i >= 0) next[i] = dto;
    else next.push(dto);
  }
  return next;
}

function clearBookkeeping(): void {
  generation++;
  for (const timer of polling.values()) clearTimeout(timer);
  polling.clear();
  loadedSessions.clear();
}

export const useWispInstructionCaptureStore = create<WispInstructionCaptureState>((set, get) => {
  const mutate = async (sessionId: string, instructionId: string, action: 'keep' | 'forget' | 'keep-for-org') => {
    const gen = generation;
    const res = await runAction<{ instructions: CapturedInstructionDto[] }>({
      request: () => fetchWithAuth(`/wisp/memory/captures/${encodeURIComponent(instructionId)}/${action}`, { method: 'POST' }),
      errorFallback: i18n.t('ai:wisp.instruction.actionFailed'),
      friendly: (code) => (code === 'cross_org' ? i18n.t('ai:wisp.instruction.crossOrg') : undefined),
    });
    if (gen === generation) get().applyInstructions(sessionId, res.instructions ?? []);
  };

  return {
    bySession: {},

    trackCapture: (sessionId, captureId) => {
      if (polling.has(captureId)) return;
      const gen = generation;
      const attempt = (index: number) => {
        const timer = setTimeout(async () => {
          if (gen !== generation) return;
          let terminal = false;
          try {
            const res = await fetchWithAuth(`/wisp/memory/captures/status/${encodeURIComponent(captureId)}`);
            if (gen !== generation) return;
            if (!res.ok) {
              if (FINAL_HTTP_STATUSES.has(res.status)) {
                console.warn('[wispInstructionCapture] status poll stopped', res.status);
                polling.delete(captureId);
                return;
              }
              // A 5xx or 429 (a deploy, a busy API) may clear: try again on the next step.
              console.warn('[wispInstructionCapture] status poll will retry', res.status);
            } else {
              const body = (await res.json()) as WispInstructionCaptureStatusResponse;
              if (gen !== generation) return;
              if (body.status !== 'pending') {
                terminal = true;
                if (body.status === 'saved') get().applyInstructions(sessionId, body.instructions ?? []);
              }
            }
          } catch (err) {
            // A network blip: try again on the next step.
            console.warn('[wispInstructionCapture] status poll failed; will retry', err);
            if (gen !== generation) return;
          }
          if (terminal || index + 1 >= POLL_DELAYS_MS.length) {
            polling.delete(captureId);
            return;
          }
          attempt(index + 1);
        }, POLL_DELAYS_MS[index]);
        polling.set(captureId, timer);
      };
      attempt(0);
    },

    loadSessionCaptures: async (sessionId) => {
      if (loadedSessions.has(sessionId)) return;
      loadedSessions.add(sessionId);
      const gen = generation;
      try {
        const res = await fetchWithAuth(`/wisp/memory/captures?sessionId=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { instructions?: CapturedInstructionDto[] };
        if (gen !== generation) return;
        get().applyInstructions(sessionId, body.instructions ?? []);
      } catch (err) {
        console.warn('[wispInstructionCapture] loading session captures failed', err);
        if (gen === generation) loadedSessions.delete(sessionId);
      }
    },

    applyInstructions: (sessionId, instructions) => {
      if (instructions.length === 0) return;
      set((s) => ({ bySession: { ...s.bySession, [sessionId]: merge(s.bySession[sessionId], instructions) } }));
    },

    keep: (sessionId, instructionId) => mutate(sessionId, instructionId, 'keep'),
    forget: (sessionId, instructionId) => mutate(sessionId, instructionId, 'forget'),
    keepForOrg: (sessionId, instructionId) => mutate(sessionId, instructionId, 'keep-for-org'),

    reset: () => {
      clearBookkeeping();
      set({ bySession: {} });
    },
  };
});

// Sign-out is same-document: drop the previous user's instructions and polls.
registerLogoutHook(() => useWispInstructionCaptureStore.getState().reset());
