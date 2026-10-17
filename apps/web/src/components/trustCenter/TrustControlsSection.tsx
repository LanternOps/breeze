import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FRAMEWORK_META,
  TRUST_CONTROL_CATEGORY_ORDER,
  type TelemetryControlId,
  type TrustPageUpdateInput,
  type TrustSettingValues,
} from '@breeze/shared';
import StatusPill from '@/components/billing/shared/StatusPill';
import type { OrgFetch } from '@/components/organizations/record/orgRecordFetch';
import { updateTrustPage, type TrustControlsState, type TrustPageState } from '@/lib/api/trustPage';
import { handleActionError, runAction } from '@/lib/runAction';
import { controlStatusPill } from './trustCenterPill';
import { useTrustControlCopy } from './trustControlCopy';
import { InheritanceBadge, ResetToInheritedButton, resetToInherited, sourceAfterLocalEdit } from './trustInheritance';

type ControlValues = Pick<TrustSettingValues, 'showPercentages' | 'showDeviceCount' | 'showManagedBy' | 'searchIndexable' | 'hiddenControlIds'>;

type ToggleKey = 'showPercentages' | 'showDeviceCount' | 'showManagedBy' | 'searchIndexable';
const TOGGLES: ToggleKey[] = ['showPercentages', 'showDeviceCount', 'showManagedBy', 'searchIndexable'];

interface Props {
  orgId: string;
  orgFetch: OrgFetch;
  state: TrustPageState;
  controls: TrustControlsState | null;
  canWrite: boolean;
  onReload: () => Promise<void>;
}

function Switch({ checked, disabled, labelledBy, testId, onClick }: {
  checked: boolean; disabled: boolean; labelledBy: string; testId: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'bg-emerald-500/80' : 'bg-muted'}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );
}

export default function TrustControlsSection({ orgId, orgFetch, state, controls, canWrite, onReload }: Props) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const copy = useTrustControlCopy();
  // Optimistic overlay on top of the EFFECTIVE values (page → template → default: what publish would
  // freeze); cleared per key once the save settles (success: after the reload lands; failure: revert).
  // Saves write explicit page values; "Reset to inherited" sends null so the value inherits again (W02g).
  const [local, setLocal] = useState<Partial<ControlValues>>({});
  const [busy, setBusy] = useState(false);
  const values: ControlValues = { ...state.effective.values, ...local };
  const published = state.page.publishedAt !== null;
  const sourceOf = (key: keyof ControlValues) => sourceAfterLocalEdit(state.effective.sources[key], key in local);

  const save = async (patch: TrustPageUpdateInput, optimistic: Partial<ControlValues>) => {
    if (!canWrite) return;
    setLocal((prev) => ({ ...prev, ...optimistic }));
    setBusy(true);
    const clear = () => setLocal((prev) => {
      const next = { ...prev };
      for (const k of Object.keys(optimistic)) delete (next as Record<string, unknown>)[k];
      return next;
    });
    try {
      await runAction({
        request: () => updateTrustPage(orgFetch, orgId, patch),
        errorFallback: tr('controls.saveFailed'),
      });
      // Refresh so publicationRevision is current before the next publish.
      await onReload();
      clear();
    } catch (err) {
      clear();
      handleActionError(err, tr('controls.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggleControl = (id: TelemetryControlId) => {
    const hidden = values.hiddenControlIds;
    const next = hidden.includes(id) ? hidden.filter((h) => h !== id) : [...hidden, id];
    void save({ hiddenControlIds: next }, { hiddenControlIds: next });
  };
  const toggleFlag = (key: ToggleKey) => void save({ [key]: !values[key] }, { [key]: !values[key] });
  // No optimistic value: the inherited one is only known once the reload resolves it.
  const reset = (key: keyof ControlValues) => void save(resetToInherited(key), {});

  const grouped = useMemo(() => {
    if (!controls) return [];
    const assessments = new Map(controls.assessments.map((a) => [a.id, a]));
    return TRUST_CONTROL_CATEGORY_ORDER.map((category) => ({
      category,
      rows: controls.catalog
        .filter((c) => c.category === category)
        .sort((a, b) => a.insurerRank - b.insurerRank)
        .map((def) => ({ def, assessment: assessments.get(def.id) })),
    })).filter((g) => g.rows.length > 0);
  }, [controls]);

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-controls-section">
      <h3 className="text-base font-semibold">{tr('sections.controlsHeading')}</h3>
      {published && (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="trust-controls-published-banner">
          {tr('controls.republishBanner')}
        </p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {TOGGLES.map((key) => (
          <div key={key} className="flex items-start justify-between gap-3 rounded-md border p-3">
            <div className="min-w-0 space-y-1">
              <div id={`trust-toggle-${key}-label`} className="text-sm">
                <div className="font-medium">{tr(`controls.toggles.${key}.label`)}</div>
                <div className="text-xs text-muted-foreground">{tr(`controls.toggles.${key}.description`)}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <InheritanceBadge source={sourceOf(key)} testId={`trust-inheritance-${key}`} />
                <ResetToInheritedButton source={sourceOf(key)} disabled={!canWrite || busy} onReset={() => reset(key)} testId={`trust-reset-${key}`} />
              </div>
            </div>
            <Switch
              checked={values[key]}
              disabled={!canWrite || busy}
              labelledBy={`trust-toggle-${key}-label`}
              testId={`trust-toggle-${key}`}
              onClick={() => toggleFlag(key)}
            />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2" data-testid="trust-controls-hidden-source">
        <InheritanceBadge source={sourceOf('hiddenControlIds')} testId="trust-inheritance-hiddenControlIds" />
        <ResetToInheritedButton source={sourceOf('hiddenControlIds')} disabled={!canWrite || busy} onReset={() => reset('hiddenControlIds')} testId="trust-reset-hiddenControlIds" />
      </div>

      {controls === null ? (
        <p className="text-sm text-muted-foreground" data-testid="trust-controls-unavailable">{tr('controls.unavailable')}</p>
      ) : (
        grouped.map(({ category, rows }) => (
          <div key={category} data-testid={`trust-controls-group-${category}`}>
            <h4 className="mb-2 text-sm font-semibold">{copy.categoryLabel(category)}</h4>
            <ul className="divide-y rounded-md border">
              {rows.map(({ def, assessment }) => {
                const shown = !values.hiddenControlIds.includes(def.id);
                const pill = assessment ? controlStatusPill(assessment.status) : null;
                return (
                  <li key={def.id} className="flex items-start justify-between gap-3 p-3" data-testid={`trust-control-row-${def.id}`}>
                    <div className="min-w-0 space-y-1">
                      <div id={`trust-control-${def.id}-label`} className="text-sm font-medium">{copy.controlTitle(def.id)}</div>
                      <div className="text-xs text-muted-foreground">{copy.controlDescription(def.id)}</div>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        {pill && <StatusPill role={pill.role} label={pill.label} testId={`trust-control-pill-${def.id}`} />}
                        {assessment && (
                          <span className="text-muted-foreground">
                            {assessment.percent !== null ? `${assessment.percent}% · ` : ''}
                            {tr('controls.assessedCount', { assessed: assessment.assessed, eligible: assessment.eligible })}
                          </span>
                        )}
                        {def.frameworkRefs.map((ref) => (
                          <span key={`${ref.framework}:${ref.ref}`} className="rounded border px-1.5 py-0.5 text-muted-foreground">
                            {FRAMEWORK_META[ref.framework].shortName} {ref.ref}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-xs">
                      <span aria-hidden="true">{shown ? tr('controls.shown') : tr('controls.hidden')}</span>
                      <Switch
                        checked={shown}
                        disabled={!canWrite || busy}
                        labelledBy={`trust-control-${def.id}-label`}
                        testId={`trust-control-switch-${def.id}`}
                        onClick={() => toggleControl(def.id)}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
