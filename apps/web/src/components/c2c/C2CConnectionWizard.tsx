import { useCallback, useState } from 'react';
import { X, ChevronRight, ChevronLeft, CheckCircle2, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

interface C2CConnectionWizardProps {
  onClose: () => void;
  onComplete: () => void;
}

type Provider = 'microsoft365' | 'google_workspace';
type Step = 1 | 2 | 3 | 4;

const SCOPES: Record<Provider, { id: string; label: string }[]> = {
  microsoft365: [
    { id: 'mailbox', label: 'Exchange Mailbox' },
    { id: 'onedrive', label: 'OneDrive' },
    { id: 'sharepoint', label: 'SharePoint' },
    { id: 'teams', label: 'Teams' },
  ],
  google_workspace: [
    { id: 'gmail', label: 'Gmail' },
    { id: 'drive', label: 'Google Drive' },
    { id: 'calendar', label: 'Calendar' },
  ],
};

export default function C2CConnectionWizard({ onClose, onComplete }: C2CConnectionWizardProps) {
  const [step, setStep] = useState<Step>(1);
  const [provider, setProvider] = useState<Provider | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [testError, setTestError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  const toggleScope = useCallback((scopeId: string) => {
    setSelectedScopes((prev) =>
      prev.includes(scopeId) ? prev.filter((s) => s !== scopeId) : [...prev, scopeId]
    );
  }, []);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setTestError(undefined);
    try {
      const res = await fetchWithAuth('/c2c/connections/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          tenantId: tenantId || undefined,
          clientId,
          clientSecret,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Connection test failed');
      }
      setTestResult('success');
    } catch (err) {
      setTestResult('error');
      setTestError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTesting(false);
    }
  }, [provider, tenantId, clientId, clientSecret]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(undefined);
    try {
      const res = await fetchWithAuth('/c2c/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          displayName,
          tenantId: tenantId || undefined,
          clientId,
          clientSecret,
          scopes: selectedScopes.join(','),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? 'Failed to save connection');
      }
      onComplete();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save connection');
    } finally {
      setSaving(false);
    }
  }, [provider, displayName, tenantId, clientId, clientSecret, selectedScopes, onComplete]);

  const canProceed = (): boolean => {
    if (step === 1) return provider !== null;
    if (step === 2) return clientId.trim().length > 0 && clientSecret.trim().length > 0;
    if (step === 3) return selectedScopes.length > 0;
    return testResult === 'success';
  };

  const stepLabels = ['Provider', 'Credentials', 'Scope', 'Test & Save'];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-lg border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 className="text-lg font-semibold">Add Cloud Connection</h2>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 border-b px-6 py-3">
          {stepLabels.map((label, i) => {
            const stepNum = (i + 1) as Step;
            return (
              <div key={label} className="flex items-center gap-2">
                {i > 0 && <div className="h-px w-4 bg-border" />}
                <div
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium',
                    step === stepNum
                      ? 'bg-primary text-primary-foreground'
                      : step > stepNum
                        ? 'bg-emerald-500 text-white'
                        : 'bg-muted text-muted-foreground'
                  )}
                >
                  {step > stepNum ? <CheckCircle2 className="h-3.5 w-3.5" /> : stepNum}
                </div>
                <span className={cn('text-xs', step === stepNum ? 'font-medium' : 'text-muted-foreground')}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>

        <div className="p-6 space-y-4">
          {/* Step 1: Provider */}
          {step === 1 && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Select the cloud provider to back up.</p>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => { setProvider('microsoft365'); setDisplayName('Microsoft 365'); }}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border p-6 transition-colors',
                    provider === 'microsoft365' ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                  )}
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-[#0078d4]/10 text-[#0078d4]">
                    <span className="text-xl font-bold">M</span>
                  </div>
                  <span className="text-sm font-medium">Microsoft 365</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setProvider('google_workspace'); setDisplayName('Google Workspace'); }}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-lg border p-6 transition-colors',
                    provider === 'google_workspace' ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                  )}
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded bg-[#4285f4]/10 text-[#4285f4]">
                    <span className="text-xl font-bold">G</span>
                  </div>
                  <span className="text-sm font-medium">Google Workspace</span>
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Credentials */}
          {step === 2 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enter your {provider === 'microsoft365' ? 'Azure AD' : 'Google Cloud'} app credentials.
              </p>
              <div>
                <label className="mb-1 block text-sm font-medium">Display Name</label>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  placeholder="My M365 Connection"
                />
              </div>
              {provider === 'microsoft365' && (
                <div>
                  <label className="mb-1 block text-sm font-medium">Tenant ID</label>
                  <input
                    type="text"
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block text-sm font-medium">Client ID</label>
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                  placeholder="Application (client) ID"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Client Secret</label>
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
                  placeholder="Client secret value"
                />
              </div>
            </div>
          )}

          {/* Step 3: Scope */}
          {step === 3 && provider && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">Select what to back up.</p>
              <div className="space-y-2">
                {SCOPES[provider].map((scope) => (
                  <label
                    key={scope.id}
                    className={cn(
                      'flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors',
                      selectedScopes.includes(scope.id) ? 'border-primary bg-primary/5' : 'hover:bg-muted'
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={selectedScopes.includes(scope.id)}
                      onChange={() => toggleScope(scope.id)}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <span className="text-sm font-medium">{scope.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Step 4: Test & Save */}
          {step === 4 && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Test the connection before saving.
              </p>
              <div className="rounded-lg border p-4 space-y-2 text-sm">
                <p><span className="font-medium">Provider:</span> {provider === 'microsoft365' ? 'Microsoft 365' : 'Google Workspace'}</p>
                <p><span className="font-medium">Display Name:</span> {displayName}</p>
                {tenantId && <p><span className="font-medium">Tenant ID:</span> {tenantId.slice(0, 8)}...</p>}
                <p><span className="font-medium">Scopes:</span> {selectedScopes.join(', ')}</p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTest}
                  disabled={testing}
                  className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Test Connection
                </button>
                {testResult === 'success' && (
                  <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-4 w-4" /> Connected successfully
                  </span>
                )}
                {testResult === 'error' && (
                  <span className="text-sm text-red-600 dark:text-red-400">{testError}</span>
                )}
              </div>
              {saveError && (
                <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t px-6 py-4">
          <button
            type="button"
            onClick={() => step > 1 ? setStep((step - 1) as Step) : onClose()}
            className="inline-flex items-center gap-1 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            <ChevronLeft className="h-4 w-4" /> {step === 1 ? 'Cancel' : 'Back'}
          </button>
          {step < 4 ? (
            <button
              type="button"
              onClick={() => setStep((step + 1) as Step)}
              disabled={!canProceed()}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || testResult !== 'success'}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save Connection
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
