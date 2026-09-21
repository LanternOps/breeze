import { useEffect, useState } from 'react';
import { Blocks, Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '@/stores/auth';
import { handleActionError, runAction } from '@/lib/runAction';
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

/**
 * Partner-level topology feature flags (`partner.settings.topologyFeatureFlags`).
 * All default to false server-side. The topology UI is only reachable when BOTH
 * `materialization` and `ui` are true, so the card exposes those two as one
 * "Network Topology" switch and the remaining four as sub-options under it.
 */
export const TOPOLOGY_FLAGS = ['materialization', 'ui', 'physical', 'interfaceHealth', 'diagnostics', 'ai'] as const;
export type TopologyFlag = (typeof TOPOLOGY_FLAGS)[number];
export type TopologyFeatureFlags = Partial<Record<TopologyFlag, boolean>>;

const TOPOLOGY_GATE_FLAGS = ['materialization', 'ui'] as const satisfies readonly TopologyFlag[];
const TOPOLOGY_SUB_FLAGS = ['physical', 'interfaceHealth', 'diagnostics', 'ai'] as const satisfies readonly TopologyFlag[];
type TopologySubFlag = (typeof TOPOLOGY_SUB_FLAGS)[number];

const isTopologyOn = (flags: TopologyFeatureFlags): boolean =>
  TOPOLOGY_GATE_FLAGS.every((flag) => flags[flag] === true);

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
  /**
   * The partner's stored topology flags, from the same GET /orgs/partners/me.
   * Same `undefined` = "not fetched yet" discipline as `serviceManagementMode`:
   * the card shows everything off while loading and never writes that
   * placeholder anywhere.
   */
  topologyFeatureFlags?: TopologyFeatureFlags;
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
export default function PartnerModulesCard({ serviceManagementMode, topologyFeatureFlags }: Props) {
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

  // Topology flags follow the same seed / optimistic-update / revert-on-failure
  // discipline as `mode`. `topologySaving` is separate from `saving` so a slow
  // module PATCH does not lock the topology controls and vice versa.
  const [topology, setTopology] = useState<TopologyFeatureFlags>(topologyFeatureFlags ?? {});
  const [topologySaving, setTopologySaving] = useState(false);

  // Adopt the server's answer whenever the page re-fetches it, so the card and
  // the sidebar cannot disagree about what the partner actually runs. Guarded on
  // `undefined` (see the prop doc): a pre-fetch render must not publish the
  // display default as if the server had said it.
  useEffect(() => {
    if (serviceManagementMode === undefined) return;
    setMode(serviceManagementMode);
    setStoreMode(serviceManagementMode);
  }, [serviceManagementMode, setStoreMode]);

  useEffect(() => {
    if (topologyFeatureFlags === undefined) return;
    setTopology(topologyFeatureFlags);
  }, [topologyFeatureFlags]);

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
      // `handleActionError`, NOT a rethrow: this runs under a fire-and-forget
      // `void select(...)` in onChange, so a rethrow becomes an unhandled
      // rejection that no one catches — the radio would snap back with no toast
      // and no telemetry. The helper toasts the fallback for anything runAction
      // did not already surface, and stays quiet for a 401 (the auth redirect
      // is the feedback there).
      handleActionError(err, t('partnerSettingsPage.modules.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * PATCH only the keys that change: the API merges `topologyFeatureFlags` one
   * level deep, so the main switch sends the two gate flags and a sub-option
   * sends just its own key. Optimistic, reverted on failure — same contract as
   * `select()` above, including `handleActionError` instead of a rethrow.
   */
  const patchTopology = async (patch: TopologyFeatureFlags) => {
    if (topologySaving) return;
    const previous = topology;
    setTopology({ ...previous, ...patch });
    setTopologySaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/orgs/partners/me', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { topologyFeatureFlags: patch } }),
          }),
        errorFallback: t('partnerSettingsPage.modules.saveFailed'),
        successMessage: t('partnerSettingsPage.modules.saved'),
      });
    } catch (err) {
      setTopology(previous);
      handleActionError(err, t('partnerSettingsPage.modules.saveFailed'));
    } finally {
      setTopologySaving(false);
    }
  };

  const topologyOn = isTopologyOn(topology);
  const toggleTopology = () => void patchTopology({ materialization: !topologyOn, ui: !topologyOn });
  const toggleTopologyFlag = (flag: TopologySubFlag) => void patchTopology({ [flag]: topology[flag] !== true });

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
  const topologyCopy: Record<TopologySubFlag, { label: string; description: string }> = {
    physical: {
      label: t('partnerSettingsPage.modules.topologyPhysicalLabel'),
      description: t('partnerSettingsPage.modules.topologyPhysicalDescription'),
    },
    interfaceHealth: {
      label: t('partnerSettingsPage.modules.topologyInterfaceHealthLabel'),
      description: t('partnerSettingsPage.modules.topologyInterfaceHealthDescription'),
    },
    diagnostics: {
      label: t('partnerSettingsPage.modules.topologyDiagnosticsLabel'),
      description: t('partnerSettingsPage.modules.topologyDiagnosticsDescription'),
    },
    ai: {
      label: t('partnerSettingsPage.modules.topologyAiLabel'),
      description: t('partnerSettingsPage.modules.topologyAiDescription'),
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

      <div className="mt-6 border-t pt-6" data-testid="partner-modules-topology-section">
        <div className="mb-2 flex items-center gap-2">
          <Network className="h-5 w-5 text-muted-foreground" />
          <h3 id="partner-modules-topology-label" className="text-base font-semibold">
            {t('partnerSettingsPage.modules.topologyTitle')}
          </h3>
          <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {t('partnerSettingsPage.modules.topologyBeta')}
          </span>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t('partnerSettingsPage.modules.topologyDescription')}</p>

        <div className="flex items-center justify-between gap-3 rounded-md border p-4">
          <span id="partner-modules-topology-on-label" className="text-sm font-medium">
            {t('partnerSettingsPage.modules.topologyOnLabel')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={topologyOn}
            aria-labelledby="partner-modules-topology-label partner-modules-topology-on-label"
            disabled={topologySaving}
            onClick={toggleTopology}
            data-testid="partner-modules-topology"
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${
              topologyOn ? 'bg-emerald-500/80' : 'bg-muted'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${
                topologyOn ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {topologyOn && (
          <div className="mt-3 space-y-3 pl-4" data-testid="partner-modules-topology-flags">
            {TOPOLOGY_SUB_FLAGS.map((flag) => (
              <label
                key={flag}
                className="flex cursor-pointer items-start gap-3 rounded-md border p-4 hover:bg-muted/50"
              >
                <input
                  type="checkbox"
                  checked={topology[flag] === true}
                  disabled={topologySaving}
                  onChange={() => toggleTopologyFlag(flag)}
                  className="mt-1 h-4 w-4 shrink-0"
                  data-testid={`partner-modules-topology-${flag}`}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{topologyCopy[flag].label}</span>
                  <span className="mt-1 block text-sm text-muted-foreground">{topologyCopy[flag].description}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
