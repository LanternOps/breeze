import { useEffect, useMemo, useState } from 'react';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { isFieldDraftDirty } from './fieldDraft';
import { readPath, type PartnerInheritanceUi } from './inheritanceContext';
import type { DrillSelection } from './InheritanceSidePanel';
import type { TabKey } from './tabRegistry';
import type { Partner, PartnersMeState } from './usePartnersMeUnit';
import { inheritanceTabFor, useInheritanceStore, useTabInheritance } from './useTabInheritance';

/**
 * The partner settings shell's inheritance wiring (#9790 W4): the active
 * tab's counts, the selected drill-down, and whether the ≥1920 px side panel
 * replaces the drawer. Per-field widgets read the SAVED partner record, never
 * the draft; the draft only decides the "Saved value:" prefix.
 */
export function usePartnerInheritanceUi(args: {
  partnerId: string | null | undefined;
  partner: Partner | null;
  activeTab: TabKey;
  state: PartnersMeState | null;
  baseline: PartnersMeState | null;
}) {
  const { partnerId, partner, activeTab, state, baseline } = args;

  // Counts are cached for the page session, per partner.
  const setInheritancePartner = useInheritanceStore(s => s.setPartner);
  useEffect(() => { setInheritancePartner(partnerId ?? null); }, [partnerId, setInheritancePartner]);
  useEffect(() => () => useInheritanceStore.getState().reset(), []);

  const inheritanceTab = partner ? inheritanceTabFor(activeTab) : null;
  const tabState = useTabInheritance(inheritanceTab);

  // The org list behind a count: a drawer below 1920 px, the third column at
  // 1920 px and up (spec §5.5). Transient within a tab: component state, not the hash.
  const wide = useMediaQuery('(min-width: 1920px)');
  const [drill, setDrill] = useState<DrillSelection | null>(null);
  // A tab change closes the drill-down and lets a failed read retry on its next view.
  useEffect(() => {
    setDrill(null);
    useInheritanceStore.getState().dropUnavailable();
  }, [activeTab]);
  const sidePanel = wide && inheritanceTab !== null;

  const savedSettings = partner?.settings;
  const selectedFieldId = drill?.fieldId ?? null;
  const inheritanceUi = useMemo<PartnerInheritanceUi>(() => ({
    tabState,
    savedSetting: path => readPath(savedSettings, path),
    isFieldDirty: fieldId => isFieldDraftDirty(fieldId, state, baseline),
    openDrill: (fieldId, bucket) => setDrill({ fieldId, bucket }),
    selectedFieldId,
  }), [tabState, savedSettings, state, baseline, selectedFieldId]);

  return { inheritanceUi, tabState, drill, setDrill, sidePanel };
}
