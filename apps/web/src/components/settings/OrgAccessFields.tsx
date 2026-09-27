import { useMemo, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

export type OrgAccessLevel = 'all' | 'selected' | 'none';

type OrgOption = {
  id: string;
  name: string;
};

type OrgAccessFieldsProps = {
  /** Prefix for element ids so the invite and edit modals never collide. */
  idPrefix: string;
  orgAccess: OrgAccessLevel;
  orgIds: string[];
  organizations: OrgOption[];
  onChange: (orgAccess: OrgAccessLevel, orgIds: string[]) => void;
  /** Validation message for the organization list, if any. */
  orgIdsError?: string;
};

/**
 * A partner membership's organization reach (all / specific / none) plus the
 * organization picker. Shared by the invite form and the Edit User modal
 * (#7034) so both set `partner_users.org_access` / `org_ids` the same way.
 */
export default function OrgAccessFields({
  idPrefix,
  orgAccess,
  orgIds,
  organizations,
  onChange,
  orgIdsError
}: OrgAccessFieldsProps) {
  const { t } = useTranslation('settings');
  const [orgSearch, setOrgSearch] = useState('');
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const orgSearchRef = useRef<HTMLInputElement>(null);
  const orgDropdownRef = useRef<HTMLDivElement>(null);

  const filteredOrgs = useMemo(
    () =>
      organizations.filter(
        org =>
          !orgIds.includes(org.id) &&
          org.name.toLowerCase().includes(orgSearch.toLowerCase())
      ),
    [organizations, orgIds, orgSearch]
  );

  const addOrg = (orgId: string) => {
    onChange(orgAccess, [...orgIds, orgId]);
    setOrgSearch('');
    setOrgDropdownOpen(false);
    orgSearchRef.current?.focus();
  };

  const removeOrg = (orgId: string) => {
    onChange(orgAccess, orgIds.filter(id => id !== orgId));
  };

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (orgDropdownRef.current && !orgDropdownRef.current.contains(e.target as Node)) {
        setOrgDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4">
      <div>
        <h3 className="text-sm font-semibold">{t('userInviteForm.orgAccess.title')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('userInviteForm.orgAccess.description')}
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor={`${idPrefix}-access`} className="text-sm font-medium">
          {t('userInviteForm.orgAccess.level')}
        </label>
        <select
          id={`${idPrefix}-access`}
          value={orgAccess}
          onChange={e => onChange(e.target.value as OrgAccessLevel, orgIds)}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        >
          <option value="all">{t('userInviteForm.orgAccess.all')}</option>
          <option value="selected">{t('userInviteForm.orgAccess.selected')}</option>
          <option value="none">{t('userInviteForm.orgAccess.none')}</option>
        </select>
      </div>
      {orgAccess === 'selected' && (
        <div className="space-y-2">
          <label htmlFor={`${idPrefix}-org-search`} className="text-sm font-medium">
            {t('userInviteForm.orgAccess.organizations')}
          </label>
          {/* Selected org chips */}
          {orgIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {orgIds.map(id => {
                const org = organizations.find(o => o.id === id);
                return (
                  <span
                    key={id}
                    className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary"
                  >
                    {org?.name ?? id}
                    <button
                      type="button"
                      onClick={() => removeOrg(id)}
                      className="ml-0.5 rounded-sm hover:text-destructive"
                      aria-label={t('userInviteForm.orgAccess.removeOrg', { name: org?.name ?? id })}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
                        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                      </svg>
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {/* Search input + dropdown */}
          <div ref={orgDropdownRef} className="relative">
            <input
              id={`${idPrefix}-org-search`}
              ref={orgSearchRef}
              type="text"
              value={orgSearch}
              onChange={e => {
                setOrgSearch(e.target.value);
                setOrgDropdownOpen(true);
              }}
              onFocus={() => setOrgDropdownOpen(true)}
              placeholder={t('userInviteForm.orgAccess.searchPlaceholder')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            {orgDropdownOpen && (
              <div className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border bg-card shadow-md">
                {filteredOrgs.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    {organizations.length === 0
                      ? t('userInviteForm.orgAccess.noOrganizations')
                      : t('userInviteForm.orgAccess.noMatches')}
                  </p>
                ) : (
                  filteredOrgs.map(org => (
                    <button
                      key={org.id}
                      type="button"
                      onClick={() => addOrg(org.id)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors"
                    >
                      {org.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          {orgIdsError && <p className="text-sm text-destructive">{orgIdsError}</p>}
        </div>
      )}
    </div>
  );
}
