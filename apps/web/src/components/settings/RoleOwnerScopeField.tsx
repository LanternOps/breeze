import { i18n } from '@/lib/i18n';
import type { OwnerScope } from '@/hooks/useDefaultOwnerScope';
import type { FleetOrgOwner } from '@/hooks/useFleetOrgOwner';

type RoleOwnerScopeFieldProps = {
  ownerScope: OwnerScope;
  onOwnerScopeChange: (scope: OwnerScope) => void;
  fleet: FleetOrgOwner;
  disabled?: boolean;
};

/**
 * Create-only owner axis for a custom role (#8370), shown to partner-scope
 * users only. Same shape as the peripheral policy ownership selector (#8338):
 * a partner/organization radio, plus an Organization picker that appears only
 * for an org role in the All-organizations view. In a focused view the org
 * role belongs to the header org, which is named here so the choice is never
 * silent.
 */
export default function RoleOwnerScopeField({
  ownerScope,
  onOwnerScopeChange,
  fleet,
  disabled = false
}: RoleOwnerScopeFieldProps) {
  const focusedOrgName = !fleet.isFleetScope
    ? fleet.organizations.find((o) => o.id === fleet.orgId)?.name
    : undefined;

  return (
    <fieldset className="space-y-2 rounded-md border p-4" data-testid="role-owner" disabled={disabled}>
      <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
        {i18n.t('settings:roleManager.ownerScope')}
      </legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name="role-owner-scope"
          className="mt-1"
          checked={ownerScope === 'partner'}
          onChange={() => onOwnerScopeChange('partner')}
          data-testid="role-owner-partner"
        />
        <span>
          {i18n.t('settings:roleManager.ownerScopePartner')}
          <span className="block text-xs text-muted-foreground">
            {i18n.t('settings:roleManager.ownerScopePartnerHelp')}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="radio"
          name="role-owner-scope"
          className="mt-1"
          checked={ownerScope === 'organization'}
          onChange={() => onOwnerScopeChange('organization')}
          data-testid="role-owner-org"
        />
        <span>
          {i18n.t('settings:roleManager.ownerScopeOrganization')}
          {ownerScope === 'organization' && focusedOrgName && (
            <span className="font-medium" data-testid="role-owner-org-name">
              {': '}{focusedOrgName}
            </span>
          )}
          <span className="block text-xs text-muted-foreground">
            {i18n.t('settings:roleManager.ownerScopeOrganizationHelp')}
          </span>
        </span>
      </label>

      {ownerScope === 'organization' && fleet.isFleetScope && (
        <div className="pt-2">
          <label className="text-sm font-medium" htmlFor="role-owner-org-select">
            {i18n.t('common:labels.organization')}
          </label>
          <select
            id="role-owner-org-select"
            value={fleet.orgId}
            onChange={(e) => fleet.setOrgId(e.target.value)}
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            data-testid="role-owner-org-picker"
          >
            <option value="" disabled>
              {i18n.t('common:layout.org.noSelection')}
            </option>
            {fleet.organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
          {!fleet.orgId && (
            <p className="mt-1 text-xs text-muted-foreground" data-testid="role-owner-org-required">
              {i18n.t('common:layout.orgRequired.title')}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
