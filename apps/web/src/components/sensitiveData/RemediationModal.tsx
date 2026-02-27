import { useState } from 'react';
import { X, AlertTriangle, ShieldAlert } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { REMEDIATION_ACTIONS } from './constants';

type RemediationModalProps = {
  findingIds: string[];
  onClose: () => void;
  onComplete: () => void;
};

type Step = 'select' | 'confirm' | 'second_approval' | 'result';

export default function RemediationModal({ findingIds, onClose, onComplete }: RemediationModalProps) {
  const [step, setStep] = useState<Step>('select');
  const [action, setAction] = useState('');
  const [secondApprovalToken, setSecondApprovalToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const selectedAction = REMEDIATION_ACTIONS.find((a) => a.value === action);
  const isDestructive = selectedAction?.destructive ?? false;
  const isSecureDelete = action === 'secure_delete';

  const handleSelectAction = () => {
    if (!action) return;
    if (isDestructive) {
      setStep('confirm');
    } else {
      handleSubmit(false);
    }
  };

  const handleConfirm = () => {
    if (isSecureDelete) {
      setStep('second_approval');
    } else {
      handleSubmit(true);
    }
  };

  const handleSubmit = async (confirmed: boolean) => {
    try {
      setSubmitting(true);
      setError(undefined);

      const body: Record<string, unknown> = {
        findingIds,
        action,
      };
      if (confirmed) body.confirm = true;
      if (isSecureDelete && secondApprovalToken) {
        body.secondApprovalToken = secondApprovalToken;
        body.confirm = true;
      }

      const res = await fetchWithAuth('/sensitive-data/remediate', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json.error || 'Remediation failed');
      }

      setResult(json.data ?? {});
      setStep('result');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remediation failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Remediate Findings</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mt-2 text-sm text-muted-foreground">
          {findingIds.length} finding{findingIds.length !== 1 ? 's' : ''} selected
        </p>

        {error && (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}

        {/* Step 1: Select Action */}
        {step === 'select' && (
          <div className="mt-4 space-y-3">
            {REMEDIATION_ACTIONS.map((a) => (
              <button
                key={a.value}
                type="button"
                onClick={() => setAction(a.value)}
                className={`flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition ${
                  action === a.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                {a.destructive ? (
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-muted-foreground" />
                )}
                <div>
                  <span className="text-sm font-medium">{a.label}</span>
                  {a.destructive && (
                    <span className="ml-2 text-xs text-destructive">Destructive</span>
                  )}
                </div>
              </button>
            ))}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSelectAction}
                disabled={!action || submitting}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? 'Processing...' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Confirmation for destructive actions */}
        {step === 'confirm' && (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                <span className="font-semibold text-destructive">Destructive Action</span>
              </div>
              <p className="mt-2 text-sm">
                You are about to <strong>{selectedAction?.label.toLowerCase()}</strong>{' '}
                {findingIds.length} finding{findingIds.length !== 1 ? 's' : ''}.
                This action may modify or remove files on target devices.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep('select')} className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted">
                Back
              </button>
              <button
                type="button"
                onClick={handleConfirm}
                disabled={submitting}
                className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? 'Processing...' : isSecureDelete ? 'Next' : 'Confirm'}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Second approval for secure_delete */}
        {step === 'second_approval' && (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4">
              <p className="text-sm font-medium text-destructive">
                Secure delete requires a second approval token.
              </p>
            </div>
            <div>
              <label className="text-sm font-medium">Approval Token</label>
              <input
                type="password"
                value={secondApprovalToken}
                onChange={(e) => setSecondApprovalToken(e.target.value)}
                placeholder="Enter second approval token"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setStep('confirm')} className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted">
                Back
              </button>
              <button
                type="button"
                onClick={() => handleSubmit(true)}
                disabled={submitting}
                className="h-9 rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? 'Processing...' : 'Confirm Secure Delete'}
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Result */}
        {step === 'result' && result && (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-green-500/40 bg-green-500/10 p-4">
              <p className="text-sm font-medium text-green-700">Remediation initiated successfully.</p>
              {typeof result.updated === 'number' && (
                <p className="mt-1 text-sm text-green-600">{result.updated} finding(s) updated</p>
              )}
              {Array.isArray(result.queued) && result.queued.length > 0 && (
                <p className="mt-1 text-sm text-green-600">{result.queued.length} command(s) queued</p>
              )}
              {Array.isArray(result.failed) && result.failed.length > 0 && (
                <p className="mt-1 text-sm text-destructive">{result.failed.length} failed</p>
              )}
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onComplete}
                className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
