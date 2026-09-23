import { useTranslation } from 'react-i18next';
import { useJwtClaims } from '@/lib/authScope';
import { useOrgStore } from '../../stores/orgStore';
import { useAuthStore } from '../../stores/auth';

export type ReportOwnerScope = 'organization' | 'partner';

/**
 * Who owns a new report: one organization, or the partner (every active and
 * trial organization of the MSP, resolved live at each run — #3198 W01's
 * `partner_wide` scope).
 *
 * Gated on the JWT **scope claim**, never on `useOrgStore().partners.length`:
 * an organization token carries a partnerId it can never use
 * (`breeze_has_partner_access` is false for it, and the partner-owned create
 * branch sits behind `auth.scope === 'partner'`). `useJwtClaims` rather than
 * `getJwtClaims` because the access token is absent on every cold load and the
 * one-shot read would freeze that empty answer for the life of the mount
 * (`lib/authScope.ts`). Unresolved fails CLOSED: unknown is not partner.
 *
 * Also gated on `user.canManagePartnerWide` — the client-side counterpart of
 * the server's `canManagePartnerWidePolicies` (partnerOrgAccess 'all'), which
 * the partner-owned create requires. A 'selected'-access partner user is never
 * offered "All organizations" (it could only 403); with no organization
 * focused they are told to pick one instead (`needsOrganization`). Absent
 * (a session persisted before the field existed) reads as capable, like every
 * other partner-wide surface; the server still gates every write.
 *
 * Create-only. Ownership is immutable after create (the API answers 400
 * `report_ownership_immutable`), so there is no edit-page counterpart.
 */
export function useDefaultReportOwnerScope(): {
  canChoose: boolean;
  defaultScope: ReportOwnerScope;
  needsOrganization: boolean;
} {
  const state = useJwtClaims();
  const { currentOrgId } = useOrgStore();
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide) !== false;
  const isPartnerToken = state.status === 'resolved' && state.claims.scope === 'partner' && !!state.claims.partnerId;
  const canChoose = isPartnerToken && canManagePartnerWide;
  return {
    canChoose,
    // All organizations when the user is on the All-organizations view; the
    // focused organization otherwise.
    defaultScope: canChoose && !currentOrgId ? 'partner' : 'organization',
    // A partner user who may only create single-organization reports, on the
    // All-organizations view: there is no organization to own the report.
    needsOrganization: isPartnerToken && !canManagePartnerWide && !currentOrgId,
  };
}

export function ReportOwnerScopeField({
  value,
  onChange,
}: {
  value: ReportOwnerScope;
  onChange: (value: ReportOwnerScope) => void;
}) {
  const { t } = useTranslation('reports');
  const { canChoose, needsOrganization } = useDefaultReportOwnerScope();
  const { currentOrgId } = useOrgStore();
  if (needsOrganization) {
    return (
      <p data-testid="report-owner-scope-needs-org" role="status" className="rounded-md border p-4 text-sm text-muted-foreground">
        {t('reports.ownerScope.needsOrganizationHint')}
      </p>
    );
  }
  if (!canChoose) return null;
  // A single-organization report needs an organization to own it. With no
  // org focused (the All-organizations view), disable rather than let the
  // user pick it and 400 on submit — and say what to do instead.
  const orgChoiceDisabled = !currentOrgId;

  return (
    <fieldset className="space-y-3 rounded-md border p-4" data-testid="report-owner-scope">
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {t('reports.ownerScope.legend')}
      </legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name="report-owner-scope"
          className="mt-1"
          data-testid="report-owner-scope-partner"
          checked={value === 'partner'}
          onChange={() => onChange('partner')}
        />
        <span>
          <span className="font-medium">{t('reports.ownerScope.allOrganizations')}</span>
          <span data-testid="report-owner-scope-partner-hint" className="block text-xs text-muted-foreground">
            {t('reports.ownerScope.allOrganizationsHint')}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name="report-owner-scope"
          className="mt-1"
          data-testid="report-owner-scope-org"
          checked={value === 'organization'}
          disabled={orgChoiceDisabled}
          onChange={() => onChange('organization')}
        />
        <span>
          <span className={orgChoiceDisabled ? 'font-medium text-muted-foreground' : 'font-medium'}>
            {t('reports.ownerScope.singleOrganization')}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t('reports.ownerScope.singleOrganizationHint')}
          </span>
          {orgChoiceDisabled && (
            <span data-testid="report-owner-scope-org-disabled-hint" className="block text-xs text-muted-foreground">
              {t('reports.ownerScope.singleOrganizationDisabledHint')}
            </span>
          )}
        </span>
      </label>
    </fieldset>
  );
}
