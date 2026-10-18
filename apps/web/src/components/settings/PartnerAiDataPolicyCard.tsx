import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { showToast } from '../shared/Toast';

/**
 * Partner-wide AI data policy defaults (device file reads + tool output
 * retention). Self-saving. Blank = Breeze default. Organizations may tighten
 * these on their own AI tab (OrgAiDataPolicyCard) but never loosen them.
 * Read-only when the caller cannot manage partner-wide policies.
 */
type Level = 'off' | 'no_user_profiles' | 'any_with_approval';
const LEVELS: Level[] = ['off', 'no_user_profiles', 'any_with_approval'];
type Dto = { deviceFileReadLevel: Level | null; toolOutputRetentionDays: number | null } | null;
type Defaults = { deviceFileReadLevel: Level; toolOutputRetentionDays: number | null };

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
  const [policy, setPolicy] = useState<Dto>(null);
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [saving, setSaving] = useState(false);
  // Bumped after a failed save / rejected entry so the uncontrolled days input
  // remounts with the stored value.
  const [reloadKey, setReloadKey] = useState(0);

  const load = async () => {
    try {
      const res = await fetchWithAuth('/partner/ai/data-policy');
      if (!res.ok) return;
      const data = await res.json();
      setPolicy(data.policy);
      setDefaults(data.defaults);
      setCanManage(Boolean(data.canManage));
    } catch {
      // Card stays hidden if the policy cannot be loaded.
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async (patch: { deviceFileReadLevel?: Level | null; toolOutputRetentionDays?: number | null }) => {
    if (!canManage) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/partner/ai/data-policy', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
        errorFallback: t('aiDataPolicy.failedToSave'),
        successMessage: t('aiDataPolicy.saved'),
        onUnauthorized: handleSessionExpired,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiDataPolicy.failedToSave') });
      setReloadKey((k) => k + 1);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (!defaults) return null;
  const current = policy?.deviceFileReadLevel ?? '';
  const locked = saving || !canManage;
  // No row -> Breeze default. Row with NULL -> keep forever (explicit).
  const stored = policy ? policy.toolOutputRetentionDays : defaults.toolOutputRetentionDays;
  const keepForever = stored === null;
  const days = stored ?? defaults.toolOutputRetentionDays ?? 30;

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
            onChange={() => void save({ deviceFileReadLevel: null })} />
          <span data-testid="partner-ai-data-policy-level-inherit">
            {t('aiDataPolicy.partnerInheritDefault', { value: levelTexts[defaults.deviceFileReadLevel].label })}
          </span>
        </label>
        {LEVELS.map((lvl) => (
          <label key={lvl} className="mt-2 flex items-start gap-2 text-sm">
            <input type="radio" name="partner-ai-data-policy-level" value={lvl} checked={current === lvl} disabled={locked}
              data-testid={`partner-ai-data-policy-level-${lvl}`} onChange={() => void save({ deviceFileReadLevel: lvl })} />
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
            onChange={() => void save({ toolOutputRetentionDays: days })} />
          <span>{t('aiDataPolicy.retentionKeepDays')}</span>
          <input type="number" min={1} max={3650} step={1} disabled={locked || keepForever}
            data-testid="partner-ai-data-policy-retention"
            key={`${stored ?? 'forever'}-${reloadKey}`}
            defaultValue={keepForever ? '' : days}
            onBlur={(e) => {
              const raw = e.currentTarget.value.trim();
              const n = Number(raw);
              if (raw === '' || !Number.isInteger(n) || n < 1 || n > 3650) {
                setReloadKey((k) => k + 1);
                return;
              }
              if (n === days && !keepForever) return;
              void save({ toolOutputRetentionDays: n });
            }}
            className="w-24 rounded-md border bg-background px-2 py-1 text-sm" />
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="partner-ai-data-policy-retention-mode" checked={keepForever} disabled={locked}
            data-testid="partner-ai-data-policy-retention-forever"
            onChange={() => void save({ toolOutputRetentionDays: null })} />
          <span>{t('aiDataPolicy.retentionKeepForever')}</span>
        </label>
        {!policy && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="partner-ai-data-policy-retention-default">
            {t('aiDataPolicy.retentionBreezeDefault', { days: defaults.toolOutputRetentionDays ?? 30 })}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">{t('aiDataPolicy.partnerRetentionHelp')}</p>
      </fieldset>
    </div>
  );
}
