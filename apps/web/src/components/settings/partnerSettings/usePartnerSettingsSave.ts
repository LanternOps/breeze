import { useCallback, useRef, useState } from 'react';
import { i18n } from '@/lib/i18n';
import { showToast } from '../../shared/Toast';
import { runSaveUnits, type SaveOutcome, type SaveUnit, type SaveUnitId } from './saveUnits';

/**
 * The header Save (spec §3.3). Runs every dirty, valid unit in rail order;
 * each unit re-baselines itself when it saves. Error toasts stay per unit
 * (runAction); success is one aggregate toast, only when every unit that ran
 * saved. A failed or conflicting unit keeps its draft, so the next Save
 * re-sends only that unit.
 */
export function usePartnerSettingsSave(units: readonly SaveUnit[]) {
  const [saving, setSaving] = useState(false);
  const [lastOutcomes, setLastOutcomes] = useState<Partial<Record<SaveUnitId, SaveOutcome>>>({});
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const save = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const outcomes = await runSaveUnits(units);
      const ran = Object.values(outcomes) as SaveOutcome[];
      setLastOutcomes(outcomes);
      const times = ran.flatMap(o => (o.status === 'saved' ? [o.savedAt] : []));
      if (times.length > 0) setSavedAt(Math.max(...times));
      if (ran.length > 0 && ran.every(o => o.status === 'saved')) {
        showToast({ type: 'success', message: i18n.t('settings:partnerSettingsPage.saved') });
      }
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [units]);

  const failedUnits = (Object.keys(lastOutcomes) as SaveUnitId[])
    .filter(id => lastOutcomes[id]?.status === 'failed' || lastOutcomes[id]?.status === 'conflict');
  const otherUnitsSaved = Object.values(lastOutcomes).some(o => o?.status === 'saved');

  return { save, saving, lastOutcomes, failedUnits, otherUnitsSaved, savedAt };
}
