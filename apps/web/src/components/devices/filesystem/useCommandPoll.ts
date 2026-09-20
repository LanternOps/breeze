/**
 * Poll one device command to a terminal state (spec §8).
 *
 * The version this replaces (DeviceFilesystemTab.tsx:352-404) ran a `while`
 * loop of `await new Promise(r => setTimeout(r, delay))` with no link to the
 * component's lifetime: navigating away from the tab mid-scan left the loop
 * polling for the rest of the session and then calling setState on a dead
 * component. Here the loop and every request it makes hang off ONE
 * AbortController that the unmount effect aborts, and the pending sleep is a
 * cancellable timer rather than an uninterruptible promise.
 *
 * `poll` REJECTS rather than returning a status because every caller has to
 * branch on failure anyway, and a rejected promise cannot be ignored by
 * accident the way a returned 'failed' can.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import '@/lib/i18n';

/** Thrown when the component unmounted while a poll was in flight. */
export class CommandPollAbortedError extends Error {
  constructor() {
    super('command poll aborted');
    this.name = 'CommandPollAbortedError';
  }
}

const INITIAL_DELAY_MS = 2_000;
const MAX_DELAY_MS = 10_000;
const BACKOFF_FACTOR = 1.5;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function useCommandPoll(deviceId: string): {
  status: string | null;
  poll: (commandId: string, timeoutMs: number) => Promise<void>;
  reset: () => void;
} {
  const { t } = useTranslation('devices');
  const [status, setStatus] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    controllerRef.current?.abort();
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  const reset = useCallback(() => {
    setStatus(null);
  }, []);

  const poll = useCallback(
    async (commandId: string, timeoutMs: number): Promise<void> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      const startedAt = Date.now();
      let delayMs = INITIAL_DELAY_MS;

      // A cancellable sleep. `await new Promise(r => setTimeout(r, d))` cannot
      // be interrupted, so an unmount during the sleep still resumed the loop.
      const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new CommandPollAbortedError());
            return;
          }
          const timer = setTimeout(() => {
            controller.signal.removeEventListener('abort', onAbort);
            resolve();
          }, ms);
          timerRef.current = timer;
          function onAbort() {
            clearTimeout(timer);
            reject(new CommandPollAbortedError());
          }
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });

      while (Date.now() - startedAt < timeoutMs) {
        if (controller.signal.aborted) throw new CommandPollAbortedError();

        const response = await fetchWithAuth(
          `/devices/${deviceId}/commands/${commandId}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) throw new CommandPollAbortedError();

        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(
            (body && typeof body.error === 'string' && body.error)
            || t('deviceFilesystemTab.failedToFetchScanStatus'),
          );
        }

        const body = await response.json();
        const command = asRecord(body?.data);
        if (!command) throw new Error(t('deviceFilesystemTab.failedToFetchScanStatus'));

        const commandStatus = typeof command.status === 'string' ? command.status : 'pending';
        setStatus(commandStatus);

        if (commandStatus === 'completed') return;
        if (commandStatus === 'failed') {
          const result = asRecord(command.result);
          throw new Error(
            typeof result?.error === 'string' && result.error
              ? result.error
              : t('deviceFilesystemTab.filesystemScanFailed'),
          );
        }

        await sleep(delayMs);
        delayMs = Math.min(MAX_DELAY_MS, Math.round(delayMs * BACKOFF_FACTOR));
      }

      throw new Error(t('deviceFilesystemTab.scanStillRunning'));
    },
    [deviceId, t],
  );

  return { status, poll, reset };
}
