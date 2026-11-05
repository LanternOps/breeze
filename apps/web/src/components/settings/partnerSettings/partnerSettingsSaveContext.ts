import { createContext, useContext } from 'react';
import type { SaveOutcome } from './saveUnits';
import type { TabKey } from './tabRegistry';

/**
 * What the partner settings page offers the cards it renders: `submit` runs
 * the header Save (a form card's Enter), `reportAutosave` puts an autosave
 * control's outcome on the header status line (spec §3.1–3.2). Outside the
 * page both are no-ops, so a card still renders on its own (tests, reuse).
 */
export type PartnerSettingsSaveApi = {
  submit: () => void;
  reportAutosave: (tab: TabKey, outcome: SaveOutcome) => void;
};

const noop = () => {};

export const PartnerSettingsSaveContext = createContext<PartnerSettingsSaveApi>({ submit: noop, reportAutosave: noop });

export function usePartnerSettingsSaveApi(): PartnerSettingsSaveApi {
  return useContext(PartnerSettingsSaveContext);
}
