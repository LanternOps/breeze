import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Square } from 'lucide-react';
import { fetchRunningTimer, stopTimerAction, onTimerChanged, type RunningTimer } from '../../lib/timerActions';
import { ActionError } from '../../lib/runAction';
import { formatElapsedSeconds } from '../../lib/timeFormat';
import { showToast } from '../shared/Toast';

const POLL_MS = 60_000;

export default function TimerWidget() {
  const [timer, setTimer] = useState<RunningTimer | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(false);
  const [stopping, setStopping] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refresh = useCallback(() => {
    void fetchRunningTimer().then(setTimer).catch(() => setTimer(null));
  }, []);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, POLL_MS);
    const unsubscribe = onTimerChanged(refresh);
    return () => { clearInterval(poll); unsubscribe(); };
  }, [refresh]);

  useEffect(() => {
    if (!timer) return;
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [timer]);

  useEffect(() => {
    if (!popoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [popoverOpen]);

  // Escape closes the popover and returns focus to the stop button.
  useEffect(() => {
    if (!popoverOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopoverOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [popoverOpen]);

  // Focus the description textarea when the popover opens.
  useEffect(() => {
    if (popoverOpen) textareaRef.current?.focus();
  }, [popoverOpen]);

  if (!timer) return null;

  const openStop = () => {
    setDescription(timer.description ?? '');
    setBillable(timer.isBillable);
    setPopoverOpen(true);
  };

  const submitStop = async () => {
    setStopping(true);
    try {
      await stopTimerAction({ description: description || undefined, isBillable: billable });
      setPopoverOpen(false);
      setTimer(null);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: 'Failed to stop timer.' });
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="relative flex items-center gap-1 rounded-md border border-primary/40 bg-primary/5 px-2 py-1" data-testid="timer-widget">
      <Clock className="h-3.5 w-3.5 text-primary" aria-hidden />
      <span className="font-mono text-xs tabular-nums" data-testid="timer-widget-elapsed">{formatElapsedSeconds(elapsed)}</span>
      {timer.ticketId && (
        <a href={`/tickets/${timer.ticketId}`} className="max-w-32 truncate text-xs text-primary hover:underline" data-testid="timer-widget-ticket" title={timer.ticketSubject ?? undefined}>
          {timer.ticketNumber ?? 'ticket'}
        </a>
      )}
      <button type="button" ref={buttonRef} onClick={openStop} className="rounded p-0.5 text-muted-foreground hover:text-destructive" title="Stop timer" aria-label="Stop timer" aria-expanded={popoverOpen} aria-haspopup="dialog" data-testid="timer-widget-stop">
        <Square className="h-3.5 w-3.5" aria-hidden />
      </button>
      {popoverOpen && (
        <div ref={popoverRef} role="dialog" aria-label="Stop timer" className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border bg-popover p-3 shadow-lg" data-testid="timer-stop-popover">
          <p className="mb-2 text-sm font-medium">Stop timer</p>
          <textarea ref={textareaRef} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What did you work on?" rows={2} aria-label="Description" className="mb-2 w-full rounded-md border bg-background px-2 py-1.5 text-sm" data-testid="timer-stop-description" />
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} data-testid="timer-stop-billable" />
            Billable
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setPopoverOpen(false)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" data-testid="timer-stop-cancel">Cancel</button>
            <button type="button" onClick={() => void submitStop()} disabled={stopping} className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" data-testid="timer-stop-submit">
              {stopping ? 'Saving…' : 'Stop & save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
