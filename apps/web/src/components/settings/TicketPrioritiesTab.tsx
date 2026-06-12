import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { invalidateTicketConfig } from '../../lib/ticketConfigApi';
import { priorityConfig, type TicketPriority } from '../tickets/ticketConfig';

// Authoritative built-in SLA defaults (mirrors PRIORITY_SLA_DEFAULTS in apps/api).
const PRIORITY_SLA_PLACEHOLDER: Record<TicketPriority, { response: string; resolution: string }> = {
  urgent: { response: '60', resolution: '240' },
  high:   { response: '240', resolution: '1440' },
  normal: { response: '—', resolution: '—' },
  low:    { response: '—', resolution: '—' },
};

// Display order: urgent → high → normal → low.
const PRIORITY_ORDER: TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

interface PrioritySetting {
  label: string | null;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
}

type PrioritiesState = Record<TicketPriority, PrioritySetting>;

interface RowDraft {
  label: string;
  response: string;
  resolution: string;
}

type DraftState = Record<TicketPriority, RowDraft>;

const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

function buildDraft(priorities: PrioritiesState): DraftState {
  return Object.fromEntries(
    PRIORITY_ORDER.map((p) => {
      const s = priorities[p];
      return [
        p,
        {
          label: s.label ?? '',
          response: s.responseSlaMinutes !== null ? String(s.responseSlaMinutes) : '',
          resolution: s.resolutionSlaMinutes !== null ? String(s.resolutionSlaMinutes) : '',
        },
      ];
    })
  ) as DraftState;
}

function buildPayload(draft: DraftState): Record<TicketPriority, { label: string | null; responseSlaMinutes: number | null; resolutionSlaMinutes: number | null }> {
  return Object.fromEntries(
    PRIORITY_ORDER.map((p) => {
      const d = draft[p];
      const label = d.label.trim() === '' ? null : d.label.trim();
      const responseSlaMinutes = d.response.trim() === '' ? null : parseInt(d.response.trim(), 10);
      const resolutionSlaMinutes = d.resolution.trim() === '' ? null : parseInt(d.resolution.trim(), 10);
      return [p, { label, responseSlaMinutes, resolutionSlaMinutes }];
    })
  ) as Record<TicketPriority, { label: string | null; responseSlaMinutes: number | null; resolutionSlaMinutes: number | null }>;
}

const EMPTY_PRIORITIES: PrioritiesState = Object.fromEntries(
  PRIORITY_ORDER.map((p) => [p, { label: null, responseSlaMinutes: null, resolutionSlaMinutes: null }])
) as PrioritiesState;

export default function TicketPrioritiesTab() {
  const [priorities, setPriorities] = useState<PrioritiesState>(EMPTY_PRIORITIES);
  const [draft, setDraft] = useState<DraftState>(buildDraft(EMPTY_PRIORITIES));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchWithAuth('/ticket-config');
      if (res.ok) {
        const body = (await res.json()) as { data: { priorities: PrioritiesState } };
        const loaded = body.data?.priorities ?? EMPTY_PRIORITIES;
        setPriorities(loaded);
        setDraft(buildDraft(loaded));
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const updateRow = useCallback((p: TicketPriority, field: keyof RowDraft, value: string) => {
    setDraft((prev) => ({ ...prev, [p]: { ...prev[p], [field]: value } }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/ticket-config/priorities', {
            method: 'PUT',
            body: JSON.stringify({ priorities: buildPayload(draft) }),
          }),
        errorFallback: 'Failed to save priority settings. Retry.',
        successMessage: 'Priority settings saved',
        onUnauthorized: UNAUTHORIZED,
      });
      invalidateTicketConfig();
      void load();
    } catch (err) {
      handleActionError(err, 'Failed to save priority settings. Retry.');
    }
    setSaving(false);
  }, [draft, load]);

  return (
    <div className="max-w-3xl" data-testid="ticket-priorities-tab">
      <div>
        <h2 className="text-lg font-semibold">Ticket Priorities</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Customize priority labels and set default SLA response and resolution times.
        </p>
      </div>

      <div className="mt-6">
        {loading ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="ticket-priorities-loading">
            Loading.
          </p>
        ) : error ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="ticket-priorities-error">
            Priority settings failed to load.{' '}
            <button
              type="button"
              onClick={() => void load()}
              className="underline hover:text-foreground"
              data-testid="ticket-priorities-retry"
            >
              Retry
            </button>
          </p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="pb-2 text-left text-xs font-semibold text-muted-foreground">Priority</th>
                  <th className="pb-2 text-left text-xs font-semibold text-muted-foreground">Label</th>
                  <th className="pb-2 text-left text-xs font-semibold text-muted-foreground">Response (min)</th>
                  <th className="pb-2 text-left text-xs font-semibold text-muted-foreground">Resolution (min)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {PRIORITY_ORDER.map((p) => (
                  <tr key={p} data-testid={`priority-row-${p}`}>
                    <td className="py-3 pr-4 font-medium">{priorityConfig[p].label}</td>
                    <td className="py-3 pr-4">
                      <input
                        type="text"
                        value={draft[p].label}
                        onChange={(e) => updateRow(p, 'label', e.target.value)}
                        maxLength={40}
                        placeholder={priorityConfig[p].label}
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                        data-testid={`priority-label-${p}`}
                      />
                    </td>
                    <td className="py-3 pr-4">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={draft[p].response}
                        onChange={(e) => updateRow(p, 'response', e.target.value)}
                        placeholder={PRIORITY_SLA_PLACEHOLDER[p].response}
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                        data-testid={`priority-response-${p}`}
                      />
                    </td>
                    <td className="py-3">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={draft[p].resolution}
                        onChange={(e) => updateRow(p, 'resolution', e.target.value)}
                        placeholder={PRIORITY_SLA_PLACEHOLDER[p].resolution}
                        className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                        data-testid={`priority-resolution-${p}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="mt-3 text-xs text-muted-foreground">
              Order of precedence: category SLA → org override → these defaults.
            </p>

            <div className="mt-4">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                data-testid="priorities-save"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
