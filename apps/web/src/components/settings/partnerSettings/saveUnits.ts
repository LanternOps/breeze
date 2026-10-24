import { ALL_TABS, type TabKey } from './tabRegistry';

/**
 * Partner settings persistence units (spec §3.3). A unit is one endpoint that
 * saves atomically. The ten tabs behind `PATCH /orgs/partners/me` are one unit;
 * every self-contained form card is a unit of its own. Outcomes are shown per
 * tab, saves are grouped per unit.
 */
export type SaveUnitId =
  | 'partnersMe'
  | 'callerVerification'
  | 'loginBranding'
  | 'trustCenter'
  | 'aiFeatureDefaults'
  | 'aiDataPolicy';

export type SaveOutcome =
  | { status: 'saved'; savedAt: number }
  | { status: 'failed' }
  | { status: 'conflict' }
  | { status: 'cancelled' };

export type TabValidity = { isValid: boolean; invalidCount: number; firstInvalidFieldId: string | null };

export const VALID_TAB: TabValidity = { isValid: true, invalidCount: 0, firstInvalidFieldId: null };

export interface SaveUnit {
  id: SaveUnitId;
  tabs: readonly TabKey[];
  isDirty(): boolean;
  /** One entry per tab of the unit that has something to report; valid ⇔ every entry isValid. */
  validity(): Partial<Record<TabKey, TabValidity>>;
  /**
   * Sends the unit's draft. Re-baselines the unit itself on success (to the
   * snapshot it sent, so an edit made during the request stays dirty) and
   * never throws: failures come back as an outcome.
   */
  save(): Promise<SaveOutcome>;
}

export const UNIT_TABS: Record<SaveUnitId, readonly TabKey[]> = {
  partnersMe: [
    'company', 'regional', 'defaults', 'eventLogs', 'remoteAccess',
    'security', 'notifications', 'aiBudgets', 'aiApprovals', 'branding',
  ],
  callerVerification: ['callerVerification'],
  loginBranding: ['loginBranding'],
  trustCenter: ['trustCenter'],
  aiFeatureDefaults: ['aiProvider'],
  aiDataPolicy: ['aiFeatures'],
};

const RAIL_INDEX = new Map<TabKey, number>(ALL_TABS.map((t, i) => [t.key, i]));

function earliestTab(unit: SaveUnit): number {
  return Math.min(...unit.tabs.map(t => RAIL_INDEX.get(t) ?? Number.MAX_SAFE_INTEGER));
}

/** Rail order: the earliest tab of each unit in `ALL_TABS`. */
export function unitOrder(units: readonly SaveUnit[]): SaveUnit[] {
  return [...units].sort((a, b) => earliestTab(a) - earliestTab(b));
}

export function isUnitValid(unit: SaveUnit): boolean {
  return Object.values(unit.validity()).every(v => !v || v.isValid);
}

/**
 * Runs every dirty, valid unit one at a time in rail order, so MFA step-up
 * prompts and error toasts appear one at a time. A failure neither stops nor
 * rolls back later units: none of the endpoints is transactional with another.
 */
export async function runSaveUnits(units: readonly SaveUnit[]): Promise<Partial<Record<SaveUnitId, SaveOutcome>>> {
  const outcomes: Partial<Record<SaveUnitId, SaveOutcome>> = {};
  for (const unit of unitOrder(units)) {
    if (!unit.isDirty() || !isUnitValid(unit)) continue;
    try {
      outcomes[unit.id] = await unit.save();
    } catch (err) {
      // An adapter bug must not abort the remaining units or hide the failure.
      console.error(`[partnerSettings] save unit ${unit.id} threw`, err);
      outcomes[unit.id] = { status: 'failed' };
    }
  }
  return outcomes;
}
