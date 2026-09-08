import { useMemo } from 'react';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  detectStrictScriptPatterns,
  strictScriptPatternExplanation,
} from '@breeze/shared';

/**
 * Security review for a script's content (#5129).
 *
 * The agent refuses to execute a script matching one of its STRICT-level
 * danger patterns unless the dispatch payload carries that pattern's
 * description in the acknowledged set. Before #5129 there was no way to put a
 * description in that set from anywhere in the product, so `Set-ItemProperty
 * ... HKLM` — routine MSP configuration work — was simply impossible to run as
 * a script.
 *
 * This is where the human decision is made: the patterns the content matches,
 * what each one means, and a checkbox per pattern. It renders nothing at all
 * for the overwhelming majority of scripts, which match nothing.
 *
 * Two deliberate absences:
 *
 *   - BASIC-level patterns (`rm -rf /`, `Format-Volume`, fork bombs) never
 *     appear here. `detectStrictScriptPatterns` only reports Strict patterns,
 *     so there is no surface on which to offer an unconditional block for
 *     acknowledgement.
 *   - There is no "acknowledge all" control. Each risk is accepted
 *     individually and on purpose; a bulk affordance is how a per-pattern
 *     approval quietly degrades into the blanket flag this design exists to
 *     avoid.
 *
 * The pattern DESCRIPTIONS are not translated. They are protocol values
 * compared byte-for-byte against the agent's own strings — a translated
 * acknowledgement would never match on the device. Only the surrounding
 * chrome goes through i18n.
 */
export type ScriptSecurityReviewProps = {
  /** Current script content, as typed in the editor. */
  content: string;
  /** Descriptions currently acknowledged. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Read-only rendering for a script the viewer may not edit (system rows). */
  disabled?: boolean;
};

export default function ScriptSecurityReview({
  content,
  value,
  onChange,
  disabled = false,
}: ScriptSecurityReviewProps) {
  const { t } = useTranslation('scripts');

  // Recomputed as the operator types. 28 pre-compiled regexes over a script
  // body is cheap; memoized anyway because Monaco fires change events per
  // keystroke.
  const matched = useMemo(() => detectStrictScriptPatterns(content), [content]);

  const acknowledged = useMemo(() => new Set(value), [value]);
  const unacknowledgedCount = matched.filter(description => !acknowledged.has(description)).length;

  if (matched.length === 0) return null;

  const toggle = (description: string) => {
    if (disabled) return;
    // Rebuilt from `matched` rather than by splicing `value`, so a stale
    // acknowledgement for a pattern the content no longer contains cannot
    // survive an unrelated toggle. The server applies the same intersection.
    const next = new Set(acknowledged);
    if (next.has(description)) next.delete(description);
    else next.add(description);
    onChange(matched.filter(candidate => next.has(candidate)));
  };

  return (
    <section
      data-testid="script-security-review"
      className="rounded-lg border border-warning/40 bg-warning/5 p-4"
    >
      <header className="flex items-start gap-3">
        {unacknowledgedCount > 0 ? (
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
        )}
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {t('scriptForm.securityReview.title')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {unacknowledgedCount > 0
              ? t('scriptForm.securityReview.blockedHint', { count: unacknowledgedCount })
              : t('scriptForm.securityReview.clearedHint')}
          </p>
        </div>
      </header>

      <ul className="mt-4 space-y-3">
        {matched.map(description => {
          const isAcknowledged = acknowledged.has(description);
          return (
            <li key={description}>
              <label
                className={`flex items-start gap-3 rounded-md border bg-background p-3 ${
                  disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer hover:bg-muted/40'
                }`}
              >
                <input
                  type="checkbox"
                  data-testid={`script-security-ack-${description}`}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-input"
                  checked={isAcknowledged}
                  disabled={disabled}
                  onChange={() => toggle(description)}
                />
                <span className="space-y-1">
                  {/* Not translated — a protocol value, see the file docblock. */}
                  <span className="block text-sm font-medium text-foreground">{description}</span>
                  <span className="block text-xs text-muted-foreground">
                    {strictScriptPatternExplanation(description)}
                  </span>
                  {!isAcknowledged && (
                    <span className="block text-xs font-medium text-warning">
                      {t('scriptForm.securityReview.willBlock')}
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <p className="mt-3 text-xs text-muted-foreground">
        {t('scriptForm.securityReview.footnote')}
      </p>
    </section>
  );
}
