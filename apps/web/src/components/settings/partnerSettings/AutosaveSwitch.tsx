/**
 * The toggle-switch control, reserved for settings that save the moment they
 * change (spec §3.1). A boolean the header Save sends is a checkbox instead.
 */
export default function AutosaveSwitch({
  checked,
  onChange,
  disabled,
  labelledBy,
  describedBy,
  label,
  testId,
  className = '',
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  labelledBy?: string;
  describedBy?: string;
  /** Accessible name when there is no visible label to point `labelledBy` at. */
  label?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-label={labelledBy ? undefined : label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? 'bg-emerald-500/80' : 'bg-muted'
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );
}
