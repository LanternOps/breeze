import type { ReactNode } from 'react';
import { Loader2, Trash2, RotateCcw, PenLine } from 'lucide-react';

type FeatureTabShellProps = {
  title: string;
  description: string;
  icon: ReactNode;
  isConfigured: boolean;
  saving: boolean;
  error?: string;
  onSave: () => void;
  onRemove?: () => void;
  /** True when this tab is showing inherited settings from a parent policy */
  isInherited?: boolean;
  /** Called when user clicks "Override" on an inherited tab */
  onOverride?: () => void;
  /** Called when user clicks "Revert to Parent" on an overridden tab */
  onRevert?: () => void;
  children: ReactNode;
};

export default function FeatureTabShell({
  title,
  description,
  icon,
  isConfigured,
  saving,
  error,
  onSave,
  onRemove,
  isInherited,
  onOverride,
  onRevert,
  children,
}: FeatureTabShellProps) {
  const badgeText = isInherited
    ? 'Configured (inherited)'
    : isConfigured
      ? 'Configured'
      : 'Not configured';

  const badgeClass = isInherited
    ? 'border-blue-500/40 bg-blue-500/20 text-blue-700'
    : isConfigured
      ? 'border-green-500/40 bg-green-500/20 text-green-700'
      : 'border-muted bg-muted/50 text-muted-foreground';

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted/50">
              {icon}
            </div>
            <div>
              <h2 className="text-lg font-semibold">{title}</h2>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          </div>
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${badgeClass}`}
          >
            {badgeText}
          </span>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Inline settings form */}
        <div className={`mt-6 ${isInherited ? 'opacity-60 pointer-events-none' : ''}`}>
          {children}
        </div>

        {/* Footer */}
        <div className="mt-6 flex items-center justify-between border-t pt-4">
          <div>
            {isInherited && onOverride && (
              <button
                type="button"
                onClick={onOverride}
                className="inline-flex items-center gap-2 rounded-md border border-primary/40 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10"
              >
                <PenLine className="h-4 w-4" />
                Override
              </button>
            )}
            {!isInherited && onRevert && (
              <button
                type="button"
                onClick={onRevert}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-md border border-blue-500/40 px-3 py-2 text-sm font-medium text-blue-700 transition hover:bg-blue-500/10 disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                Revert to Parent
              </button>
            )}
            {!isInherited && !onRevert && isConfigured && onRemove && (
              <button
                type="button"
                onClick={onRemove}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            )}
          </div>
          {!isInherited && (
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
