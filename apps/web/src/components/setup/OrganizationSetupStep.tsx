import { useEffect, useState } from 'react';
import { Building2, MapPin, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

interface OrgData {
  partner?: { id: string; name: string; slug: string };
  organizations?: { id: string; name: string; slug: string }[];
  sites?: { id: string; name: string; orgId: string }[];
}

interface OrganizationSetupStepProps {
  onNext: (orgId: string, siteId: string, orgName: string, siteName: string) => void;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100) || 'default';
}

export default function OrganizationSetupStep({ onNext }: OrganizationSetupStepProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  const [orgData, setOrgData] = useState<OrgData>({});

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

      // Auto-populate: use existing data or default from partner name
      if (organizations?.[0]) {
        setOrgName(organizations[0].name);
      } else if (partner?.name) {
        setOrgName(partner.name);
      }
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
      const existingOrg = orgData.organizations?.[0];
      const existingSite = orgData.sites?.[0];

      let finalOrgId: string;
      let finalSiteId: string;

      // If an org already exists, update its name; otherwise create one
      if (existingOrg) {
        if (orgName && orgName !== existingOrg.name) {
          const res = await fetchWithAuth(`/orgs/organizations/${existingOrg.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: orgName })
          });
          if (!res.ok) {
            let msg = 'Failed to update organization name';
            try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore */ }
            setError(msg);
            setSaving(false);
            return;
          }
        }
        finalOrgId = existingOrg.id;
      } else {
        const name = orgName.trim() || 'My Organization';
        const res = await fetchWithAuth('/orgs/organizations', {
          method: 'POST',
          body: JSON.stringify({ name, slug: slugify(name) })
        });
        if (!res.ok) {
          let msg = 'Failed to create organization';
          try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore */ }
          setError(msg);
          setSaving(false);
          return;
        }
        const org = await res.json();
        finalOrgId = org.id;
      }

      // If a site already exists, update its name; otherwise create one
      if (existingSite) {
        if (siteName && siteName !== existingSite.name) {
          const res = await fetchWithAuth(`/orgs/sites/${existingSite.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: siteName })
          });
          if (!res.ok) {
            let msg = 'Failed to update site name';
            try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore */ }
            setError(msg);
            setSaving(false);
            return;
          }
        }
        finalSiteId = existingSite.id;
      } else {
        const name = siteName.trim() || 'Main Office';
        const res = await fetchWithAuth('/orgs/sites', {
          method: 'POST',
          body: JSON.stringify({ orgId: finalOrgId, name })
        });
        if (!res.ok) {
          let msg = 'Failed to create site';
          try { const data = await res.json(); msg = data.error || msg; } catch { /* ignore */ }
          setError(msg);
          setSaving(false);
          return;
        }
        const site = await res.json();
        finalSiteId = site.id;
      }

      const finalOrgName = orgName.trim() || 'My Organization';
      const finalSiteName = siteName.trim() || 'Main Office';
      setSuccess('Organization details saved');
      setTimeout(() => onNext(finalOrgId, finalSiteId, finalOrgName, finalSiteName), 600);
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading your account...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Create your first organization</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Organizations represent your clients. You can add more later from Settings.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="setup-org" className="flex items-center gap-2 text-sm font-medium">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            Organization name
          </label>
          <input
            id="setup-org"
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="e.g. Downtown Dental, Smith Law Office"
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            Typically your client's company name. Your own company ({orgData.partner?.name || 'your MSP'}) is already set up as the partner account.
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="setup-site" className="flex items-center gap-2 text-sm font-medium">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            Site name
          </label>
          <input
            id="setup-site"
            type="text"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="e.g. Main Office, HQ, Building A"
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            A physical location where devices are managed. You can add more sites later.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
            {success}
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={saving}
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
