import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { runAction, ActionError } from '@/lib/runAction';

// Mirrors SEVERITY_TO_PRIORITY in apps/api/src/services/ticketService.ts —
// used only to prefill the select; the server applies the same default when
// priority is omitted, so drift degrades to a different prefill, not a bug.
export const SEVERITY_TO_PRIORITY: Record<string, string> = {
  critical: 'urgent',
  high: 'high',
  medium: 'normal',
  low: 'low',
  info: 'low'
};

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

type CategoryOption = {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
  sortOrder: number;
};

type CreateTicketFromAlertDialogProps = {
  alertId: string;
  alertTitle: string;
  alertSeverity: string;
  /** internalNumber of an open linked ticket, if one exists — shows a duplicate warning. */
  openTicketNumber: string | null;
  onClose: () => void;
  onCreated: () => void;
};

export default function CreateTicketFromAlertDialog({
  alertId, alertTitle, alertSeverity, openTicketNumber, onClose, onCreated
}: CreateTicketFromAlertDialogProps) {
  const [subject, setSubject] = useState(alertTitle);
  const [priority, setPriority] = useState(SEVERITY_TO_PRIORITY[alertSeverity] ?? 'normal');
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth('/ticket-categories');
        if (!res.ok) return; // category pick is optional — a load failure just hides options
        const data: CategoryOption[] = (await res.json()).data ?? [];
        if (!cancelled) setCategories(data.filter((c) => c.isActive));
      } catch {
        /* optional enrichment only */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = useCallback(async () => {
    if (!subject.trim() || submitting) return;
    setSubmitting(true);
    try {
      await runAction<{ data?: { internalNumber?: string } }>({
        request: () => fetchWithAuth(`/alerts/${alertId}/create-ticket`, {
          method: 'POST',
          body: JSON.stringify({
            subject: subject.trim(),
            priority,
            ...(categoryId ? { categoryId } : {})
          })
        }),
        errorFallback: 'Failed to create ticket',
        successMessage: (r) => r?.data?.internalNumber ? `Ticket ${r.data.internalNumber} created` : 'Ticket created',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      onCreated();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSubmitting(false);
    }
  }, [subject, priority, categoryId, submitting, alertId, onCreated]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" data-testid="alert-ticket-dialog">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold">Create ticket from alert</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>

        {openTicketNumber && (
          <div
            className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
            data-testid="alert-ticket-duplicate-warning"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>This alert already has open ticket {openTicketNumber}. Creating another is allowed but may duplicate work.</span>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium" htmlFor="alert-ticket-subject">Subject</label>
            <input
              id="alert-ticket-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={255}
              className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              data-testid="alert-ticket-subject"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium" htmlFor="alert-ticket-priority">Priority</label>
              <select
                id="alert-ticket-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                data-testid="alert-ticket-priority"
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="alert-ticket-category">Category</label>
              <select
                id="alert-ticket-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
                data-testid="alert-ticket-category"
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.parentId ? `— ${c.name}` : c.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm font-medium"
            data-testid="alert-ticket-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!subject.trim() || submitting}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            data-testid="alert-ticket-submit"
          >
            {submitting ? 'Creating…' : 'Create ticket'}
          </button>
        </div>
      </div>
    </div>
  );
}
