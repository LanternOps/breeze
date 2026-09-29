import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore, type Organization } from '../../stores/orgStore';

/**
 * Orgs a new report can be created for. The API refuses an out-of-service org
 * on create/generate (`REPORT_TENANT_INACTIVE`), so it is never offered.
 */
const CREATABLE_STATUSES: ReadonlySet<Organization['status']> = new Set(['active', 'trial']);

export type ReportTargetOrg = {
  /**
   * The org a create/generate request names in its JSON body:
   *  - the switcher's focused org;
   *  - else the one picked here;
   *  - else the only creatable org;
   *  - else null, meaning send no orgId and let the server decide, exactly as
   *    before W01. That covers an org token, which uses its own org, and an
   *    org list not loaded yet.
   */
  orgId: string | null;
  pickedOrgId: string | null;
  setPickedOrgId: (orgId: string | null) => void;
  /** All organizations, with several creatable orgs: the caller must render the picker. */
  pickerVisible: boolean;
  /** The picker is showing and nothing is chosen — a request would 400; block it. */
  missing: boolean;
  options: Organization[];
};

/**
 * Multi-org report series W01 (spec §3.7): under All organizations a partner
 * with several orgs gets `400 orgId is required when partner has multiple
 * organizations` from New Report and Templates, because the only org source
 * was the ambient switcher. This resolves the target org and says when the
 * caller must ask for one.
 *
 * Reads `organizations` defensively (`?? []`): several existing suites mock
 * `useOrgStore` with only `currentOrgId`, and an absent list means "not
 * loaded" — never "required".
 */
export function useReportTargetOrg(defaultOrgId: string | null = null): ReportTargetOrg {
  const { currentOrgId, organizations } = useOrgStore();
  const options = useMemo(
    () =>
      (organizations ?? [])
        .filter((org) => CREATABLE_STATUSES.has(org.status))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [organizations],
  );
  const [pickedOrgId, setPickedOrgId] = useState<string | null>(defaultOrgId);
  // A caller default that changes after mount (the templates page picker)
  // re-seeds the choice.
  useEffect(() => {
    if (defaultOrgId) setPickedOrgId(defaultOrgId);
  }, [defaultOrgId]);

  const hidden = (orgId: string | null): ReportTargetOrg => ({
    orgId,
    pickedOrgId,
    setPickedOrgId,
    pickerVisible: false,
    missing: false,
    options,
  });

  if (currentOrgId) return hidden(currentOrgId);
  if (options.length === 0) return hidden(null);
  if (options.length === 1) return hidden(options[0]!.id);

  const picked = options.some((org) => org.id === pickedOrgId) ? pickedOrgId : null;
  return {
    orgId: picked,
    pickedOrgId: picked,
    setPickedOrgId,
    pickerVisible: true,
    missing: picked === null,
    options,
  };
}

export function OrgPickerField({
  value,
  onChange,
  options,
  testId = 'report-org-picker',
  id = 'report-target-org',
}: {
  value: string | null;
  onChange: (orgId: string | null) => void;
  options: Organization[];
  testId?: string;
  id?: string;
}) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-2" data-testid={testId}>
      <label htmlFor={id} className="text-sm font-medium">
        {t('reports.orgPicker.label')}
      </label>
      <select
        id={id}
        data-testid={`${testId}-select`}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
      >
        <option value="">{t('reports.orgPicker.placeholder')}</option>
        {options.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{t('reports.orgPicker.hint')}</p>
    </div>
  );
}
