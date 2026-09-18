import { useId, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { allowedModesForKind, type AiAgentKind, type AiAgentMode } from '@breeze/shared';

/**
 * Task 13 (#5051): extracted verbatim from `AiAgentForm.tsx` (a pure move —
 * every test id, class name and copy key is unchanged) so the four-step
 * guided create flow's `PurposeStep` can render the identical Mode choice the
 * edit drawer always has. `actAck`/`enteringActMode` stay owned by the
 * caller: both drive that caller's OWN Save/Next gating (`AiAgentForm`'s Save
 * button, `PurposeStep`'s "leave this step" gate), so lifting them here would
 * make this component reach back out through a second channel for exactly
 * the value it already receives as a prop.
 */

const MODE_ORDER: readonly AiAgentMode[] = ['off', 'shadow', 'act'];

export interface ModeChoiceProps {
  mode: AiAgentMode;
  onChange: (mode: AiAgentMode) => void;
  /** Fleet Designer (W01) — the designer kind is read-only and produces no
   *  intents, so `allowedModesForKind` excludes `shadow` for it (there is
   *  nothing to shadow). Required so both callers (the edit drawer, the
   *  guided create flow's Purpose step) can never render a mode the kind
   *  itself disallows, matching the server's `createAiAgentSchema` rule. */
  kind: AiAgentKind;
  /** Whether this owner/agent may use act mode at all — the CREATE path has
   *  no `agent` DTO to read `supportedModes` off of, so the caller falls back
   *  to the shared `SUPPORTED_AGENT_MODES` constant, never `[]`. */
  actSupported: boolean;
  /** A genuine transition INTO act mode (captured once at mount by the
   *  caller) — only then does the acknowledgement checkbox appear. */
  enteringActMode: boolean;
  actAck: boolean;
  onActAckChange: (checked: boolean) => void;
  /** Riley bug (#4187 UI critique): whether leaving act will omit this
   *  draft's supervisedActionKeys from the save payload — a derived flag
   *  the caller computes from its OWN draft shape (ownerScope/mode/keys), so
   *  the announcement can never drift from what Save will actually send. */
  actKeysWillBeOmitted: boolean;
}

/** The mode radiogroup: the only choice on the form that can reach a device,
 *  rendered first, above Kind and Name in both the edit drawer and the
 *  guided create flow's Purpose step. */
export default function ModeChoice({
  mode,
  onChange,
  kind,
  actSupported,
  enteringActMode,
  actAck,
  onActAckChange,
  actKeysWillBeOmitted,
}: ModeChoiceProps) {
  const { t } = useTranslation('settings');
  const modeHeadingId = useId();
  const modeRefs = useRef<Partial<Record<AiAgentMode, HTMLButtonElement | null>>>({});
  // #6214: a mode the KIND excludes is not offered at all, rather than shown
  // greyed out. A designer has nothing to shadow, and a disabled Shadow card
  // between Off and Act read as "this is broken" — the one mode that works
  // then looked like the scary one. Tenant-level act eligibility is a
  // different question (it can change), so that card stays, disabled, with
  // its reason.
  const visibleModes = MODE_ORDER.filter((candidate) => allowedModesForKind(kind).includes(candidate));
  const modeUnavailable = (candidate: AiAgentMode) =>
    (candidate === 'act' && !actSupported) || !visibleModes.includes(candidate);
  const unavailableReason = (candidate: AiAgentMode): string | null =>
    candidate === 'act' && !actSupported ? t('aiAgentsPage.modeChoice.actUnavailable') : null;

  // A designer's `act` is "produce designs", not "change devices"
  // (`designProfile.ts` has no mutating tool) — so the card is labelled On,
  // carries no warning tone, and the act panel below explains what it does
  // instead of warning about unattended execution.
  const designer = kind === 'designer';

  // Literal keys rather than a dynamic `t()` on the token: the closed
  // three-member union is worth spelling out so the keyUsage guard verifies
  // every label statically (same reason as AiAgentSchedulesSection's
  // `scheduleKindLabel`).
  const MODE_LABEL: Record<AiAgentMode, string> = {
    off: t('aiAgentsPage.modeChoice.off'),
    shadow: t('aiAgentsPage.modeChoice.shadow'),
    act: designer ? t('aiAgentsPage.modeChoice.designerAct') : t('aiAgentsPage.modeChoice.act'),
  };
  const MODE_CONSEQUENCE: Record<AiAgentMode, string> = {
    off: t('aiAgentsPage.modeChoice.offConsequence'),
    shadow: t('aiAgentsPage.modeChoice.shadowConsequence'),
    act: designer ? t('aiAgentsPage.modeChoice.designerActConsequence') : t('aiAgentsPage.modeChoice.actConsequence'),
  };

  const selectMode = (next: AiAgentMode) => {
    if (modeUnavailable(next) || next === mode) return;
    if (next === 'act') {
      onChange(next);
      return;
    }
    // Leaving act: only the acknowledgement belongs to act mode alone — a
    // genuine re-entry must ask again. `supervisedActionKeys` is NOT
    // cleared here: it stays in the draft so a later return to act restores
    // the operator's selection (the caller's save-body builder is what keeps
    // them out of effect while the mode isn't act).
    onActAckChange(false);
    onChange(next);
  };

  /** Roving-tabindex arrow navigation, per the radiogroup pattern: the group
   *  holds one tab stop and the arrows move BOTH focus and selection.
   *
   *  The starting point is the option that HAS FOCUS (read off the event
   *  target's `data-mode`), never the controlled `mode`. The two are normally
   *  the same — that is the roving contract — but they can diverge for one
   *  keystroke, and they did: the drawer's initial focus used to land on a
   *  `tabindex="-1"` card, so ArrowRight from Off (with Shadow selected)
   *  stepped from SHADOW and selected `act`, skipping the option the user was
   *  actually looking at. Deriving from focus makes the two impossible to
   *  disagree. */
  const onModeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const selectable = MODE_ORDER.filter((candidate) => !modeUnavailable(candidate));
    if (selectable.length === 0) return;
    const focused = (event.target as HTMLElement | null)?.dataset?.mode as AiAgentMode | undefined;
    // Falls back to the selected option when the key came from the group
    // itself rather than from one of its cards.
    const from = focused && selectable.includes(focused) ? focused : mode;
    const current = Math.max(0, selectable.indexOf(from));
    let target: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        target = (current + 1) % selectable.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        target = (current - 1 + selectable.length) % selectable.length;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = selectable.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const next = selectable[target];
    if (!next) return;
    selectMode(next);
    modeRefs.current[next]?.focus();
  };

  // Roving-tabindex tab stop. Normally the checked option, but a stale row
  // can have `mode` set to an option that is now disabled (an agent saved
  // while `act` was supported, whose partner later lost act eligibility,
  // still stores `mode: 'act'`) — falling back to the first ENABLED option
  // keeps the group reachable by Tab at all, rather than leaving every radio
  // at tabIndex -1.
  const tabStopMode = modeUnavailable(mode) ? visibleModes.find((candidate) => !modeUnavailable(candidate)) : mode;

  return (
    <div className="md:col-span-2" data-testid="ai-agent-mode-field">
      <h3 id={modeHeadingId} className="text-sm font-semibold">
        {t('aiAgentsPage.modeChoice.legend')}
      </h3>
      <div
        role="radiogroup"
        aria-labelledby={modeHeadingId}
        onKeyDown={onModeKeyDown}
        className={`mt-2 grid gap-2 ${visibleModes.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}
        data-testid="ai-agent-mode"
      >
        {visibleModes.map((candidate) => {
          const selected = mode === candidate;
          const unavailable = modeUnavailable(candidate);
          return (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={unavailable}
              tabIndex={candidate === tabStopMode ? 0 : -1}
              ref={(node) => {
                modeRefs.current[candidate] = node;
              }}
              onClick={() => selectMode(candidate)}
              // Read by `onModeKeyDown` to find which card the keystroke came
              // from — the roving group's arrow keys must step from the FOCUSED
              // option, not from the stored one.
              data-mode={candidate}
              // Act selected does NOT look like Off/Shadow selected. All three
              // shared one primary-blue ring, so the one card that authorizes
              // unattended changes on a customer machine read as no more
              // consequential than "do nothing" — the warning tone is the same
              // one the act warning panel and its icon already use.
              // `flex flex-col items-start` overrides the UA stylesheet's
              // vertical centring of a <button>'s content box. The three cards
              // stretch to a common height in the grid but carry consequence
              // lines of different lengths, so centred content put the three
              // option NAMES on three different baselines — the one line a
              // reader scans across before choosing.
              className={`flex flex-col items-start rounded-lg border p-3 text-left transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                selected
                  ? candidate === 'act' && !designer
                    ? 'border-warning-strong bg-warning/10 ring-1 ring-warning-strong'
                    : 'border-primary bg-primary/10 ring-1 ring-primary'
                  : 'bg-background hover:border-primary/50 hover:bg-muted/40'
              }`}
              data-testid={`ai-agent-mode-${candidate}`}
            >
              {/* `w-full`: the card is now a flex COLUMN with `items-start`,
                  which shrinks its children to their content width — without
                  this the act card's `ml-auto` warning icon would sit against
                  the label instead of the card's right edge. */}
              <span className="flex w-full items-center gap-2">
                {/* Selection is encoded by SHAPE (a filled ring) as well as by
                    colour, so the choice survives a colourblind read. */}
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    selected
                      ? candidate === 'act' && !designer ? 'border-warning-strong' : 'border-primary'
                      : 'border-muted-foreground/50'
                  }`}
                >
                  {selected && (
                    <span
                      className={`h-2 w-2 rounded-full ${candidate === 'act' && !designer ? 'bg-warning-strong' : 'bg-primary'}`}
                    />
                  )}
                </span>
                <span className="text-sm font-medium">{MODE_LABEL[candidate]}</span>
                {candidate === 'act' && !designer && (
                  <AlertTriangle className="ml-auto h-4 w-4 shrink-0 text-warning-strong" aria-hidden="true" />
                )}
              </span>
              <span className="mt-1.5 block text-xs text-muted-foreground">
                {MODE_CONSEQUENCE[candidate]}
              </span>
              {unavailable && (
                <span
                  className="mt-1.5 block text-xs text-muted-foreground"
                  data-testid={`ai-agent-mode-${candidate}-unavailable`}
                >
                  {unavailableReason(candidate)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* #6214: the designer's act panel is an explanation, not a warning —
          the five bullets below (unattended execution, no rollback, one
          device per run) are all false for a kind with no mutating tool.
          The acknowledgement stays: the caller's Next/Save gate keys off it. */}
      {mode === 'act' && designer && (
        <div
          className="mt-2 space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm"
          data-testid="ai-agent-designer-act-note"
        >
          <p className="font-medium">{t('aiAgentsPage.designerNote.title')}</p>
          <p className="text-muted-foreground">{t('aiAgentsPage.designerNote.body')}</p>
          {enteringActMode && (
            <label className="flex items-start gap-2 pt-1 text-sm font-medium">
              <input
                type="checkbox"
                checked={actAck}
                onChange={(e) => onActAckChange(e.target.checked)}
                data-testid="ai-agent-act-ack"
              />
              <span>{t('aiAgentsPage.designerNote.ack')}</span>
            </label>
          )}
        </div>
      )}

      {/* #6202: an operator read "shadow" as "observe only, nothing to act
          on" and approved three cards expecting a dry run — shadow still
          mints real, executable Tier-3 approval cards. Attached to the
          choice (like the act warning below) rather than floated elsewhere,
          since it is what selecting Shadow MEANS. */}
      {mode === 'shadow' && (
        <div
          className="mt-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm text-muted-foreground"
          data-testid="ai-agent-shadow-info"
        >
          {t('aiAgentsPage.modeChoice.shadowApprovalNotice')}
        </div>
      )}

      {/* Attached to the choice, not floated below the rest of the fields:
          the warning and its acknowledgement are what the act card MEANS. */}
      {mode === 'act' && !designer && (
        <div
          className="mt-2 space-y-2 rounded-lg border border-warning-strong/50 bg-warning/10 p-3 text-sm"
          data-testid="ai-agent-act-warning"
        >
          <p className="flex items-start gap-2 font-medium">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-strong" aria-hidden="true" />
            <span>{t('aiAgentsPage.actWarning.title')}</span>
          </p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{t('aiAgentsPage.actWarning.unattended')}</li>
            <li>{t('aiAgentsPage.actWarning.verification')}</li>
            <li>{t('aiAgentsPage.actWarning.noRollback')}</li>
            <li>{t('aiAgentsPage.actWarning.singleDevice')}</li>
            <li>{t('aiAgentsPage.actWarning.actionCap')}</li>
          </ul>
          {enteringActMode && (
            <label className="flex items-start gap-2 pt-1 text-sm font-medium">
              <input
                type="checkbox"
                checked={actAck}
                onChange={(e) => onActAckChange(e.target.checked)}
                data-testid="ai-agent-act-ack"
              />
              <span>{t('aiAgentsPage.actWarning.ack')}</span>
            </label>
          )}
        </div>
      )}

      {/* Mounted UNCONDITIONALLY — only the text toggles. An aria-live
          region (`role="status"`) only announces changes to content that was
          already present in the accessibility tree; mounting it on demand
          meant the FIRST thing it ever had to say was never announced. */}
      <p
        className="mt-2 text-xs text-muted-foreground"
        role="status"
        data-testid="ai-agent-act-keys-cleared"
      >
        {actKeysWillBeOmitted ? t('aiAgentsPage.fields.actKeysCleared') : ''}
      </p>
    </div>
  );
}
