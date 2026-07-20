/**
 * Centered placeholder for an empty list — a short title plus an optional
 * hint line. Used by every Files view (Search, Browse, Recents, Filing) in
 * place of an ad hoc "No files matched." string.
 */
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="ws-empty-state">
      <div className="ws-empty-state-title">{title}</div>
      {hint && <div className="ws-empty-state-hint">{hint}</div>}
    </div>
  );
}
