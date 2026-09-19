/**
 * Marks a monitor provisioned by Breeze (monitor_definitions.builtin_key).
 * Purely informational: built-ins are ordinary partner-owned rows.
 */
export function BuiltInBadge({ label, hint }: { label: string; hint?: string }) {
  return (
    <span
      data-testid="monitor-built-in-badge"
      title={hint}
      className="inline-flex items-center rounded-full border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-200"
    >
      {label}
    </span>
  );
}
