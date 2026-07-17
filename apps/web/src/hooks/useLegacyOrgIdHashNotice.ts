import { useEffect } from 'react';
import { showToast } from '@/components/shared/Toast';

/**
 * Pages that used to carry a page-local `#orgId=…` filter now defer org scoping
 * to the header switcher. A bookmark saved before that change still puts an
 * `orgId` in the hash — and because these pages no longer read it, the link
 * would silently broaden the view (e.g. show every org's invoices) while the
 * user believes they're scoped to one org. On money/records pages that's a
 * meaningful surprise.
 *
 * On mount, detect a leftover `orgId` in the hash, strip it (so a reload or
 * hashchange doesn't re-toast), and tell the user where org scoping lives now.
 * `enabled` lets callers that DO legitimately use `#orgId=` (e.g. an org-detail
 * embed pinning its org) opt out.
 */
export function useLegacyOrgIdHashNotice(message: string, enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    if (!params.has('orgId')) return;
    params.delete('orgId');
    const rest = params.toString();
    const url = window.location.pathname + window.location.search + (rest ? `#${rest}` : '');
    window.history.replaceState(null, '', url);
    showToast({ type: 'warning', message });
  }, [message, enabled]);
}
