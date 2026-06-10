import { useCallback, useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import TicketFeed from './TicketFeed';
import TicketComposer from './TicketComposer';
import SlaChip from './SlaChip';
import { statusConfig, priorityConfig, type TicketDetail, type TicketStatus, type TicketPriority } from './ticketConfig';

interface Props {
  ticketId: string;
  onChanged?: () => void;       // queue refresh hook
  expanded?: boolean;            // full-page mode
  resolveRequestToken?: number;  // increments when the page-level `e` shortcut asks to open the resolve form
}

const STATUS_OPTIONS: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];
const PRIORITY_OPTIONS: TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

export default function TicketWorkbench({ ticketId, onChanged, expanded, resolveRequestToken }: Props) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<'not-found' | 'load' | undefined>();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const [railOpen] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setErrorKind(undefined);
    try {
      const res = await fetchWithAuth(`/tickets/${ticketId}`);
      if (res.status === 404 || res.status === 403) {
        setTicket(null);
        setError('Ticket not found. It may have been deleted.');
        setErrorKind('not-found');
        return;
      }
      if (!res.ok) throw new Error('Ticket failed to load.');
      const body = await res.json();
      setTicket(body.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ticket failed to load.');
      setErrorKind('load');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => { void load(); }, [load]);

  // Reset the inline resolve form when switching tickets — otherwise ticket B
  // could be resolved with ticket A's note (`e` on A, then `j` to B).
  useEffect(() => {
    setResolveOpen(false);
    setResolutionNote('');
  }, [ticketId]);

  // Page-level `e` shortcut: open the inline resolve form (UI brief: `e` opens the resolution-note form)
  useEffect(() => {
    if (resolveRequestToken) setResolveOpen(true);
  }, [resolveRequestToken]);

  const mutate = useCallback(async (path: string, body: unknown, success: string) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}${path}`, { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: `${success} failed. Retry.`,
        successMessage: success,
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await load();
      onChanged?.();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [ticketId, load, onChanged]);

  const onStatusChange = useCallback(async (status: TicketStatus) => {
    if (status === 'resolved') { setResolveOpen(true); return; }
    await mutate('/status', { status }, 'Status updated');
  }, [mutate]);

  const submitResolve = useCallback(async () => {
    if (!resolutionNote.trim()) return;
    await mutate('/status', { status: 'resolved', resolutionNote: resolutionNote.trim() }, 'Ticket resolved');
    setResolveOpen(false);
    setResolutionNote('');
  }, [mutate, resolutionNote]);

  const sendComment = useCallback(async (content: string, isPublic: boolean) => {
    await runAction({
      request: () => fetchWithAuth(`/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify({ content, isPublic }) }),
      errorFallback: 'Reply failed. Retry.',
      onUnauthorized: () => void navigateTo('/login', { replace: true })
    });
    await load();
    onChanged?.();
  }, [ticketId, load, onChanged]);

  if (loading) {
    return <div className="p-6 animate-pulse space-y-3" data-testid="ticket-workbench-loading">
      <div className="h-5 w-2/3 rounded bg-muted" /><div className="h-4 w-1/3 rounded bg-muted/60" /><div className="h-40 rounded bg-muted/40" />
    </div>;
  }
  if (error || !ticket) {
    return (
      <div className="p-6 text-center" data-testid="ticket-workbench-error">
        <p className="text-sm text-muted-foreground">{error ?? 'Ticket failed to load.'}</p>
        {errorKind === 'not-found' ? (
          <a href="/tickets" className="mt-2 inline-block rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="ticket-workbench-back">Back to queue</a>
        ) : (
          <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Retry</button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="ticket-workbench">
      {/* Header */}
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground" data-testid="ticket-workbench-number">{ticket.internalNumber ?? ticket.id.slice(0, 8)}</span>
          <h2 className="truncate text-base font-semibold">{ticket.subject}</h2>
          {!expanded && (
            <a href={`/tickets/${ticket.id}`} className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground" title="Open full page" data-testid="ticket-workbench-expand">
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{ticket.orgName}</span>
          {ticket.deviceHostname && (
            <>
              <span>·</span>
              <a className="hover:text-foreground hover:underline" href={`/devices?device=${ticket.deviceId}`}>{ticket.deviceHostname}</a>
            </>
          )}
          <span>·</span>
          <SlaChip ticket={ticket} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={ticket.status}
            onChange={(e) => void onStatusChange(e.target.value as TicketStatus)}
            className={cn('rounded-md border px-2 py-1 text-xs font-medium', statusConfig[ticket.status].color)}
            data-testid="ticket-workbench-status"
            aria-label="Status"
          >
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{statusConfig[s].label}</option>)}
          </select>
          <select
            value={ticket.priority}
            onChange={(e) => {
              void runAction({
                request: () => fetchWithAuth(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify({ priority: e.target.value }) }),
                errorFallback: 'Priority update failed. Retry.',
                onUnauthorized: () => void navigateTo('/login', { replace: true })
              }).then(() => { void load(); onChanged?.(); }).catch((err) => { if (!(err instanceof ActionError)) throw err; });
            }}
            className={cn('rounded-md border px-2 py-1 text-xs font-medium', priorityConfig[ticket.priority].color)}
            data-testid="ticket-workbench-priority"
            aria-label="Priority"
          >
            {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{priorityConfig[p].label}</option>)}
          </select>
          <button
            type="button"
            onClick={() => void mutate('/assign', { assigneeId: null }, 'Unassigned')}
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            data-testid="ticket-workbench-unassign"
          >
            {ticket.assigneeName ? `Assignee: ${ticket.assigneeName} ✕` : 'Unassigned'}
          </button>
        </div>
        {resolveOpen && (
          <div className="mt-2 rounded-md border bg-muted/30 p-2" data-testid="ticket-workbench-resolve-form">
            <label className="text-xs font-medium" htmlFor="resolve-note">Resolution note (visible to requester)</label>
            <textarea
              id="resolve-note"
              value={resolutionNote}
              onChange={(e) => setResolutionNote(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              data-testid="ticket-workbench-resolve-note"
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button type="button" onClick={() => setResolveOpen(false)} className="rounded-md border px-2 py-1 text-xs hover:bg-muted">Cancel</button>
              <button
                type="button"
                onClick={() => void submitResolve()}
                disabled={!resolutionNote.trim()}
                className="rounded-md bg-success px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
                data-testid="ticket-workbench-resolve-submit"
              >
                Resolve ticket
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Body: feed + rail */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {ticket.description && (
              <div className="border-b p-4">
                <p className="whitespace-pre-wrap text-sm">{ticket.description}</p>
              </div>
            )}
            <TicketFeed comments={ticket.comments} />
          </div>
          <TicketComposer requesterName={ticket.submitterName} onSend={sendComment} />
        </div>
        {railOpen && (
          <aside className="w-64 shrink-0 overflow-y-auto border-l p-3 text-sm hidden lg:block" data-testid="ticket-workbench-rail">
            <dl className="space-y-3">
              <div><dt className="text-xs text-muted-foreground">Requester</dt><dd>{ticket.submitterName ?? ticket.submitterEmail ?? 'Unknown'}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Source</dt><dd className="capitalize">{ticket.source}</dd></div>
              <div><dt className="text-xs text-muted-foreground">Created</dt><dd>{new Date(ticket.createdAt).toLocaleString()}</dd></div>
              {ticket.dueDate && <div><dt className="text-xs text-muted-foreground">Due</dt><dd>{new Date(ticket.dueDate).toLocaleString()}</dd></div>}
              {ticket.pendingReason && <div><dt className="text-xs text-muted-foreground">Waiting on</dt><dd>{ticket.pendingReason}</dd></div>}
              {ticket.resolutionNote && <div><dt className="text-xs text-muted-foreground">Resolution</dt><dd>{ticket.resolutionNote}</dd></div>}
              <div>
                <dt className="text-xs text-muted-foreground">Linked alerts</dt>
                <dd className="space-y-1">
                  {ticket.alertLinks.length === 0 && <span className="text-muted-foreground">None</span>}
                  {ticket.alertLinks.map((l) => (
                    <a key={l.id} href={`/alerts#${l.alertId}`} className="block truncate hover:underline" data-testid={`ticket-alert-link-${l.alertId}`}>
                      {l.alertTitle ?? l.alertId}
                    </a>
                  ))}
                </dd>
              </div>
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}
