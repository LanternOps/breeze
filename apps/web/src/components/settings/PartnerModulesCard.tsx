import { useEffect, useState } from 'react';
import { Blocks } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { useOrgStore, type ServiceManagementMode } from '@/stores/orgStore';
import '@/lib/i18n';

/**
 * The modes this card offers (#5075 W04).
 *
 * `external` is deliberately ABSENT: the API accepts it, but choosing it needs a
 * PSA connection picker that ships with the external service-desk feature. A
 * partner already on `external` (set by that feature, or by an operator) keeps
 * the mode — the card renders neither radio checked rather than silently
 * rewriting their choice to `native` on the next save.
 */
const OFFERED_MODES = ['native', 'off'] as const;
type OfferedMode = (typeof OFFERED_MODES)[number];

type Props = {
  /**
   * The partner's stored mode, from the page's existing GET /orgs/partners/me.
   *
   * `undefined` means "not fetched yet" and is NOT the same as `'native'`: the
   * card displays the native default while loading, but must not write that
   * placeholder into the store — doing so would stomp the mode the Sidebar has
   * already fetched and make an `off` partner's Service Desk sections flash
   * back in every time Partner Settings mounts.
   */
  serviceManagementMode?: ServiceManagementMode;
};

/**
 * Partner Settings → Company: which service-desk/billing module this MSP runs.
 *
 * Saves immediately on change (no page-level Save button): the sidebar reads the
 * same store value, so the Service Desk and Billing sections appear/disappear as
 * soon as the PATCH lands, without a reload. A failed PATCH reverts the radio to
 * the last known-good mode and `runAction` toasts the reason — the UI never
 * shows a mode the server did not accept.
 */
export default function PartnerModulesCard({ serviceManagementMode }: Props) {
  const { t } = useTranslation('settings');
  const setStoreMode = useOrgStore((state) => state.setServiceManagementMode);

  // The radio's value. Seeded from the prop — the page's own GET
  // /orgs/partners/me, i.e. the server's answer — and updated optimistically on
  // click so the control responds immediately, then reconciled: left alone on
  // success, reverted to the previous value on failure.
  //
  // It deliberately does NOT read the store back. The store is a cache the
  // Sidebar seeds; preferring it here would let a stale persisted value from a
  // previous session override the fresher answer this page just fetched.
  const [mode, setMode] = useState<ServiceManagementMode>(serviceManagementMode ?? 'native');
  const [saving, setSaving] = useState(false);

  // Adopt the server's answer whenever the page re-fetches it, so the card and
  // the sidebar cannot disagree about what the partner actually runs. Guarded on
  // `undefined` (see the prop doc): a pre-fetch render must not publish the
  // display default as if the server had said it.
  useEffect(() => {
    if (serviceManagementMode === undefined) return;
    setMode(serviceManagementMode);
    setStoreMode(serviceManagementMode);
  }, [serviceManagementMode, setStoreMode]);

  const select = async (next: OfferedMode) => {
    if (next === mode || saving) return;
    const previous = mode;
    setMode(next);
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serviceManagementMode: next }),
          }),
        errorFallback: t('partnerSettingsPage.modules.saveFailed'),
        successMessage: t('partnerSettingsPage.modules.saved'),
      });
      // Only now does the sidebar change: the store is the single source the
      // nav gate reads, so it must not move until the server has agreed.
      setStoreMode(next);
    } catch (err) {
      setMode(previous);
      // A non-401 ActionError has already been toasted by runAction; a 401 is
      // handled by the auth redirect. Either way the revert above is the whole
      // of this handler's job — but a genuinely unexpected throw must not be
      // swallowed silently.
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  };

  // Copy resolved through LITERAL t() keys rather than a
  // `modules.${option}Label` template: the keyUsage contract test only checks
  // literal arguments, so interpolating here would need an `i18n-dynamic`
  // escape hatch and these four keys would stop being verified against the
  // locale files entirely.
  const copy: Record<OfferedMode, { label: string; description: string }> = {
    native: {
      label: t('partnerSettingsPage.modules.nativeLabel'),
      description: t('partnerSettingsPage.modules.nativeDescription'),
    },
    off: {
      label: t('partnerSettingsPage.modules.offLabel'),
      description: t('partnerSettingsPage.modules.offDescription'),
    },
  };

  return (
    <section className="rounded-lg border bg-card p-6 shadow-xs" data-testid="partner-modules-card">
      <div className="mb-2 flex items-center gap-2">
        <Blocks className="h-5 w-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">{t('partnerSettingsPage.modules.title')}</h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t('partnerSettingsPage.modules.description')}</p>

      <div role="radiogroup" aria-label={t('partnerSettingsPage.modules.title')} className="space-y-3">
        {OFFERED_MODES.map((option) => (
          <label
            key={option}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-4 hover:bg-muted/50"
          >
            <input
              type="radio"
              name="service-management-mode"
              value={option}
              checked={mode === option}
              disabled={saving}
              onChange={() => void select(option)}
              className="mt-1 h-4 w-4 shrink-0"
              data-testid={`partner-modules-mode-${option}`}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{copy[option].label}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{copy[option].description}</span>
            </span>
          </label>
        ))}
      </div>

      {mode === 'external' && (
        <p className="mt-4 text-sm text-muted-foreground" data-testid="partner-modules-external-note">
          {t('partnerSettingsPage.modules.externalNote')}
        </p>
      )}
    </section>
  );
}
