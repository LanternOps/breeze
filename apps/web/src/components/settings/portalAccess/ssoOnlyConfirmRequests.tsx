import { useEffect } from 'react';
import { create } from 'zustand';
import { i18n } from '@/lib/i18n';
import { showToast } from '../../shared/Toast';
import { SsoOnlyConfirmDialog } from './SsoOnlyConfirmDialog';
import type { SsoOnlyImpact } from './types';

/**
 * The partner header Save's `sso_only` confirmation (portal registration W4
 * #11381, D12). The save unit runs outside React (partnerSettings units), so it
 * asks through this store and awaits the answer; `SsoOnlyConfirmHost`, mounted
 * once on the partner settings page, renders the dialog.
 *
 * With no host mounted a request is declined at once (logged): a save must
 * never hang waiting for a dialog nobody can see, and declining writes nothing.
 */
interface PendingConfirm {
  impact: SsoOnlyImpact;
  /** A re-ask after a confirmed save met a newer impact. */
  changed: boolean;
  resolve: (confirmed: boolean) => void;
}

interface SsoOnlyConfirmState {
  pending: PendingConfirm | null;
  hosts: number;
  /** Answers the open request (no-op without one). */
  respond: (confirmed: boolean) => void;
}

export const useSsoOnlyConfirmRequests = create<SsoOnlyConfirmState>()((set, get) => ({
  pending: null,
  hosts: 0,
  respond: (confirmed) => {
    const { pending } = get();
    if (!pending) return;
    set({ pending: null });
    pending.resolve(confirmed);
  },
}));

/** Registers a mounted host; returns its unregister. */
export function registerSsoOnlyConfirmHost(): () => void {
  useSsoOnlyConfirmRequests.setState((s) => ({ hosts: s.hosts + 1 }));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    useSsoOnlyConfirmRequests.setState((s) => ({ hosts: Math.max(0, s.hosts - 1) }));
  };
}

/** Shows the impact and resolves true on Confirm, false on Cancel (or with no host). */
export function requestSsoOnlyConfirm(impact: SsoOnlyImpact, opts: { changed?: boolean } = {}): Promise<boolean> {
  const state = useSsoOnlyConfirmRequests.getState();
  if (state.hosts === 0) {
    console.warn('[ssoOnlyConfirm] no confirmation dialog is mounted; declining the sso_only save');
    showToast({ type: 'error', message: i18n.t('settings:portalAccessPolicy.errors.save') });
    return Promise.resolve(false);
  }
  // A newer request supersedes an unanswered one (which is declined).
  state.respond(false);
  return new Promise<boolean>((resolve) => {
    useSsoOnlyConfirmRequests.setState({ pending: { impact, changed: opts.changed ?? false, resolve } });
  });
}

/** The partner page's dialog for {@link requestSsoOnlyConfirm}. Mount once. */
export function SsoOnlyConfirmHost() {
  const pending = useSsoOnlyConfirmRequests((s) => s.pending);
  const respond = useSsoOnlyConfirmRequests((s) => s.respond);
  useEffect(() => {
    const unregister = registerSsoOnlyConfirmHost();
    return () => {
      unregister();
      // Unmounting with a request open declines it rather than leaving the save waiting.
      useSsoOnlyConfirmRequests.getState().respond(false);
    };
  }, []);
  return (
    <SsoOnlyConfirmDialog
      open={pending !== null}
      scope="partner"
      impact={pending?.impact ?? null}
      changed={pending?.changed ?? false}
      onConfirm={() => respond(true)}
      onCancel={() => respond(false)}
    />
  );
}
