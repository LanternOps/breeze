import { useCallback, useEffect, useId, useState } from 'react';
import { Dialog } from '../shared/Dialog';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';

type PolicyType = 'blocklist' | 'allowlist';

interface IntegrationOption {
  id: string;
  name: string;
  provider: string;
}

interface AddDnsPolicyModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export default function AddDnsPolicyModal({ onClose, onCreated }: AddDnsPolicyModalProps) {
  const [integrations, setIntegrations] = useState<IntegrationOption[]>([]);
  const [loadingIntegrations, setLoadingIntegrations] = useState(true);
  const [integrationId, setIntegrationId] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<PolicyType>('blocklist');
  const [description, setDescription] = useState('');
  const [domainsText, setDomainsText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const integrationFieldId = useId();
  const nameFieldId = useId();
  const typeFieldId = useId();
  const descFieldId = useId();
  const domainsFieldId = useId();

  const fetchIntegrations = useCallback(async () => {
    setLoadingIntegrations(true);
    try {
      const res = await fetchWithAuth('/dns-security/integrations');
      if (!res.ok) {
        if (res.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        setError(`Failed to load integrations (HTTP ${res.status})`);
        return;
      }
      const body = await res.json();
      const list: IntegrationOption[] = ((body.data ?? body.integrations ?? []) as Array<{
        id: string;
        name: string;
        provider: string;
      }>).map((i) => ({ id: i.id, name: i.name, provider: i.provider }));
      setIntegrations(list);
      if (list.length > 0 && !integrationId) {
        setIntegrationId(list[0]!.id);
      }
    } catch (err) {
      // Match the sibling-tab pattern: silent on AbortError, otherwise
      // surface to the dialog's inline error UI. (Todd #847 review.)
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load integrations');
    } finally {
      setLoadingIntegrations(false);
    }
  }, [integrationId]);

  useEffect(() => {
    void fetchIntegrations();
  }, [fetchIntegrations]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!integrationId) {
      setError('Pick an integration first');
      return;
    }
    setSubmitting(true);
    setError(null);

    // Parse the bulk-paste domains box. Same shape as the per-row table
    // adder in the parent tab: whitespace/comma separated, de-duped,
    // length-capped per the server schema (500 chars per entry, 500 max).
    const seen = new Set<string>();
    const domains = domainsText
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => {
        if (!s || s.length > 500) return false;
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      })
      .slice(0, 500)
      .map((domain) => ({ domain }));

    try {
      await runAction({
        request: () => fetchWithAuth('/dns-security/policies', {
          method: 'POST',
          body: JSON.stringify({
            integrationId,
            name: name.trim(),
            description: description.trim() || undefined,
            type,
            domains: domains.length > 0 ? domains : undefined,
            isActive: true,
          }),
        }),
        errorFallback: 'Failed to create policy',
        successMessage: `Policy "${name}" created`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onCreated();
      onClose();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="New DNS Policy"
      maxWidth="lg"
      className="p-6 max-h-[90vh] overflow-y-auto"
    >
      <div className="relative">
        <h2 className="text-lg font-semibold">New DNS Policy</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Blocklist or allowlist domains pushed to your DNS provider on the next sync cycle.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor={integrationFieldId} className="mb-1 block text-sm font-medium">
              Integration
            </label>
            {loadingIntegrations ? (
              <p className="text-xs text-muted-foreground">Loading integrations…</p>
            ) : integrations.length === 0 ? (
              <p className="text-xs text-destructive">
                No integrations configured. Add one on the Integrations tab first.
              </p>
            ) : (
              <select
                id={integrationFieldId}
                value={integrationId}
                onChange={(e) => setIntegrationId(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {integrations.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.name} ({it.provider})
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor={nameFieldId} className="mb-1 block text-sm font-medium">
              Policy name
            </label>
            <input
              id={nameFieldId}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              required
              placeholder="e.g. Threat blocklist"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor={typeFieldId} className="mb-1 block text-sm font-medium">
              Type
            </label>
            <select
              id={typeFieldId}
              value={type}
              onChange={(e) => setType(e.target.value as PolicyType)}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="blocklist">Blocklist (deny)</option>
              <option value="allowlist">Allowlist (permit)</option>
            </select>
          </div>

          <div>
            <label htmlFor={descFieldId} className="mb-1 block text-sm font-medium">
              Description (optional)
            </label>
            <textarea
              id={descFieldId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={2}
              className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
            />
          </div>

          <div>
            <label htmlFor={domainsFieldId} className="mb-1 block text-sm font-medium">
              Initial domains (optional)
              <span className="ml-1 font-normal text-muted-foreground">
                (one per line, comma-separated, or paste a list — up to 500)
              </span>
            </label>
            <textarea
              id={domainsFieldId}
              value={domainsText}
              onChange={(e) => setDomainsText(e.target.value)}
              rows={4}
              placeholder={'malware.example.com\nphish.example.com\nc2.example.org'}
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !integrationId}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create policy'}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
