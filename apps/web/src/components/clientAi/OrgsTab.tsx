import { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  ClipboardCopy,
  Clock,
  ExternalLink,
  Loader2,
  Settings2,
  SlidersHorizontal,
  Unplug,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { Dialog } from '../shared/Dialog';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { runAction, handleActionError } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';

/**
 * AI for Office — per-org provisioning status + onboarding wizard (spec §9.1).
 * Reads GET /client-ai/admin/orgs (Plan-4 Task 2); the wizard writes Plan 1's
 * tenant-mapping and policy endpoints. Status chip is driven by consentStatus
 * exactly as Task 2 derives it: unknown → Not provisioned, pending → Consent
 * pending, granted → Active. policyEnabled is a separate column — consent and
 * the enable flip are independent facts.
 */

/** Row shape of GET /client-ai/admin/orgs (Plan-4 Task 2). */
export interface OrgStatusRow {
  orgId: string;
  orgName: string;
  mapped: boolean;
  entraTenantId: string | null;
  suggestedEntraTenantId: string | null;
  consentStatus: 'unknown' | 'pending' | 'granted';
  policyEnabled: boolean;
  currentMonthCostCents: number;
  currentMonthMessages: number;
}

interface OrgsTabProps {
  /** Jump to the per-org policy editor (#policy/<orgId>, wired by AiForOfficePage). */
  onOpenPolicy: (orgId: string) => void;
}

// Mirrors ENTRA_TENANT_GUID_REGEX (apps/api routes/clientAi/schemas.ts) — UX
// pre-validation only; the server re-validates.
const ENTRA_TENANT_GUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Spec §9.1 status chip: not provisioned / consent pending / active. */
function StatusChip({ status }: { status: OrgStatusRow['consentStatus'] }) {
  if (status === 'granted') {
    return (
      <span
        data-testid="ai-office-status-active"
        className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
      >
        <CheckCircle2 className="h-3 w-3" /> Active
      </span>
    );
  }
  if (status === 'pending') {
    return (
      <span
        data-testid="ai-office-status-pending"
        className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400"
      >
        <Clock className="h-3 w-3" /> Consent pending
      </span>
    );
  }
  return (
    <span
      data-testid="ai-office-status-unprovisioned"
      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-400"
    >
      <Unplug className="h-3 w-3" /> Not provisioned
    </span>
  );
}

export default function OrgsTab({ onOpenPolicy }: OrgsTabProps) {
  const [rows, setRows] = useState<OrgStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notEnabled, setNotEnabled] = useState(false);
  const [wizardOrgId, setWizardOrgId] = useState<string | null>(null);
  const [unmapOrg, setUnmapOrg] = useState<OrgStatusRow | null>(null);
  const [unmapping, setUnmapping] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(false);
      const res = await fetchWithAuth('/client-ai/admin/orgs');
      if (res.status === 404) {
        // CLIENT_AI_ENTRA_CLIENT_ID dark-gate (Plan 1): the whole
        // /client-ai/admin group 404s until the add-in app registration is
        // configured on the API.
        setNotEnabled(true);
        return;
      }
      if (res.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data: OrgStatusRow[] };
      setRows(body.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmUnmap = async () => {
    if (!unmapOrg || unmapping) return;
    setUnmapping(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${unmapOrg.orgId}/tenant-mapping`, {
            method: 'DELETE',
          }),
        errorFallback: 'Failed to remove tenant mapping',
        successMessage: `Tenant mapping removed for ${unmapOrg.orgName}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      setUnmapOrg(null);
      await load();
    } catch (err) {
      handleActionError(err, 'Failed to remove tenant mapping');
    } finally {
      setUnmapping(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (notEnabled) {
    return (
      <div
        className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        data-testid="ai-office-not-enabled"
      >
        <p className="font-medium text-foreground">
          Breeze AI for Office is not enabled on this instance.
        </p>
        <p className="mt-1">
          Set <code className="rounded bg-muted px-1">CLIENT_AI_ENTRA_CLIENT_ID</code> (the Entra
          add-in app registration) on the API and reload.
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div
        className="rounded-lg border bg-card p-6 text-sm text-muted-foreground"
        data-testid="ai-office-orgs-load-error"
      >
        Failed to load organization status.{' '}
        <button
          type="button"
          className="text-primary underline"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  const wizardRow = wizardOrgId ? (rows.find((r) => r.orgId === wizardOrgId) ?? null) : null;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card">
        <div className="border-b px-6 py-4">
          <h2 className="text-lg font-semibold">Client organizations</h2>
          <p className="text-sm text-muted-foreground">
            Provision the Excel AI assistant per client org: map the Entra tenant, grant admin
            consent, enable the policy, deploy the add-in.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">Organization</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">AI enabled</th>
                <th className="px-4 py-2">Entra tenant</th>
                <th className="px-4 py-2 text-right">Cost (MTD)</th>
                <th className="px-4 py-2 text-right">Messages (MTD)</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.orgId}
                  className="border-b last:border-0 hover:bg-muted/20"
                  data-testid={`ai-office-org-row-${row.orgId}`}
                >
                  <td className="px-4 py-2.5 font-medium">{row.orgName}</td>
                  <td className="px-4 py-2.5">
                    <StatusChip status={row.consentStatus} />
                  </td>
                  <td className="px-4 py-2.5">
                    {row.policyEnabled ? (
                      <span className="text-emerald-600 dark:text-emerald-400">Yes</span>
                    ) : (
                      <span className="text-muted-foreground">No</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {row.entraTenantId ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">{formatCost(row.currentMonthCostCents)}</td>
                  <td className="px-4 py-2.5 text-right">{row.currentMonthMessages}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setWizardOrgId(row.orgId)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        data-testid={`ai-office-wizard-open-${row.orgId}`}
                      >
                        <Settings2 className="h-3.5 w-3.5" /> {row.mapped ? 'Manage' : 'Set up'}
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenPolicy(row.orgId)}
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        data-testid={`ai-office-policy-open-${row.orgId}`}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5" /> Policy
                      </button>
                      {row.mapped && (
                        <button
                          type="button"
                          onClick={() => setUnmapOrg(row)}
                          className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                          data-testid={`ai-office-unmap-${row.orgId}`}
                        >
                          <Unplug className="h-3.5 w-3.5" /> Unmap
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No organizations
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {wizardRow && (
        <OnboardingWizard
          row={wizardRow}
          onClose={() => setWizardOrgId(null)}
          onChanged={() => void load()}
          onOpenPolicy={onOpenPolicy}
        />
      )}

      <ConfirmDialog
        open={unmapOrg !== null}
        onClose={() => setUnmapOrg(null)}
        onConfirm={() => void confirmUnmap()}
        title="Remove tenant mapping"
        message={
          unmapOrg
            ? `Users in ${unmapOrg.orgName}'s Entra tenant will no longer be able to sign in to the Excel assistant. The org policy and usage history are kept.`
            : ''
        }
        confirmLabel="Remove mapping"
        isLoading={unmapping}
        confirmTestId="ai-office-unmap-confirm"
      />
    </div>
  );
}

// ── Onboarding wizard (spec §9.1) ────────────────────────────────────────────

type WizardStep = 1 | 2 | 3 | 4;

function initialStep(row: OrgStatusRow): WizardStep {
  if (!row.mapped) return 1;
  if (row.consentStatus === 'pending') return 2;
  if (!row.policyEnabled) return 3;
  return 4;
}

interface ConsentInfo {
  url: string;
  tenantSegment: string;
  redirectUri: string;
}

function OnboardingWizard({
  row,
  onClose,
  onChanged,
  onOpenPolicy,
}: {
  row: OrgStatusRow;
  onClose: () => void;
  onChanged: () => void;
  onOpenPolicy: (orgId: string) => void;
}) {
  const [step, setStep] = useState<WizardStep>(() => initialStep(row));
  const [tenantId, setTenantId] = useState(row.entraTenantId ?? row.suggestedEntraTenantId ?? '');
  const [saving, setSaving] = useState(false);
  const [consent, setConsent] = useState<ConsentInfo | null>(null);
  const [consentError, setConsentError] = useState(false);

  // Step 2 needs the admin-consent URL (GET /client-ai/admin/orgs/:orgId/consent-url, Task 2).
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    setConsent(null);
    setConsentError(false);
    fetchWithAuth(`/client-ai/admin/orgs/${row.orgId}/consent-url`)
      .then((r) =>
        r.ok ? (r.json() as Promise<ConsentInfo>) : Promise.reject(new Error(`HTTP ${r.status}`))
      )
      .then((data) => {
        if (!cancelled) setConsent(data);
      })
      .catch(() => {
        if (!cancelled) setConsentError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [step, row.orgId]);

  const tenantIdValid = ENTRA_TENANT_GUID_REGEX.test(tenantId.trim());

  const saveMapping = async () => {
    if (!tenantIdValid || saving) return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${row.orgId}/tenant-mapping`, {
            method: 'PUT',
            body: JSON.stringify({ entraTenantId: tenantId.trim() }),
          }),
        errorFallback: 'Failed to save tenant mapping',
        successMessage: 'Tenant mapping saved',
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onChanged();
      setStep(2);
    } catch (err) {
      // 409 tenant_already_mapped surfaces via runAction's error toast (the
      // API's deliberately opaque message — it never reveals the owning org).
      handleActionError(err, 'Failed to save tenant mapping');
    } finally {
      setSaving(false);
    }
  };

  const copyConsentUrl = async () => {
    if (!consent) return;
    try {
      await navigator.clipboard.writeText(consent.url);
      showToast({ type: 'success', message: 'Consent URL copied' });
    } catch {
      showToast({ type: 'error', message: 'Could not copy — select the URL manually' });
    }
  };

  const enablePolicy = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/client-ai/admin/orgs/${row.orgId}/policy`, {
            method: 'PUT',
            body: JSON.stringify({ enabled: true }),
          }),
        errorFallback: 'Failed to enable AI for Office',
        successMessage: `AI for Office enabled for ${row.orgName}`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onChanged();
      setStep(4);
    } catch (err) {
      handleActionError(err, 'Failed to enable AI for Office');
    } finally {
      setSaving(false);
    }
  };

  const steps: { n: WizardStep; label: string }[] = [
    { n: 1, label: 'Tenant' },
    { n: 2, label: 'Consent' },
    { n: 3, label: 'Enable' },
    { n: 4, label: 'Deploy' },
  ];

  return (
    <Dialog open onClose={onClose} title={`Set up AI for Office — ${row.orgName}`} maxWidth="2xl" className="p-6">
      <h2 className="text-lg font-semibold">Set up AI for Office — {row.orgName}</h2>
      <div className="mt-3 flex items-center gap-2" data-testid="ai-office-wizard-steps">
        {steps.map((s, i) => (
          <div key={s.n} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-6 bg-border" />}
            <span
              className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${
                step === s.n
                  ? 'bg-primary text-primary-foreground'
                  : step > s.n
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground'
              }`}
            >
              {s.n}. {s.label}
            </span>
          </div>
        ))}
      </div>

      {step === 1 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-1">
          <p className="text-sm text-muted-foreground">
            Map this org to its Microsoft Entra tenant (Directory ID). The mapping is the
            tenant-isolation linchpin — every Excel sign-in from this tenant lands in this org.
            {row.suggestedEntraTenantId && !row.entraTenantId
              ? " Pre-filled from the org’s existing Microsoft 365 connection."
              : ''}
          </p>
          <label className="block text-sm">
            <span className="text-muted-foreground">Entra tenant ID</span>
            <input
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-sm"
              data-testid="ai-office-wizard-tenant-input"
            />
          </label>
          {tenantId.trim() !== '' && !tenantIdValid && (
            <p className="text-xs text-destructive">
              Must be a GUID (Entra admin center → Overview → Tenant ID).
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveMapping()}
              disabled={!tenantIdValid || saving}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              data-testid="ai-office-wizard-save-mapping"
            >
              {saving ? 'Saving…' : 'Save & continue'}
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-2">
          <p className="text-sm text-muted-foreground">
            A Microsoft 365 admin of the client tenant must grant admin consent to the Breeze AI
            for Office app. Send them this link (or open it yourself if you hold Global Admin in
            the client tenant):
          </p>
          {consentError && (
            <p className="text-sm text-destructive">Failed to load the consent URL. Close and retry.</p>
          )}
          {!consent && !consentError && (
            <p className="text-sm text-muted-foreground">
              <Loader2 className="inline h-4 w-4 animate-spin" /> Loading consent URL…
            </p>
          )}
          {consent && (
            <>
              <div className="flex items-center gap-2">
                <code
                  className="block flex-1 overflow-x-auto whitespace-nowrap rounded-md border bg-muted/40 px-3 py-2 text-xs"
                  data-testid="ai-office-consent-url"
                >
                  {consent.url}
                </code>
                <button
                  type="button"
                  onClick={() => void copyConsentUrl()}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-2 text-xs hover:bg-muted"
                  data-testid="ai-office-consent-copy"
                  title="Copy URL"
                >
                  <ClipboardCopy className="h-4 w-4" />
                </button>
                <a
                  href={consent.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-2 text-xs hover:bg-muted"
                  title="Open in new tab"
                >
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              <p className="text-xs text-muted-foreground">
                After granting, Microsoft redirects to a Breeze confirmation page. Consent shows as
                granted here once the first user signs in from Excel — there is no live poll
                against Microsoft (Plan-4 decision 1).
              </p>
            </>
          )}
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              data-testid="ai-office-wizard-consent-done"
            >
              I&apos;ve granted consent
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-3">
          <p className="text-sm text-muted-foreground">
            Enable the assistant for this org. This writes <code>enabled: true</code> to the org
            policy with safe defaults (all users, read/write with end-user approval, DLP redaction
            for financial/credential types). Tune everything in the policy editor afterwards.
          </p>
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void enablePolicy()}
              disabled={saving}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              data-testid="ai-office-wizard-enable"
            >
              {saving ? 'Enabling…' : row.policyEnabled ? 'Already enabled — continue' : 'Enable AI for Office'}
            </button>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="mt-5 space-y-3" data-testid="ai-office-wizard-step-4">
          <p className="text-sm font-medium">Deploy the Excel add-in via Microsoft 365 centralized deployment</p>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              Sign in to the client tenant&apos;s{' '}
              <span className="font-medium text-foreground">Microsoft 365 admin center</span> →
              Settings → Integrated apps.
            </li>
            <li>
              Choose <span className="font-medium text-foreground">Upload custom apps</span> →
              Office add-in → provide the Breeze AI for Office manifest URL from your Breeze
              instance.
            </li>
            <li>
              Assign the add-in to everyone or to the user groups covered by this org&apos;s
              access policy.
            </li>
            <li>
              Deployment can take up to 24h to appear in users&apos; Excel ribbon (Home →
              Add-ins).
            </li>
            <li>Users sign in automatically with their Microsoft work account — no extra credentials.</li>
          </ol>
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                onOpenPolicy(row.orgId);
                onClose();
              }}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              data-testid="ai-office-wizard-open-policy"
            >
              Open policy editor
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
              data-testid="ai-office-wizard-done"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
