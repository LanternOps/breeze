import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { showToast } from '../shared/Toast';
import TranscriptRetentionPreview, { previewDays } from '../ai/TranscriptRetentionPreview';

/**
 * Org-level AI data policy (device file reads, tool output retention, and the
 * technician AI transcript window, #4342 W4).
 * Self-saving, outside the page's dirty/save cycle. Blank = inherit the partner
 * default; an org can only tighten, so options above the partner ceiling are
 * disabled. The partner default lives on Partner settings → AI Features.
 */
type Level = 'off' | 'no_user_profiles' | 'any_with_approval';
const LEVELS: Level[] = ['off', 'no_user_profiles', 'any_with_approval'];
const RANK: Record<Level, number> = { off: 0, no_user_profiles: 1, any_with_approval: 2 };
type Source = 'org' | 'partner' | 'default';
type Effective = {
  deviceFileReadLevel: Level;
  toolOutputRetentionDays: number | null;
  transcriptRetentionDays: number | null;
  source: { deviceFileReadLevel: Source; toolOutputRetentionDays: Source; transcriptRetentionDays: Source };
};
type Dto = {
  deviceFileReadLevel: Level | null;
  toolOutputRetentionDays: number | null;
  transcriptRetentionDays?: number | null;
} | null;
type Patch = { deviceFileReadLevel?: Level | null; toolOutputRetentionDays?: number | null; transcriptRetentionDays?: number | null };
type RetentionField = 'toolOutputRetentionDays' | 'transcriptRetentionDays';

function levelText(t: TFunction): Record<Level, { label: string; help: string }> {
  return {
    off: { label: t('aiDataPolicy.levels.off.label'), help: t('aiDataPolicy.levels.off.help') },
    no_user_profiles: { label: t('aiDataPolicy.levels.no_user_profiles.label'), help: t('aiDataPolicy.levels.no_user_profiles.help') },
    any_with_approval: { label: t('aiDataPolicy.levels.any_with_approval.label'), help: t('aiDataPolicy.levels.any_with_approval.help') },
  };
}

export default function OrgAiDataPolicyCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation('settings');
  const levelTexts = levelText(t);
  const [policy, setPolicy] = useState<Dto>(null);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [ceiling, setCeiling] = useState<Effective | null>(null);
  const [saving, setSaving] = useState(false);
  // Bumped after a failed save or a client-side refusal so both uncontrolled
  // day inputs remount with the stored value instead of keeping the rejected one.
  const [reloadKey, setReloadKey] = useState(0);
  // The transcript box as typed, so the preview follows the edit before it is saved.
  const [transcriptText, setTranscriptText] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetchWithAuth(`/ai/data-policy?orgId=${orgId}`);
      if (!res.ok) return;
      const data = await res.json();
      setPolicy(data.policy);
      setEffective(data.effective);
      setCeiling(data.ceiling);
      setTranscriptText(null);
    } catch {
      // Informational card: stays hidden if the policy cannot be loaded.
    }
  };
  useEffect(() => { void load(); }, [orgId]);

  const save = async (patch: Patch) => {
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/data-policy?orgId=${orgId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
        errorFallback: t('aiDataPolicy.failedToSave'),
        // The API answers a tighten-only violation with a bare machine token.
        friendly: (code, _message, body) => {
          if (code !== 'above_partner_ceiling') return undefined;
          const field = (body as { field?: string } | undefined)?.field;
          if (field === 'deviceFileReadLevel') return t('aiDataPolicy.aboveCeilingLevel');
          if (field === 'transcriptRetentionDays') {
            return t('aiDataPolicy.transcriptAboveCeiling', { days: ceiling?.transcriptRetentionDays ?? '' });
          }
          return t('aiDataPolicy.retentionAboveCeiling', { days: ceiling?.toolOutputRetentionDays ?? '' });
        },
        successMessage: t('aiDataPolicy.saved'),
        onUnauthorized: handleSessionExpired,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiDataPolicy.failedToSave') });
      setReloadKey((k) => k + 1);
      setTranscriptText(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (!effective || !ceiling) return null;
  const sourceLabel = (s: Source) =>
    s === 'org' ? t('aiDataPolicy.sourceOrg') : s === 'partner' ? t('aiDataPolicy.sourcePartner') : t('aiDataPolicy.sourceDefault');
  const current = policy?.deviceFileReadLevel ?? '';

  /**
   * Blur handler shared by both day fields: PUT the changed value. Refused
   * client-side: an unparseable entry (a number input reports partial input
   * such as "1e" as an empty value, which would otherwise clear the override)
   * and a value above the ceiling.
   */
  const commitDays = (field: RetentionField, input: HTMLInputElement) => {
    const refuse = (message: string) => {
      showToast({ type: 'error', message });
      setReloadKey((k) => k + 1);
      if (field === 'transcriptRetentionDays') setTranscriptText(null);
    };
    if (input.validity?.badInput) {
      refuse(t('aiDataPolicy.invalidDays'));
      return;
    }
    const v = input.value.trim();
    const next = v === '' ? null : Number(v);
    if (next === (policy?.[field] ?? null)) return;
    // `max` does not block typing: refuse client-side instead of PUTting a doomed value.
    const max = ceiling[field];
    if (next !== null && max !== null && next > max) {
      refuse(field === 'transcriptRetentionDays'
        ? t('aiDataPolicy.transcriptAboveCeiling', { days: max })
        : t('aiDataPolicy.retentionAboveCeiling', { days: max }));
      return;
    }
    void save({ [field]: next });
  };

  // Untouched: the window in force. Typed blank: the ceiling it inherits (the
  // partner value, or the Breeze default when the partner has no row).
  // Typed days: that window, unless it is above the ceiling (the save refuses it).
  // Keep forever previews nothing.
  const transcriptPreviewDays = (() => {
    if (transcriptText === null) return previewDays(effective.transcriptRetentionDays);
    if (transcriptText.trim() === '') return previewDays(ceiling.transcriptRetentionDays);
    const typed = previewDays(transcriptText);
    return typed !== null && ceiling.transcriptRetentionDays !== null && typed > ceiling.transcriptRetentionDays ? null : typed;
  })();

  return (
    <section className="mt-4 rounded-lg border bg-card p-6 shadow-xs" data-testid="org-ai-data-policy-card">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5" />
        <h2 className="text-lg font-semibold">{t('aiDataPolicy.title')}</h2>
      </div>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">{t('aiDataPolicy.orgDescription')}</p>

      <fieldset disabled={saving}>
        <legend className="text-sm font-medium">{t('aiDataPolicy.levelLabel')}</legend>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="radio" name="org-ai-data-policy-level" value="" checked={current === ''} onChange={() => void save({ deviceFileReadLevel: null })} />
          <span data-testid="org-ai-data-policy-level-inherit">
            {t('aiDataPolicy.inherit', {
              // Inherit means "clear the org override", so it resolves to the
              // partner ceiling, not to the current effective value (which an
              // org-stored tighter level would otherwise misreport).
              value: levelTexts[ceiling.deviceFileReadLevel].label,
              source: sourceLabel(ceiling.source.deviceFileReadLevel),
            })}
          </span>
        </label>
        {LEVELS.map((lvl) => {
          const above = RANK[lvl] > RANK[ceiling.deviceFileReadLevel];
          return (
            <label key={lvl} className="mt-2 flex items-start gap-2 text-sm">
              <input type="radio" name="org-ai-data-policy-level" value={lvl} checked={current === lvl} disabled={above}
                data-testid={`org-ai-data-policy-level-${lvl}`} onChange={() => void save({ deviceFileReadLevel: lvl })} />
              <span>
                <span className="font-medium">{levelTexts[lvl].label}</span>
                <span className="block text-muted-foreground">{levelTexts[lvl].help}</span>
                {above && <span className="block text-xs text-muted-foreground">{t('aiDataPolicy.abovePartnerCeiling')}</span>}
              </span>
            </label>
          );
        })}
      </fieldset>

      <label className="mt-6 block max-w-xs">
        <span className="text-sm font-medium">{t('aiDataPolicy.retentionLabel')}</span>
        <input type="number" min={1} max={ceiling.toolOutputRetentionDays ?? 3650} disabled={saving}
          data-testid="org-ai-data-policy-retention"
          key={`${policy?.toolOutputRetentionDays ?? 'inherit'}-${reloadKey}`}
          defaultValue={policy?.toolOutputRetentionDays ?? ''}
          placeholder={t('aiDataPolicy.retentionInherit', {
            value: effective.toolOutputRetentionDays ?? t('aiDataPolicy.keepForever'),
            source: sourceLabel(effective.source.toolOutputRetentionDays),
          })}
          onBlur={(e) => commitDays('toolOutputRetentionDays', e.currentTarget)}
          className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" />
        <span className="mt-1 block text-xs text-muted-foreground">{t('aiDataPolicy.retentionHelp')}</span>
      </label>

      <div className="mt-6 max-w-md">
        <label className="block max-w-xs">
          <span className="text-sm font-medium">{t('aiDataPolicy.transcriptLabel')}</span>
          <input type="number" min={1} max={ceiling.transcriptRetentionDays ?? 3650} disabled={saving}
            data-testid="org-ai-data-policy-transcript-retention"
            key={`${policy?.transcriptRetentionDays ?? 'inherit'}-${reloadKey}`}
            defaultValue={policy?.transcriptRetentionDays ?? ''}
            placeholder={t('aiDataPolicy.retentionInherit', {
              // Blank clears the org override, so it resolves to the ceiling (partner value or Breeze default).
              value: ceiling.transcriptRetentionDays ?? t('aiDataPolicy.keepForever'),
              source: sourceLabel(ceiling.source.transcriptRetentionDays),
            })}
            onChange={(e) => setTranscriptText(e.currentTarget.value)}
            onBlur={(e) => commitDays('transcriptRetentionDays', e.currentTarget)}
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm" />
        </label>
        <TranscriptRetentionPreview
          url={transcriptPreviewDays === null
            ? null
            : `/ai/data-policy/transcript-retention-preview?orgId=${encodeURIComponent(orgId)}&days=${transcriptPreviewDays}`}
          scope="org"
          testId="org-ai-data-policy-transcript-preview" />
        <span className="mt-1 block text-xs text-muted-foreground">{t('aiDataPolicy.transcriptHelp')}</span>
        <span className="mt-1 block text-xs text-muted-foreground" data-testid="org-ai-data-policy-transcript-audit-note">
          {t('aiDataPolicy.transcriptAuditNote')}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t('aiDataPolicy.transcriptClientNote')}{' '}
          <a href={`/ai-for-office#policy/${orgId}`} className="font-medium text-primary hover:underline"
            data-testid="org-ai-data-policy-transcript-client-link">
            {t('aiDataPolicy.transcriptClientLink')}
          </a>
        </span>
      </div>
    </section>
  );
}
