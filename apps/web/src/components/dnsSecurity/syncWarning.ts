import { showToast } from '../shared/Toast';

/**
 * The DNS security mutations (integration create, policy create, domain edit)
 * succeed even when the provider sync could not be scheduled, and say so via
 * `{ syncScheduled: false, warning }`. runAction only toasts the success
 * message, so surface the warning alongside it.
 */
export function surfaceSyncWarning(result: unknown): void {
  const warning = (result as { warning?: unknown } | null | undefined)?.warning;
  if (typeof warning === 'string' && warning) {
    showToast({ message: warning, type: 'warning' });
  }
}
