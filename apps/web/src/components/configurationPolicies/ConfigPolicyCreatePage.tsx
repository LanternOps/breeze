import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Layers, FilePlus2, Link as LinkIcon } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { getJwtClaims } from '@/lib/authScope';
import PolicyLinkSelector from './featureTabs/PolicyLinkSelector';
import { navigateTo } from '@/lib/navigation';
import { extractApiError } from '@/lib/apiError';
import Breadcrumbs from '../layout/Breadcrumbs';

const createPolicySchema = z.object({
  name: z.string().min(1, 'Policy name is required').max(255),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive']),
});

type CreatePolicyValues = z.infer<typeof createPolicySchema>;
type CreateMode = 'new' | 'linked';

type OwnerScope = 'organization' | 'partner';

export default function ConfigPolicyCreatePage() {
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<CreateMode | null>(null);
  const [linkedPolicyId, setLinkedPolicyId] = useState<string | null>(null);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const allOrgs = useOrgStore((s) => s.allOrgs);
  const organizations = useOrgStore((s) => s.organizations);

  // Ownership axis (#1724). A partner-scope creator may own the policy at their
  // own partner (partner-wide / all-orgs, org_id NULL) OR scope it to a single
  // org. The partner is ALWAYS derived server-side from the caller's token; we
  // only send the intent. Org-scope creators never see this — their policy is
  // always owned by their one org. Mirrors AlertTemplateEditor's availability
  // picker (gate on partner scope from the JWT, not useOrgStore().partners).
  const { scope: jwtScope, partnerId: jwtPartnerId } = getJwtClaims();
  const isPartnerScope = jwtScope === 'partner' && !!jwtPartnerId;
  // Default to partner-wide when the user is viewing the All-orgs scope (no
  // concrete org selected); otherwise default to the org they're focused on.
  const [ownerScope, setOwnerScope] = useState<OwnerScope>(
    isPartnerScope && (allOrgs || !currentOrgId) ? 'partner' : 'organization'
  );
  const [ownerOrgId, setOwnerOrgId] = useState<string>(currentOrgId ?? '');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<CreatePolicyValues>({
    resolver: zodResolver(createPolicySchema),
    defaultValues: {
      name: '',
      description: '',
      status: 'active',
    },
  });

  const usePartnerOwner = isPartnerScope && ownerScope === 'partner';
  const effectiveOrgId = ownerOrgId || currentOrgId || '';

  const onSubmit = async (values: CreatePolicyValues) => {
    try {
      setError(undefined);
      // Partner-wide: send ownerScope only — the server derives the partner from
      // the caller's token and ignores any client-supplied org/partner id. Org-
      // scoped: send the concrete org id (the classic shape).
      const body = usePartnerOwner
        ? { ...values, ownerScope: 'partner' as const }
        : { ...values, orgId: effectiveOrgId };
      const response = await fetchWithAuth('/configuration-policies', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(extractApiError(data, 'Failed to create policy'));
      }

      const policy = await response.json();
      const params = linkedPolicyId ? `?linked=${linkedPolicyId}` : '';
      void navigateTo(`/configuration-policies/${policy.id}${params}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const breadcrumbs = (
    <Breadcrumbs items={[
      { label: 'Configuration Policies', href: '/configuration-policies' },
      { label: 'New Policy' }
    ]} />
  );

  // Step 1: Choose mode
  if (mode === null) {
    return (
      <div className="space-y-6">
        {breadcrumbs}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">New Configuration Policy</h1>
          <p className="text-muted-foreground">
            How would you like to configure this policy?
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode('new')}
            className="group flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-muted p-8 text-center transition hover:border-primary/40 hover:bg-primary/5"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full border bg-muted/50 transition group-hover:border-primary/40 group-hover:bg-primary/10">
              <FilePlus2 className="h-7 w-7 text-muted-foreground transition group-hover:text-primary" />
            </div>
            <div>
              <p className="text-base font-semibold">Configure New</p>
              <p className="mt-1 text-sm text-muted-foreground">Start fresh with custom settings for each feature</p>
            </div>
          </button>
          <button
            type="button"
            onClick={() => setMode('linked')}
            className="group flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-muted p-8 text-center transition hover:border-primary/40 hover:bg-primary/5"
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-full border bg-muted/50 transition group-hover:border-primary/40 group-hover:bg-primary/10">
              <LinkIcon className="h-7 w-7 text-muted-foreground transition group-hover:text-primary" />
            </div>
            <div>
              <p className="text-base font-semibold">Link to Existing</p>
              <p className="mt-1 text-sm text-muted-foreground">Use another policy as the master baseline</p>
            </div>
          </button>
        </div>

        <div className="flex items-center justify-start">
          <a
            href="/configuration-policies"
            className="h-10 inline-flex items-center rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Cancel
          </a>
        </div>
      </div>
    );
  }

  // Step 2: Fill in details (+ policy selector if linked)
  return (
    <div className="space-y-6">
      {breadcrumbs}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New Configuration Policy</h1>
        <p className="text-muted-foreground">
          {mode === 'linked'
            ? 'Create a policy linked to an existing master.'
            : 'Create a new configuration policy to bundle feature settings.'}
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Linked policy selector */}
        {mode === 'linked' && (
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex items-center gap-2">
              <LinkIcon className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold">Master Policy</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Select the configuration policy to use as the baseline. You can override individual settings per feature.
            </p>
            <div className="mt-4">
              <PolicyLinkSelector
                fetchUrl="/configuration-policies"
                selectedId={linkedPolicyId}
                onSelect={setLinkedPolicyId}
              />
            </div>
          </div>
        )}

        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Policy Details</h2>
          </div>
          <div className="mt-4 grid gap-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <input
                {...register('name')}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                placeholder="e.g. Standard Workstation Policy"
              />
              {errors.name && (
                <p className="mt-1 text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium">Description</label>
              <textarea
                {...register('description')}
                className="mt-2 h-20 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                placeholder="Optional description of what this policy configures"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Status</label>
              <select
                {...register('status')}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-48"
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>

            {isPartnerScope && (
              <fieldset className="space-y-2 rounded-md border p-4" data-testid="policy-owner">
                <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">Apply to</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ownerScope"
                    value="partner"
                    checked={ownerScope === 'partner'}
                    onChange={() => setOwnerScope('partner')}
                    data-testid="policy-owner-partner"
                  />
                  All organizations <span className="text-muted-foreground">(partner-wide)</span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ownerScope"
                    value="organization"
                    checked={ownerScope === 'organization'}
                    onChange={() => setOwnerScope('organization')}
                    data-testid="policy-owner-org"
                  />
                  A specific organization
                </label>
                {ownerScope === 'organization' && (
                  <div className="mt-2 space-y-1 pl-6">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="policy-owner-org-select">
                      Organization
                    </label>
                    <select
                      id="policy-owner-org-select"
                      value={ownerOrgId}
                      onChange={(e) => setOwnerOrgId(e.target.value)}
                      data-testid="policy-owner-org-select"
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-72"
                    >
                      <option value="">Select an organization</option>
                      {organizations.map((org) => (
                        <option key={org.id} value={org.id}>{org.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {ownerScope === 'partner' && (
                  <p className="pl-6 text-xs text-muted-foreground">
                    Applies to every organization under your partner. Backup settings aren&apos;t available on
                    partner-wide policies.
                  </p>
                )}
              </fieldset>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => { setMode(null); setLinkedPolicyId(null); }}
            className="h-10 inline-flex items-center rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Back
          </button>
          <div className="flex items-center gap-3">
            <a
              href="/configuration-policies"
              className="h-10 inline-flex items-center rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              Cancel
            </a>
            <button
              type="submit"
              disabled={isSubmitting || (mode === 'linked' && !linkedPolicyId) || (!usePartnerOwner && !effectiveOrgId)}
              className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Creating...' : 'Create Policy'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
