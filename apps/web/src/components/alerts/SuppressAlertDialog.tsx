import { useMemo, useState } from 'react';
import { Dialog } from '../shared/Dialog';

// Preset suppression windows offered by the one-click Suppress action. The API
// (`POST /alerts/:id/suppress`) requires an absolute `until` timestamp, so each
// preset is resolved to `now + ms` at confirm time. '24h' is the default.
const PRESETS = [
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '8h', label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { id: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { id: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

type PresetId = (typeof PRESETS)[number]['id'];
type Choice = PresetId | 'custom';

type SuppressAlertDialogProps = {
  /** Single-alert title. Omit (and pass `count`) when suppressing in bulk. */
  alertTitle?: string;
  /** Number of alerts being suppressed; drives the bulk copy. Defaults to 1. */
  count?: number;
  onCancel: () => void;
  /** Receives the resolved absolute, strictly-future suppression deadline. */
  onConfirm: (until: Date) => void;
};

// datetime-local renders/parses in the browser's local zone, so a min derived
// from local-clock parts keeps the picker from offering past times.
function localDatetimeValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function SuppressAlertDialog({ alertTitle, count = 1, onCancel, onConfirm }: SuppressAlertDialogProps) {
  const [choice, setChoice] = useState<Choice>('24h');
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);

  const minCustom = useMemo(() => localDatetimeValue(new Date(Date.now() + 60 * 1000)), []);

  const confirm = () => {
    let until: Date;
    if (choice === 'custom') {
      if (!custom) {
        setError('Pick a date and time.');
        return;
      }
      until = new Date(custom);
      if (Number.isNaN(until.getTime())) {
        setError('That date and time is invalid.');
        return;
      }
    } else {
      const preset = PRESETS.find((p) => p.id === choice);
      if (!preset) {
        setError('Pick a suppression duration.');
        return;
      }
      until = new Date(Date.now() + preset.ms);
    }
    if (until.getTime() <= Date.now()) {
      setError('Suppression time must be in the future.');
      return;
    }
    onConfirm(until);
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
        {/* The radio and the datetime input are two separate controls, so each
            gets its own accessible name — the <label> wraps only the radio, and
            the input carries an aria-label — rather than one label spanning both. */}
        <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="radio"
              name="suppress-duration"
              value="custom"
              checked={choice === 'custom'}
              onChange={() => { setChoice('custom'); setError(null); }}
              data-testid="suppress-duration-custom"
            />
            <span>Until&hellip;</span>
          </label>
          <input
            type="datetime-local"
            aria-label="Custom suppression date and time"
            value={custom}
            min={minCustom}
            onChange={(e) => { setCustom(e.target.value); setChoice('custom'); setError(null); }}
            className="ml-auto rounded-md border bg-background px-2 py-1 text-sm"
            data-testid="suppress-duration-custom-input"
          />
        </div>
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
