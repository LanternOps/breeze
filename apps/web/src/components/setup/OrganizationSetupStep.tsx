import { useEffect, useState } from 'react';
import { Building2, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

interface OrgData {
  partner?: { id: string; name: string; slug: string };
  organizations?: { id: string; name: string; slug: string }[];
  sites?: { id: string; name: string; orgId: string }[];
}

interface OrganizationSetupStepProps {
  onNext: () => void;
}

export default function OrganizationSetupStep({ onNext }: OrganizationSetupStepProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [orgData, setOrgData] = useState<OrgData>({});

  const [partnerName, setPartnerName] = useState('');
  const [orgName, setOrgName] = useState('');
  const [siteName, setSiteName] = useState('');

  useEffect(() => {
    loadOrgData();
  }, []);

  const loadOrgData = async () => {
    setLoading(true);
    try {
      const warnings: string[] = [];

      // Fetch partner info
      const partnerRes = await fetchWithAuth('/partner/me');
      let partner: OrgData['partner'];
      if (partnerRes.ok) {
        try { partner = await partnerRes.json(); } catch { warnings.push('Failed to parse partner data'); }
      } else {
        warnings.push('Could not load partner info');
      }

      // Fetch organizations
      const orgsRes = await fetchWithAuth('/orgs/organizations');
      let organizations: OrgData['organizations'] = [];
      if (orgsRes.ok) {
        try {
          const orgsData = await orgsRes.json();
          organizations = orgsData.data || orgsData || [];
        } catch { warnings.push('Failed to parse organization data'); }
      } else {
        warnings.push('Could not load organizations');
      }

      // Fetch sites
      const sitesRes = await fetchWithAuth('/orgs/sites');
      let sites: OrgData['sites'] = [];
      if (sitesRes.ok) {
        try {
          const sitesData = await sitesRes.json();
          sites = sitesData.data || sitesData || [];
        } catch { warnings.push('Failed to parse site data'); }
      } else {
        warnings.push('Could not load sites');
      }

      if (warnings.length > 0) {
        setError(`Some data could not be loaded: ${warnings.join('; ')}`);
      }

      setOrgData({ partner, organizations, sites });
      if (partner) setPartnerName(partner.name);
      if (organizations?.[0]) setOrgName(organizations[0].name);
      if (sites?.[0]) setSiteName(sites[0].name);
    } catch {
      setError('Failed to load organization data');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);
    setSaving(true);

    try {
      // Update partner name
      if (orgData.partner && partnerName && partnerName !== orgData.partner.name) {
        const res = await fetchWithAuth(`/orgs/partners/${orgData.partner.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: partnerName })
        });
        if (!res.ok) {
          let msg = 'Failed to update partner name';
          try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore parse error */ }
          setError(msg);
          setSaving(false);
          return;
        }
      }

      // Update org name
      const org = orgData.organizations?.[0];
      if (org && orgName && orgName !== org.name) {
        const res = await fetchWithAuth(`/orgs/organizations/${org.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: orgName })
        });
        if (!res.ok) {
          let msg = 'Failed to update organization name';
          try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore parse error */ }
          setError(msg);
          setSaving(false);
          return;
        }
      }

      // Update site name
      const site = orgData.sites?.[0];
      if (site && siteName && siteName !== site.name) {
        const res = await fetchWithAuth(`/orgs/sites/${site.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: siteName })
        });
        if (!res.ok) {
          let msg = 'Failed to update site name';
          try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore parse error */ }
          setError(msg);
          setSaving(false);
          return;
        }
      }

      setSuccess('Organization details updated');
      setTimeout(() => onNext(), 600);
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasChanges =
    (orgData.partner && partnerName !== orgData.partner.name) ||
    (orgData.organizations?.[0] && orgName !== orgData.organizations[0].name) ||
    (orgData.sites?.[0] && siteName !== orgData.sites[0].name);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Name Your Organization</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Replace the default names with your company and site details.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {orgData.partner && (
          <div>
            <label htmlFor="setup-partner" className="flex items-center gap-2 text-sm font-medium">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Partner (MSP) Name
            </label>
            <input
              id="setup-partner"
              type="text"
              value={partnerName}
              onChange={(e) => setPartnerName(e.target.value)}
              placeholder="Your Company Name"
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}

        {orgData.organizations?.[0] && (
          <div>
            <label htmlFor="setup-org" className="flex items-center gap-2 text-sm font-medium">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Organization Name
            </label>
            <input
              id="setup-org"
              type="text"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="Default Organization"
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}

        {orgData.sites?.[0] && (
          <div>
            <label htmlFor="setup-site" className="flex items-center gap-2 text-sm font-medium">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              Site Name
            </label>
            <input
              id="setup-site"
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="Main Office"
              className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-md border border-green-500/50 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            {success}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onNext}
            className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Skip
          </button>
          <button
            type="submit"
            disabled={saving || !hasChanges}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Save & Continue
          </button>
        </div>
      </form>
    </div>
  );
}
