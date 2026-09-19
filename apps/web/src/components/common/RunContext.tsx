import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { LiveSession } from '@/services/deviceActions';

/**
 * The shared "run as System / logged-in user" control and its read-only twin
 * (#4888).
 *
 * Before this, only the Scripts-library Run modal and the device/bulk script
 * picker let the operator choose a run context; every other way to launch a
 * script used the saved default, and nothing anywhere showed which context a
 * run had actually used — which is a large part of why the OliveTech GCPW
 * failures (#4882) looked random: the same script ran alternately as SYSTEM
 * and as the user with no visible control over which.
 *
 * `ScriptExecutionModal` and `ScriptPickerModal` still carry their own inline
 * selects with their own long-standing `data-testid`s and secrets warnings;
 * they are not migrated here in this change (see the PR notes). New surfaces
 * use this one.
 */

/** What a caller may choose at launch time. */
export type RunContextChoice = 'system' | 'user';
/** What a script row / execution row may hold — `elevated` is save-time only. */
export type RunContextValue = 'system' | 'user' | 'elevated';

export function isRunContextValue(value: unknown): value is RunContextValue {
  return value === 'system' || value === 'user' || value === 'elevated';
}

const SELECT_CLASS =
  'h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

type RunContextSelectProps = {
  /**
   * `null` means "inherit the script's saved default" (needs
   * `allowScriptDefault`).
   *
   * Typed as the WIDE `RunContextValue`, not `RunContextChoice`, so a stored
   * `'elevated'` can be displayed and preserved. `onChange` stays narrow —
   * elevation is not something this control can hand out (#4888).
   */
  value: RunContextValue | null;
  onChange: (value: RunContextChoice | null) => void;
  /**
   * Offer an explicit "Script default" option. On by default for surfaces that
   * configure a run for later (automations); off for surfaces that launch one
   * now, where the control is prefilled from the script and an empty option
   * would just be a second way to say the same thing.
   */
  allowScriptDefault?: boolean;
  /** The script's saved value, named inside the "Script default" option label. */
  scriptDefault?: RunContextValue | null;
  disabled?: boolean;
  /** Rendered above the select. Omit for toolbar rows that are already labelled. */
  showLabel?: boolean;
  id?: string;
  testId?: string;
  className?: string;
  /**
   * Session targeting for a `user` run. Only meaningful on a single device
   * whose helper is on-demand — the caller decides that and simply omits this
   * prop otherwise (the API rejects `targetSessionId` for anything else).
   */
  sessionTarget?: {
    sessions: LiveSession[];
    value: number | null;
    onChange: (value: number | null) => void;
    testId?: string;
  };
};

export function RunContextSelect({
  value,
  onChange,
  allowScriptDefault = false,
  scriptDefault = null,
  disabled = false,
  showLabel = false,
  id,
  testId = 'run-context-select',
  className,
  sessionTarget,
}: RunContextSelectProps) {
  const { t } = useTranslation('common');

  const defaultLabel = scriptDefault
    ? t('runContext.scriptDefaultNamed', { context: t(/* i18n-dynamic */ `runContext.${scriptDefault}`) })
    : t('runContext.scriptDefault');

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {showLabel && (
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {t('runContext.label')}
        </label>
      )}
      <select
        id={id}
        value={value ?? ''}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === '' ? null : (next as RunContextChoice));
          // A session id is only ever valid alongside `user`; dropping it here
          // keeps the two controls from disagreeing (the API refuses the pair
          // outright, so leaving it set would turn a context switch into a
          // 400 the operator never asked for).
          if (next !== 'user') sessionTarget?.onChange(null);
        }}
        disabled={disabled}
        data-testid={testId}
        aria-label={showLabel ? undefined : t('runContext.label')}
        className={SELECT_CLASS}
      >
        {allowScriptDefault && <option value="">{defaultLabel}</option>}
        <option value="system">{t('runContext.system')}</option>
        <option value="user">{t('runContext.user')}</option>
        {/* A stored `elevated` is shown so the control displays the value that
            is actually in effect, and DISABLED because elevation is not a
            launch-time choice this control may hand out. Without the option
            the select would render orphaned (no matching <option>, so it
            reads as the first one) and the very next save would silently
            downgrade the action — the same class of bug #4888 exists to
            remove. Moving off it is a deliberate act and cannot be undone
            here; that is the intended trade. */}
        {value === 'elevated' && (
          <option value="elevated" disabled>
            {t('runContext.elevated')}
          </option>
        )}
      </select>

      {sessionTarget && value === 'user' && (
        <select
          value={sessionTarget.value ?? ''}
          onChange={(event) =>
            sessionTarget.onChange(event.target.value === '' ? null : Number(event.target.value))
          }
          disabled={disabled}
          data-testid={sessionTarget.testId ?? 'run-context-session-target'}
          aria-label={t('runContext.sessionLabel')}
          className={SELECT_CLASS}
        >
          <option value="">{t('runContext.sessionAny')}</option>
          {sessionTarget.sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {session.username} — {session.sessionId} ({session.state})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * Names a run context in prose: "System", "Logged-in user", "Logged-in user
 * (session 3)". Exported separately from the chip so a caller can drop it into
 * an existing metadata grid without inheriting the chip's styling.
 */
export function useRunContextLabel(): (
  runAs: RunContextValue | null | undefined,
  targetSessionId?: number | null,
) => string {
  const { t } = useTranslation('common');
  return (runAs, targetSessionId) => {
    if (!isRunContextValue(runAs)) return t('runContext.unknown');
    if (runAs === 'user' && targetSessionId != null) {
      return t('runContext.userInSession', { session: targetSessionId });
    }
    return t(/* i18n-dynamic */ `runContext.${runAs}`);
  };
}

type RunContextChipProps = {
  runAs: RunContextValue | null | undefined;
  targetSessionId?: number | null;
  /** Renders the "Run context" caption before the value. */
  withLabel?: boolean;
  className?: string;
  testId?: string;
};

/**
 * Read-only display of the run context an execution ACTUALLY used.
 *
 * A null `runAs` renders "Not recorded" rather than defaulting to System:
 * execution rows written before #4888 genuinely do not know, and inventing a
 * plausible answer here would be worse than admitting the gap — the whole
 * point of the column is that the operator can trust what it says.
 */
export function RunContextChip({
  runAs,
  targetSessionId,
  withLabel = false,
  className,
  testId = 'run-context-chip',
}: RunContextChipProps) {
  const { t } = useTranslation('common');
  const label = useRunContextLabel()(runAs, targetSessionId);
  const unknown = !isRunContextValue(runAs);

  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        // Three states, not two. `elevated` used to fall through to the same
        // calm styling as `user`, which reads as the LEAST privileged option
        // while actually being the most — the one place a colour must not
        // mislead is a badge naming a privilege level.
        unknown
          ? 'border-border bg-muted/40 text-muted-foreground'
          : runAs === 'elevated'
            ? 'border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-400'
            : runAs === 'system'
              ? 'border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-400'
              : 'border-sky-500/40 bg-sky-500/15 text-sky-700 dark:text-sky-400',
        className,
      )}
    >
      {withLabel && <span className="font-normal opacity-70">{t('runContext.effectiveLabel')}</span>}
      {label}
    </span>
  );
}
