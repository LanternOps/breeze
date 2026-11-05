import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import {
  RETENTION_FIELD_ID, defaultDays, retentionDaysValid, useAiDataPolicyDraft,
  type AiDataPolicyValue, type Level,
} from './partnerSettings/units/aiDataPolicyUnit';

/**
 * Partner-wide AI data policy defaults (device file reads + tool output
 * retention). A form card: edits are drafts the partner settings header Save
 * sends (aiDataPolicyUnit.ts). Blank = Breeze default. Organizations may
 * tighten these on their own AI tab (OrgAiDataPolicyCard) but never loosen
 * them. Read-only when the caller cannot manage partner-wide policies.
 */
const LEVELS: Level[] = ['off', 'no_user_profiles', 'any_with_approval'];

function levelText(t: TFunction): Record<Level, { label: string; help: string }> {
  return {
    off: { label: t('aiDataPolicy.levels.off.label'), help: t('aiDataPolicy.levels.off.help') },
    no_user_profiles: { label: t('aiDataPolicy.levels.no_user_profiles.label'), help: t('aiDataPolicy.levels.no_user_profiles.help') },
    any_with_approval: { label: t('aiDataPolicy.levels.any_with_approval.label'), help: t('aiDataPolicy.levels.any_with_approval.help') },
  };
}

export default function PartnerAiDataPolicyCard() {
  const { t } = useTranslation('settings');
  const levelTexts = levelText(t);
  const { slice, setDraft } = useAiDataPolicyDraft();
  const value = slice.draft;

  // The card stays hidden until (and unless) the policy loads.
  if (!value) return null;
  const { defaults, canManage } = value;
  const locked = !canManage;
  const set = (patch: Partial<AiDataPolicyValue>) => { if (!locked) setDraft(prev => ({ ...prev, ...patch })); };
  const current = value.level ?? '';
  const keepForever = value.retentionMode === 'forever';
  const daysInvalid = !retentionDaysValid(value);
  const errorId = `${RETENTION_FIELD_ID}-error`;

  return (
    <div className="mb-6" data-testid="partner-ai-data-policy-card">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5" />
        <h3 className="text-base font-semibold">{t('aiDataPolicy.title')}</h3>
      </div>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">{t('aiDataPolicy.partnerDescription')}</p>
      {!canManage && <p className="mb-3 text-xs text-muted-foreground">{t('aiDataPolicy.readOnly')}</p>}

      <fieldset disabled={locked}>
        <legend className="text-sm font-medium">{t('aiDataPolicy.levelLabel')}</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="partner-ai-data-policy-level" value="" checked={current === ''} disabled={locked}
            onChange={() => set({ level: null })} />
          <span data-testid="partner-ai-data-policy-level-inherit">
            {t('aiDataPolicy.partnerInheritDefault', { value: levelTexts[defaults.deviceFileReadLevel].label })}
          </span>
        </label>
        {LEVELS.map((lvl) => (
          <label key={lvl} className="mt-2 flex items-start gap-2 text-sm">
            <input type="radio" name="partner-ai-data-policy-level" value={lvl} checked={current === lvl} disabled={locked}
              data-testid={`partner-ai-data-policy-level-${lvl}`} onChange={() => set({ level: lvl })} />
            <span>
              <span className="font-medium">{levelTexts[lvl].label}</span>
              <span className="block text-muted-foreground">{levelTexts[lvl].help}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* On a partner row NULL retention means keep forever; the Breeze default
          (30 days) applies only while no row exists. So the mode is explicit. */}
      <fieldset className="mt-6" disabled={locked}>
        <legend className="text-sm font-medium">{t('aiDataPolicy.retentionLabel')}</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="partner-ai-data-policy-retention-mode" checked={!keepForever} disabled={locked}
            data-testid="partner-ai-data-policy-retention-days-mode"
            onChange={() => set({ retentionMode: 'days', daysText: value.daysText.trim() || String(defaultDays(value)) })} />
          <span>{t('aiDataPolicy.retentionKeepDays')}</span>
          <input type="number" min={1} max={3650} step={1} disabled={locked || keepForever}
            id={RETENTION_FIELD_ID}
            data-testid="partner-ai-data-policy-retention"
            value={value.daysText}
            aria-invalid={daysInvalid || undefined}
            aria-describedby={daysInvalid ? errorId : undefined}
            onChange={(e) => set({ daysText: e.target.value })}
            className={`w-24 rounded-md border bg-background px-2 py-1 text-sm ${daysInvalid ? 'border-destructive' : ''}`} />
        </label>
        {daysInvalid && (
          <p id={errorId} data-testid={errorId} className="mt-1 text-xs text-destructive">{t('partnerSettingsPage.validation.retentionDays')}</p>
        )}
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="partner-ai-data-policy-retention-mode" checked={keepForever} disabled={locked}
            data-testid="partner-ai-data-policy-retention-forever"
            onChange={() => set({ retentionMode: 'forever', daysText: '' })} />
          <span>{t('aiDataPolicy.retentionKeepForever')}</span>
        </label>
        {!value.hasRow && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="partner-ai-data-policy-retention-default">
            {t('aiDataPolicy.retentionBreezeDefault', { days: defaultDays(value) })}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{t('aiDataPolicy.partnerRetentionHelp')}</p>
      </fieldset>
    </div>
  );
}
