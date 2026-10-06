import { CHECKBOX } from '../ui';

/**
 * The consent at the point of acceptance: the full authorization text the server
 * hashes, verbatim and fully visible (never collapsed or scrolled), directly above
 * the checkbox that accepts it and tied to it with aria-describedby.
 */
export function AuthorizationBox({ id, text, checked, onChange, disabled, changedNotice, testIds }: {
  id: string; text: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
  /** The text changed under a ticked box (method switch, terms changed on the server). */
  changedNotice?: boolean;
  testIds?: { text?: string; checkbox?: string };
}) {
  return (
    <div className="space-y-3">
      <h2 id={`${id}-heading`} className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Authorization</h2>
      <p id={`${id}-text`} className="rounded-lg border border-border bg-muted/40 p-4 text-sm leading-relaxed text-foreground"
        data-testid={testIds?.text}>{text}</p>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm font-medium text-foreground">
        <input type="checkbox" className={CHECKBOX} checked={checked} disabled={disabled}
          aria-describedby={`${id}-text`} data-testid={testIds?.checkbox}
          onChange={event => onChange(event.target.checked)} />
        <span>I agree to this authorization</span>
      </label>
      {changedNotice && (
        <p className="text-sm font-medium text-warning-on-tint" role="status">
          The authorization changed. Please read it and agree again.
        </p>
      )}
    </div>
  );
}

export default AuthorizationBox;
