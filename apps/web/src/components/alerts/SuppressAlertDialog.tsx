import { useState } from 'react';
import { Dialog } from '../shared/Dialog';

// Preset suppression windows offered by the one-click Suppress action. The API
// (`POST /alerts/:id/suppress`) accepts an absolute `until` timestamp, so each
// timed preset is resolved to `now + ms` at confirm time. '24h' is the default.
// The 'forever' choice sends no `until`, leaving the alert muted indefinitely.
const PRESETS = [
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '8h', label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

type PresetId = (typeof PRESETS)[number]['id'];
type Choice = PresetId | 'forever';

type SuppressAlertDialogProps = {
  /** Single-alert title. Omit (and pass `count`) when suppressing in bulk. */
  alertTitle?: string;
  /** Number of alerts being suppressed; drives the bulk copy. Defaults to 1. */
  count?: number;
  onCancel: () => void;
  /**
   * Receives the resolved absolute, strictly-future suppression deadline, or
   * `null` for indefinite ("Forever") suppression.
   */
  onConfirm: (until: Date | null) => void;
};

export default function SuppressAlertDialog({ alertTitle, count = 1, onCancel, onConfirm }: SuppressAlertDialogProps) {
  const [choice, setChoice] = useState<Choice>('24h');
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    if (choice === 'forever') {
      onConfirm(null);
      return;
    }
    const preset = PRESETS.find((p) => p.id === choice);
    if (!preset) {
      setError('Pick a suppression duration.');
      return;
    }
    onConfirm(new Date(Date.now() + preset.ms));
  };

  return (
    <Dialog open onClose={onCancel} title="Suppress alert" maxWidth="md" className="p-6">
      <h2 className="text-lg font-semibold">Suppress alert</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {count > 1
          ? `How long should these ${count} alerts stay suppressed?`
          : <>How long should &ldquo;{alertTitle}&rdquo; stay suppressed?</>}
      </p>

      <fieldset className="mt-4 space-y-2" data-testid="suppress-duration-options">
        <legend className="sr-only">Suppression duration</legend>
        {PRESETS.map((p) => (
          <label
            key={p.id}
            className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
          >
            <input
              type="radio"
              name="suppress-duration"
              value={p.id}
              checked={choice === p.id}
              onChange={() => { setChoice(p.id); setError(null); }}
              data-testid={`suppress-duration-${p.id}`}
            />
            <span>{p.label}</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
          <input
            type="radio"
            name="suppress-duration"
            value="forever"
            checked={choice === 'forever'}
            onChange={() => { setChoice('forever'); setError(null); }}
            data-testid="suppress-duration-forever"
          />
          <span>Forever</span>
        </label>
      </fieldset>

      {error && (
        <p className="mt-3 text-sm text-destructive" data-testid="suppress-duration-error">
          {error}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          data-testid="suppress-cancel"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirm}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          data-testid="suppress-confirm"
        >
          Suppress
        </button>
      </div>
    </Dialog>
  );
}
