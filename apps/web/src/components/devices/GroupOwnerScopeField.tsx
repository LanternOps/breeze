import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { GroupOwnerScope } from './partnerGroups';

export function GroupOwnerScopeField({ value, onChange, disabled }: {
  value: GroupOwnerScope;
  onChange: (value: GroupOwnerScope) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('devices');
  const name = useId();
  return (
    <fieldset data-testid="group-owner-scope" disabled={disabled} className="space-y-2">
      <legend className="text-sm font-medium">{t('partnerGroups.ownerScope')}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name={name} value="organization" data-testid="group-owner-scope-organization" checked={value === 'organization'} onChange={() => onChange('organization')} />
          {t('partnerGroups.organization')}
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <input type="radio" name={name} value="partner" data-testid="group-owner-scope-partner" checked={value === 'partner'} onChange={() => onChange('partner')} />
          {t('partnerGroups.partner')}
          <span className="text-xs text-muted-foreground">{t('partnerGroups.dynamicOnly')}</span>
        </label>
      </div>
      {value === 'partner' && <p className="text-xs text-muted-foreground">{t('partnerGroups.scopeHint')}</p>}
    </fieldset>
  );
}
