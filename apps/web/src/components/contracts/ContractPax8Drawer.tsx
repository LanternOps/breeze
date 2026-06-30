import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchWithAuth, AuthSessionExpiredError } from '../../stores/auth';
import LinkSubscriptionPicker from '../integrations/LinkSubscriptionPicker';

interface Pax8Subscription {
  id: string;
  orgId: string | null;
  productName: string | null;
  vendorName: string | null;
  quantity: number | null;
  unitPrice: string | null;
  currencyCode: string | null;
  contractLineId: string | null;
}

/** Format the Pax8 sell price for the pick list so the numeric value shown is the
 *  same 2-decimal value the link form prefills (see toPriceInput in
 *  LinkSubscriptionPicker), wrapped with the currency for display. Omitted
 *  entirely for missing, zero, or unparseable prices. */
function sellPriceLabel(unitPrice: string | null, currencyCode: string | null): string | null {
  if (unitPrice == null) return null;
  const n = Number.parseFloat(unitPrice);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${currencyCode ?? 'USD'} ${n.toFixed(2)}/ea`;
}

interface Props {
  open: boolean;
  /** The contract's organization — scopes which Pax8 subscriptions are offered. */
  orgId: string;
  integrationId: string;
  onClose: () => void;
  /** Called after a subscription is linked so the host reloads the contract. */
  onLinked: () => void;
}

/**
 * Contract-first Pax8 linking: lists the org's synced Pax8 subscriptions and,
 * on selection, hands off to the shared LinkSubscriptionPicker (which owns the
 * create-line + link + MFA flow). This surfaces Pax8 inside the contract editor
 * instead of only the Integrations panel; the link plumbing is unchanged.
 */
export default function ContractPax8Drawer({ open, orgId, integrationId, onClose, onLinked }: Props) {
  const [subs, setSubs] = useState<Pax8Subscription[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Pax8Subscription | null>(null);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; document.removeEventListener('keydown', onKey); };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) { setSubs(null); setError(null); setPicked(null); return; }
    void (async () => {
      try {
        const res = await fetchWithAuth(`/pax8/subscriptions?orgId=${encodeURIComponent(orgId)}&limit=100`);
        if (!res.ok) { setError('Could not load Pax8 subscriptions for this organization.'); setSubs([]); return; }
        const body = (await res.json().catch(() => null)) as { data?: Pax8Subscription[] } | null;
        setSubs(body?.data ?? []);
      } catch (err) {
        // A thrown fetch (network failure) must fail loud, not strand the drawer on
        // "Loading subscriptions…" forever. Auth expiry self-redirects, so skip it.
        if (err instanceof AuthSessionExpiredError) return;
        setError('Could not load Pax8 subscriptions for this organization.');
        setSubs([]);
      }
    })();
  }, [open, orgId]);

  const onDone = useCallback(() => { onLinked(); onClose(); }, [onLinked, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="contract-pax8-modal"
    >
      <div className="mt-8 w-full max-w-xl rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Link a Pax8 subscription</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {picked ? 'Pick a line on this contract (or create one) to link.' : 'Choose a synced subscription to add to this contract.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Close"
            data-testid="contract-pax8-close"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="p-5">
          {picked ? (
            <LinkSubscriptionPicker
              key={picked.id}
              integrationId={integrationId}
              subscription={{ id: picked.id, orgId: picked.orgId ?? orgId, productName: picked.productName, quantity: picked.quantity, unitPrice: picked.unitPrice }}
              onDone={onDone}
              onCancel={() => setPicked(null)}
            />
          ) : error ? (
            <p className="text-sm text-destructive" data-testid="contract-pax8-error">{error}</p>
          ) : subs === null ? (
            <p className="text-sm text-muted-foreground">Loading subscriptions…</p>
          ) : subs.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="contract-pax8-empty">
              No Pax8 subscriptions are synced for this organization yet. Sync them under Integrations → Pax8.
            </p>
          ) : (
            <ul className="divide-y rounded-md border" data-testid="contract-pax8-list">
              {subs.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{s.productName ?? 'Pax8 subscription'}</div>
                    <div className="truncate text-xs text-muted-foreground" data-testid={`contract-pax8-meta-${s.id}`}>
                      {[
                        s.vendorName,
                        s.quantity != null ? `qty ${s.quantity}` : null,
                        sellPriceLabel(s.unitPrice, s.currencyCode),
                        s.contractLineId ? 'already linked' : null,
                      ].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPicked(s)}
                    className="inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
                    data-testid={`contract-pax8-pick-${s.id}`}
                  >
                    {s.contractLineId ? 'Re-link' : 'Link'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
