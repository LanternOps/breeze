import { type useApprovalTheme } from '../../../theme';
import {
  saveWispNudgePrefs,
  selectWispNudgePrefs,
  selectWispNudgePrefsSaving,
  useAppDispatch,
  useAppSelector,
} from '../../../store';
import { useNetworkConnected } from '../../../lib/useNetworkConnected';
import { SegmentedRow, ToggleRow } from './settingsRows';
import {
  BRIEF_TIME_OPTIONS,
  DIGEST_CADENCE_OPTIONS,
  PROACTIVITY_OPTIONS,
  QUIET_OVERRIDE_OPTIONS,
  WISP_OFFLINE_HINT,
  briefOptionFor,
  briefTimeFromOption,
  cadenceValueFor,
  proactivityDescription,
  quietOverrideDescription,
} from './wispNudgePrefsCopy';

/**
 * Wisp nudge preferences (W06c). The "Wisp" section header is rendered by
 * SettingsSheet (its SectionHeader is file-local). Reads the slice itself, like
 * TicketPushPreferenceRows. Disabled while offline or a save is in flight; the
 * slice rolls back a failed save and SettingsSheet toasts it.
 */
export function WispNudgePreferenceRows({
  theme,
  pushRegistered,
}: {
  theme: ReturnType<typeof useApprovalTheme>;
  pushRegistered: boolean;
}) {
  const dispatch = useAppDispatch();
  const connected = useNetworkConnected();
  const prefs = useAppSelector(selectWispNudgePrefs);
  const saving = useAppSelector(selectWispNudgePrefsSaving);
  const disabled = !connected || saving;
  const offline = connected ? undefined : WISP_OFFLINE_HINT;

  const briefOption = briefOptionFor(prefs.briefTimeLocal);
  const briefDetail =
    offline ?? (briefOption === null ? `Custom (${prefs.briefTimeLocal})` : undefined);

  return (
    <>
      <ToggleRow
        label="In-app nudges"
        description={offline}
        value={prefs.channels.inApp}
        onChange={(v) => {
          void dispatch(saveWispNudgePrefs({ channels: { ...prefs.channels, inApp: v } }));
        }}
        disabled={disabled}
        theme={theme}
      />
      {pushRegistered ? (
        <ToggleRow
          label="Push nudges"
          description={offline}
          value={prefs.channels.push}
          onChange={(v) => {
            void dispatch(saveWispNudgePrefs({ channels: { ...prefs.channels, push: v } }));
          }}
          disabled={disabled}
          theme={theme}
        />
      ) : null}
      <SegmentedRow
        label="Quiet hours"
        description={offline ?? quietOverrideDescription(prefs.quietOverride)}
        value={prefs.quietOverride}
        options={[...QUIET_OVERRIDE_OPTIONS]}
        onChange={(v) => {
          if (v === prefs.quietOverride) return;
          void dispatch(saveWispNudgePrefs({ quietOverride: v }));
        }}
        disabled={disabled}
        theme={theme}
      />
      <SegmentedRow
        label="Digest"
        description={offline}
        value={String(cadenceValueFor(prefs.digestCadenceMinutes))}
        options={DIGEST_CADENCE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
        onChange={(v) => {
          const minutes = Number(v);
          if (minutes === prefs.digestCadenceMinutes) return;
          void dispatch(saveWispNudgePrefs({ digestCadenceMinutes: minutes }));
        }}
        disabled={disabled}
        theme={theme}
      />
      <SegmentedRow
        label="Morning brief"
        description={briefDetail}
        // A custom time set elsewhere highlights nothing: '' matches no option.
        value={briefOption ?? ''}
        options={BRIEF_TIME_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
        onChange={(v) => {
          const picked = BRIEF_TIME_OPTIONS.find((o) => o.value === v);
          if (!picked || picked.value === briefOption) return;
          void dispatch(saveWispNudgePrefs({ briefTimeLocal: briefTimeFromOption(picked.value) }));
        }}
        disabled={disabled}
        theme={theme}
      />
      <SegmentedRow
        label="Proactivity"
        description={offline ?? proactivityDescription(prefs.proactivity)}
        value={prefs.proactivity}
        options={[...PROACTIVITY_OPTIONS]}
        onChange={(v) => {
          if (v === prefs.proactivity) return;
          void dispatch(saveWispNudgePrefs({ proactivity: v }));
        }}
        disabled={disabled}
        theme={theme}
      />
    </>
  );
}
