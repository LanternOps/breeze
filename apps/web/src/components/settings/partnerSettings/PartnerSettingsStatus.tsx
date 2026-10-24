import { Fragment } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { ALL_TABS, TAB_BY_KEY, type TabKey } from './tabRegistry';
import { isUnitValid, unitOrder, type SaveOutcome, type SaveUnit, type SaveUnitId } from './saveUnits';

export type StatusState =
  | { kind: 'clean'; savedAt: number | null }
  | { kind: 'dirty'; tabs: TabKey[] }
  | { kind: 'invalid'; tab: TabKey; count: number; fieldId: string | null }
  | { kind: 'saving' }
  | { kind: 'partial'; tabs: TabKey[] }
  | { kind: 'failed'; tabs: TabKey[] }
  | { kind: 'autosaved'; savedAt: number }
  | { kind: 'autosaveFailed' }
  | { kind: 'readOnly' };

export type AutosaveReport = { tab: TabKey; outcome: SaveOutcome };

export type StatusInput = {
  units: readonly SaveUnit[];
  dirtyTabs: Partial<Record<TabKey, boolean>>;
  saving: boolean;
  /** The user cannot manage partner-wide settings, so nothing here can be saved. */
  readOnly: boolean;
  /** Units whose last header-Save run failed or conflicted. */
  failedUnits: readonly SaveUnitId[];
  /** Whether some other unit saved in that same run. */
  otherUnitsSaved: boolean;
  savedAt: number | null;
  autosave: AutosaveReport | null;
};

const RAIL_ORDER = ALL_TABS.map(t => t.key);
const inRailOrder = (tabs: Iterable<TabKey>) => {
  const set = new Set(tabs);
  return RAIL_ORDER.filter(k => set.has(k));
};

/** The header status line (spec §3.2), derived from the units' current state. */
export function deriveStatus(input: StatusInput): StatusState {
  if (input.readOnly) return { kind: 'readOnly' };
  if (input.saving) return { kind: 'saving' };

  const ordered = unitOrder(input.units);
  for (const unit of ordered) {
    if (!unit.isDirty() || isUnitValid(unit)) continue;
    const validity = unit.validity();
    const tab = inRailOrder(unit.tabs).find(k => validity[k] && !validity[k]!.isValid);
    if (tab) {
      const v = validity[tab]!;
      return { kind: 'invalid', tab, count: Math.max(1, v.invalidCount), fieldId: v.firstInvalidFieldId };
    }
  }

  const dirty = inRailOrder((Object.keys(input.dirtyTabs) as TabKey[]).filter(k => input.dirtyTabs[k]));
  if (dirty.length > 0) {
    const failedTabs = new Set(input.units.filter(u => input.failedUnits.includes(u.id) && u.isDirty()).flatMap(u => u.tabs));
    if (failedTabs.size > 0 && dirty.every(t => failedTabs.has(t))) {
      return { kind: input.otherUnitsSaved ? 'partial' : 'failed', tabs: dirty };
    }
    return { kind: 'dirty', tabs: dirty };
  }

  if (input.autosave) {
    const { outcome } = input.autosave;
    if (outcome.status === 'saved' && (input.savedAt === null || outcome.savedAt >= input.savedAt)) {
      return { kind: 'autosaved', savedAt: outcome.savedAt };
    }
    if (outcome.status === 'failed') return { kind: 'autosaveFailed' };
  }
  return { kind: 'clean', savedAt: input.savedAt };
}

const TAB_SLOT = '⁣tab⁣';

function formatTime(ms: number, lng: string): string {
  try {
    return new Intl.DateTimeFormat(lng, { hour: 'numeric', minute: '2-digit' }).format(ms);
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}

type Props = {
  state: StatusState;
  onOpenTab: (key: TabKey, fieldId?: string | null) => void;
};

export default function PartnerSettingsStatus({ state, onOpenTab }: Props) {
  const { t, i18n } = useTranslation('settings');
  const label = (key: TabKey) => t(/* i18n-dynamic */ TAB_BY_KEY[key].label);

  const tabLink = (key: TabKey, fieldId?: string | null) => (
    <button
      type="button"
      onClick={() => onOpenTab(key, fieldId ?? undefined)}
      className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
    >
      {label(key)}
    </button>
  );

  const tabList = (tabs: TabKey[]) => (
    <span>
      {tabs.map((key, i) => (
        <Fragment key={key}>
          {i > 0 && ', '}
          {tabLink(key)}
        </Fragment>
      ))}
    </span>
  );

  let content: React.ReactNode;
  switch (state.kind) {
    case 'clean':
      content = state.savedAt === null
        ? t('partnerSettingsPage.status.cleanNoTime')
        : t('partnerSettingsPage.status.clean', { time: formatTime(state.savedAt, i18n.language) });
      break;
    case 'dirty':
      content = <Trans i18nKey="partnerSettingsPage.status.dirty" t={t} components={{ tabs: tabList(state.tabs) }} />;
      break;
    case 'invalid': {
      // A plural key: rendered with t() (count selects _one/_other) and the tab
      // link spliced in at the {{tab}} slot.
      const [before, after = ''] = t('partnerSettingsPage.status.invalid', { count: state.count, tab: TAB_SLOT }).split(TAB_SLOT);
      content = <>{before}{tabLink(state.tab, state.fieldId)}{after}</>;
      break;
    }
    case 'saving':
      content = t('partnerSettingsPage.status.saving');
      break;
    case 'partial':
      content = <Trans i18nKey="partnerSettingsPage.status.partial" t={t} components={{ tabs: tabList(state.tabs) }} />;
      break;
    case 'failed':
      content = <Trans i18nKey="partnerSettingsPage.status.failed" t={t} components={{ tabs: tabList(state.tabs) }} />;
      break;
    case 'autosaved':
      content = t('partnerSettingsPage.status.autosaved', { time: formatTime(state.savedAt, i18n.language) });
      break;
    case 'autosaveFailed':
      content = t('partnerSettingsPage.status.autosaveFailed');
      break;
    case 'readOnly':
      content = t('partnerSettingsPage.status.readOnly');
      break;
  }

  const tone = state.kind === 'invalid' || state.kind === 'partial' || state.kind === 'failed' || state.kind === 'autosaveFailed'
    ? 'text-destructive'
    : 'text-muted-foreground';

  return (
    <p role="status" aria-live="polite" data-testid="partner-settings-status" data-state={state.kind} className={`self-center text-sm ${tone}`}>
      {content}
    </p>
  );
}
