import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { listContracts, getContract, addContractLine, type ContractSummary, type ContractLine } from '../../lib/api/contracts';

const NEW_LINE = '__new__';
const MONEY_RE = /^\d+(\.\d{1,2})?$/;
const MFA_HINT = 'This change requires MFA. Set up or verify MFA in your profile, then retry.';

/** Pax8 link/create writes are MFA-gated server-side; a 403 "MFA required" should
 *  read as a setup hint, mirroring the sibling actions in Pax8Integration. */
function isMfaError(err: unknown): boolean {
  return err instanceof ActionError && err.status === 403 && /mfa required/i.test(err.message);
}

interface LinkSubscriptionPickerProps {
  integrationId: string;
  subscription: { id: string; orgId: string; productName: string | null; quantity: number | null };
  onDone: () => void;
  onCancel: () => void;
}

export default function LinkSubscriptionPicker({ integrationId, subscription, onDone, onCancel }: LinkSubscriptionPickerProps) {
  const [contracts, setContracts] = useState<ContractSummary[]>([]);
  const [contractId, setContractId] = useState('');
  const [lines, setLines] = useState<ContractLine[]>([]);
  const [lineId, setLineId] = useState('');
  const [newDesc, setNewDesc] = useState(subscription.productName ?? '');
  const [newPrice, setNewPrice] = useState('');
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await listContracts({ orgId: subscription.orgId });
      if (!res.ok) {
        // Load-bearing read: an empty dropdown must not be mistaken for "no contracts".
        setError('Could not load contracts for this organization. Close and retry.');
        return;
      }
      const body = (await res.json().catch(() => null)) as { data?: ContractSummary[] } | null;
      setContracts((body?.data ?? []).filter((c) => c.status !== 'cancelled' && c.status !== 'expired'));
    })();
  }, [subscription.orgId]);

  const onContract = useCallback(async (id: string) => {
    setContractId(id);
    setLineId('');
    setLines([]);
    setError(null);
    if (!id) return;
    const res = await getContract(id);
    if (!res.ok) {
      // Surface the failure: an empty line list would otherwise invite a duplicate
      // manual line for one that exists but failed to load.
      setError('Could not load this contract’s lines. Pick the contract again to retry.');
      return;
    }
    const body = (await res.json().catch(() => null)) as { data?: { lines?: ContractLine[] } } | null;
    setLines((body?.data?.lines ?? []).filter((l) => l.lineType === 'manual'));
  }, []);

  const newPriceValid = MONEY_RE.test(newPrice.trim());
  const canSubmit = !busy && contractId !== '' && lineId !== '' && (lineId !== NEW_LINE || (newDesc.trim() !== '' && newPriceValid));

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      let contractLineId = lineId;
      if (lineId === NEW_LINE) {
        const line = await runAction<{ id: string }>({
          request: () => addContractLine(contractId, {
            lineType: 'manual',
            description: newDesc.trim(),
            unitPrice: newPrice.trim(),
            taxable: false,
            manualQuantity: String(subscription.quantity ?? 0),
          }),
          errorFallback: 'Could not create the contract line.',
          parseSuccess: (d) => (d as { data: { id: string } }).data,
        });
        contractLineId = line.id;
      }
      await runAction({
        request: () => fetchWithAuth('/pax8/subscriptions/link', {
          method: 'POST',
          body: JSON.stringify({ integrationId, subscriptionSnapshotId: subscription.id, contractLineId, syncEnabled }),
        }),
        errorFallback: 'Could not link the subscription.',
        successMessage: 'Subscription linked',
      });
      onDone();
    } catch (err) {
      // Mirror the sibling Unlink/Pause buttons: surface MFA as an actionable hint
      // rather than the generic fallback (the 403 body is plain text, so runAction
      // can't recover it on its own).
      if (isMfaError(err)) { showToast({ type: 'error', message: MFA_HINT }); return; }
      handleActionError(err, 'Could not link the subscription.');
    } finally {
      setBusy(false);
    }
  }, [canSubmit, lineId, contractId, newDesc, newPrice, subscription, integrationId, syncEnabled, onDone]);

  return (
    <div className="mt-2 rounded-md border bg-background/40 p-3 text-sm" data-testid="pax8-link-picker">
      {error && (
        <p className="mb-2 text-xs text-destructive" data-testid="pax8-link-error">{error}</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs text-muted-foreground">Contract</span>
          <select
            value={contractId}
            onChange={(e) => void onContract(e.target.value)}
            data-testid="pax8-link-contract"
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          >
            <option value="">Select a contract…</option>
            {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {contractId && (
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Line</span>
            <select
              value={lineId}
              onChange={(e) => setLineId(e.target.value)}
              data-testid="pax8-link-line"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Select a line…</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.description}</option>)}
              <option value={NEW_LINE}>+ New manual line</option>
            </select>
          </label>
        )}
      </div>

      {lineId === NEW_LINE && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <input
            type="text" value={newDesc} placeholder="Line description"
            onChange={(e) => setNewDesc(e.target.value)}
            data-testid="pax8-link-new-desc"
            className="h-9 rounded-md border bg-background px-3 text-sm"
          />
          <input
            type="text" inputMode="decimal" value={newPrice} placeholder="Unit price (e.g. 36.00)"
            onChange={(e) => setNewPrice(e.target.value)}
            data-testid="pax8-link-new-price"
            className="h-9 rounded-md border bg-background px-3 text-sm"
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={syncEnabled} onChange={(e) => setSyncEnabled(e.target.checked)} data-testid="pax8-link-sync" />
          Keep quantity in sync
        </label>
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={busy} data-testid="pax8-link-cancel"
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={!canSubmit} data-testid="pax8-link-submit"
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Link</button>
        </div>
      </div>
    </div>
  );
}
