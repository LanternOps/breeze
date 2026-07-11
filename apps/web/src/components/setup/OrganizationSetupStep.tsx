import { useEffect, useState } from 'react';
import { Building2, MapPin, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';

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
  const { t } = useTranslation('auth');
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
        try { partner = await partnerRes.json(); } catch { warnings.push(t('setup.organization.warnings.parsePartnerFailed')); }
      } else {
        warnings.push(t('setup.organization.warnings.loadPartnerFailed'));
      }

      // Fetch organizations
      const orgsRes = await fetchWithAuth('/orgs/organizations');
      let organizations: OrgData['organizations'] = [];
      if (orgsRes.ok) {
        try {
          const orgsData = await orgsRes.json();
          organizations = orgsData.data || orgsData || [];
        } catch { warnings.push(t('setup.organization.warnings.parseOrganizationsFailed')); }
      } else {
        warnings.push(t('setup.organization.warnings.loadOrganizationsFailed'));
      }

      // Fetch sites
      const sitesRes = await fetchWithAuth('/orgs/sites');
      let sites: OrgData['sites'] = [];
      if (sitesRes.ok) {
        try {
          const sitesData = await sitesRes.json();
          sites = sitesData.data || sitesData || [];
        } catch { warnings.push(t('setup.organization.warnings.parseSitesFailed')); }
      } else {
        warnings.push(t('setup.organization.warnings.loadSitesFailed'));
      }

      if (warnings.length > 0) {
        setError(t('setup.organization.warnings.someDataUnavailable', { warnings: warnings.join('; ') }));
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
      setError(t('setup.organization.errors.loadFailed'));
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
            const data = await res.json().catch(() => null);
            setError(extractApiError(data, t('setup.organization.errors.updateOrganizationFailed')));
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
          const data = await res.json().catch(() => null);
          setError(extractApiError(data, t('setup.organization.errors.createOrganizationFailed')));
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
            const data = await res.json().catch(() => null);
            setError(extractApiError(data, t('setup.organization.errors.updateSiteFailed')));
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
          const data = await res.json().catch(() => null);
          setError(extractApiError(data, t('setup.organization.errors.createSiteFailed')));
          setSaving(false);
          return;
        }
        const site = await res.json();
        finalSiteId = site.id;
      }

      const finalOrgName = orgName.trim() || 'My Organization';
      const finalSiteName = siteName.trim() || 'Main Office';
      setSuccess(t('setup.organization.success'));
      setTimeout(() => onNext(finalOrgId, finalSiteId, finalOrgName, finalSiteName), 600);
    } catch {
      setError(t('setup.common.unexpectedError'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t('setup.organization.loadingAccount')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('setup.organization.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('setup.organization.description')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="setup-org" className="flex items-center gap-2 text-sm font-medium">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            {t('setup.organization.organizationName')}
          </label>
          <input
            id="setup-org"
            type="text"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder={t('setup.organization.organizationPlaceholder')}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            {t('setup.organization.organizationHint', {
              partnerName: orgData.partner?.name || t('setup.organization.yourMsp')
            })}
          </p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="setup-site" className="flex items-center gap-2 text-sm font-medium">
            <MapPin className="h-4 w-4 text-muted-foreground" />
            {t('setup.organization.siteName')}
          </label>
          <input
            id="setup-site"
            type="text"
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder={t('setup.organization.sitePlaceholder')}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
          />
          <p className="text-xs text-muted-foreground">
            {t('setup.organization.siteHint')}
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
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('setup.common.saveAndContinue')}
          </button>
        </div>
      </form>
    </div>
  );
}
