# Native Ticketing Phase 1b (Frontend Queue + Workbench) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the technician ticketing UI in apps/web: split-pane queue + workbench, composer with internal-note safety, keyboard triage, create flow, categories settings, and alert/device integration points.

**Architecture:** Astro page + React islands following the Alerts pattern. Split-pane layout per the UI brief; selection synced to `window.location.hash` (internal number). All mutations through `runAction`. Consumes the Phase 1a API (`/tickets`, `/ticket-categories`, `/alerts/:id/create-ticket`).

**Tech Stack:** Astro, React, Tailwind (dark: classes), lucide-react, Vitest + jsdom, Playwright (data-testid only).

**Specs:** `docs/superpowers/specs/2026-06-09-native-ticketing-ui-brief.md` (authoritative for UX), `docs/superpowers/specs/2026-06-09-native-ticketing-design.md` §5.

**Branch:** `feat/ticketing-web-ui` (worktree via superpowers:using-git-worktrees; `pnpm install` in fresh worktrees; prefix pnpm/vitest with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`). Depends on Phase 1a being merged (or stacked on its branch).

**UI brief invariants (apply to every task):**
- Internal-note mode must be visually unmistakable (amber wash + persistent label + different send-button text); public reply is the default and resets per ticket.
- SLA/status colors are semantic only; brand/primary color for selection+focus only. No side-stripe borders, no gradient text, no modals where inline works.
- Ticket numbers render in mono. Errors: plain noun+verb ("Reply failed. Retry."). No em dashes in UI copy.
- Every interactive element gets a `data-testid` per `e2e-tests/README.md` naming.

---

### Task 1: Delete orphaned portal ticket components

**Files:**
- Delete: `apps/web/src/components/portal/TicketList.tsx`
- Delete: `apps/web/src/components/portal/TicketDetail.tsx`
- Delete: `apps/web/src/components/portal/TicketComments.tsx`
- Delete: `apps/web/src/components/portal/CreateTicketForm.tsx`

- [ ] **Step 1: Re-verify nothing imports them**

Run: `grep -rn "portal/TicketList\|portal/TicketDetail\|portal/TicketComments\|portal/CreateTicketForm" apps/web/src apps/portal/src 2>/dev/null | grep -v "apps/portal/src/components"`
Expected: no output (the real portal app has its own copies under `apps/portal/src/components/portal/`).

- [ ] **Step 2: Delete, build-check, commit**

```bash
git rm apps/web/src/components/portal/TicketList.tsx apps/web/src/components/portal/TicketDetail.tsx apps/web/src/components/portal/TicketComments.tsx apps/web/src/components/portal/CreateTicketForm.tsx
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git commit -m "chore(tickets): remove orphaned schema-drifted portal ticket components from apps/web"
```

---

### Task 2: Ticket config — types, status/priority/SLA vocabulary

**Files:**
- Create: `apps/web/src/components/tickets/ticketConfig.ts`
- Create: `apps/web/src/components/tickets/ticketConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { slaState, formatRelative, statusConfig, priorityConfig } from './ticketConfig';

describe('slaState', () => {
  const ticket = (over: Record<string, unknown>) => ({
    slaBreachedAt: null, dueDate: null, createdAt: '2026-06-09T00:00:00Z',
    resolutionSlaMinutes: null, status: 'open', ...over
  });

  it('is breached when slaBreachedAt is set', () => {
    expect(slaState(ticket({ slaBreachedAt: '2026-06-09T02:00:00Z' }) as never, new Date('2026-06-09T03:00:00Z')).kind).toBe('breached');
  });

  it('is at-risk at >=80% of resolution SLA elapsed', () => {
    // 100 min SLA, 85 min elapsed
    const s = slaState(ticket({ resolutionSlaMinutes: 100 }) as never, new Date('2026-06-09T01:25:00Z'));
    expect(s.kind).toBe('at-risk');
  });

  it('is quiet when healthy or when no SLA is configured', () => {
    expect(slaState(ticket({ resolutionSlaMinutes: 100 }) as never, new Date('2026-06-09T00:30:00Z')).kind).toBe('ok');
    expect(slaState(ticket({}) as never, new Date('2026-06-09T00:30:00Z')).kind).toBe('none');
  });

  it('closed/resolved tickets are never at-risk', () => {
    expect(slaState(ticket({ resolutionSlaMinutes: 10, status: 'resolved' }) as never, new Date('2026-06-10T00:00:00Z')).kind).toBe('none');
  });
});

describe('config completeness', () => {
  it('covers every status and priority', () => {
    expect(Object.keys(statusConfig).sort()).toEqual(['closed', 'new', 'on_hold', 'open', 'pending', 'resolved']);
    expect(Object.keys(priorityConfig).sort()).toEqual(['high', 'low', 'normal', 'urgent']);
  });
});

describe('formatRelative', () => {
  it('renders compact durations', () => {
    expect(formatRelative(95)).toBe('1h 35m');
    expect(formatRelative(60 * 24 * 2 + 60 * 4)).toBe('2d 4h');
    expect(formatRelative(40)).toBe('40m');
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

```typescript
export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TicketSummary {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  source: string;
  orgId: string;
  orgName: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  categoryId: string | null;
  dueDate: string | null;
  slaBreachedAt: string | null;
  resolutionSlaMinutes?: number | null;
  firstResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketComment {
  id: string;
  userId: string | null;
  portalUserId: string | null;
  authorName: string | null;
  authorType: string | null;
  commentType: 'comment' | 'internal' | 'status_change' | 'assignment' | 'time_entry' | 'system';
  content: string;
  isPublic: boolean;
  oldValue: string | null;
  newValue: string | null;
  createdAt: string;
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
  pendingReason: string | null;
  resolutionNote: string | null;
  comments: TicketComment[];
  alertLinks: Array<{ id: string; alertId: string; linkType: string; alertTitle: string | null; alertSeverity: string | null; alertStatus: string | null }>;
}

export const statusConfig: Record<TicketStatus, { label: string; color: string }> = {
  new: { label: 'New', color: 'bg-primary/15 text-primary border-primary/30' },
  open: { label: 'Open', color: 'bg-success/15 text-success border-success/30' },
  pending: { label: 'Pending', color: 'bg-warning/15 text-warning border-warning/30' },
  on_hold: { label: 'On hold', color: 'bg-muted text-muted-foreground border-border' },
  resolved: { label: 'Resolved', color: 'bg-success/15 text-success border-success/30' },
  closed: { label: 'Closed', color: 'bg-muted text-muted-foreground border-border' },
};

export const priorityConfig: Record<TicketPriority, { label: string; color: string; weight: number }> = {
  urgent: { label: 'Urgent', color: 'text-red-700 dark:text-red-400 bg-red-500/10 border-red-500/30', weight: 0 },
  high: { label: 'High', color: 'text-orange-700 dark:text-orange-400 bg-orange-500/10 border-orange-500/30', weight: 1 },
  normal: { label: 'Normal', color: 'text-muted-foreground bg-muted border-border', weight: 2 },
  low: { label: 'Low', color: 'text-muted-foreground bg-muted/50 border-border', weight: 3 },
};

export function formatRelative(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes));
  const d = Math.floor(m / (60 * 24));
  const h = Math.floor((m % (60 * 24)) / 60);
  const mins = m % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins}m`;
  return `${mins}m`;
}

export type SlaState =
  | { kind: 'none' }
  | { kind: 'ok'; minutesLeft: number }
  | { kind: 'at-risk'; minutesLeft: number }
  | { kind: 'breached'; minutesAgo: number };

// "Quiet until it matters": ok renders muted text, at-risk amber chip, breached red chip.
export function slaState(
  t: Pick<TicketSummary, 'slaBreachedAt' | 'createdAt' | 'status'> & { resolutionSlaMinutes?: number | null },
  now: Date = new Date()
): SlaState {
  if (t.status === 'resolved' || t.status === 'closed') return { kind: 'none' };
  if (t.slaBreachedAt) {
    return { kind: 'breached', minutesAgo: (now.getTime() - new Date(t.slaBreachedAt).getTime()) / 60_000 };
  }
  if (!t.resolutionSlaMinutes) return { kind: 'none' };
  const elapsed = (now.getTime() - new Date(t.createdAt).getTime()) / 60_000;
  const left = t.resolutionSlaMinutes - elapsed;
  if (left <= 0) return { kind: 'breached', minutesAgo: -left };
  if (elapsed >= 0.8 * t.resolutionSlaMinutes) return { kind: 'at-risk', minutesLeft: left };
  return { kind: 'ok', minutesLeft: left };
}
```

- [ ] **Step 3: Run tests, commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/ticketConfig.test.ts`
Expected: PASS (7 tests).

```bash
git add apps/web/src/components/tickets/
git commit -m "feat(tickets-ui): ticket config — types, status/priority vocab, SLA state machine"
```

---

### Task 3: SLA chip + queue list

**Files:**
- Create: `apps/web/src/components/tickets/SlaChip.tsx`
- Create: `apps/web/src/components/tickets/TicketQueueList.tsx`

First check the `cn` helper import path used by AlertList: `grep -n "import.*cn" apps/web/src/components/alerts/AlertList.tsx` — use the same path everywhere below.

- [ ] **Step 1: Implement `SlaChip.tsx`**

```tsx
import { slaState, formatRelative, type TicketSummary } from './ticketConfig';

export default function SlaChip({ ticket }: { ticket: TicketSummary }) {
  const s = slaState(ticket);
  if (s.kind === 'none') return <span className="text-xs text-muted-foreground">—</span>;
  if (s.kind === 'ok') {
    return <span className="text-xs text-muted-foreground" data-testid={`ticket-sla-${ticket.id}`}>{formatRelative(s.minutesLeft)}</span>;
  }
  if (s.kind === 'at-risk') {
    return (
      <span
        className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium bg-warning/15 text-warning border-warning/30"
        data-testid={`ticket-sla-${ticket.id}`}
      >
        {formatRelative(s.minutesLeft)} left
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium bg-destructive/15 text-destructive border-destructive/30"
      data-testid={`ticket-sla-${ticket.id}`}
    >
      Breached
    </span>
  );
}
```

(Note: the em-dash placeholder above is the typographic blank for "no SLA", not copy; if the codebase lints against it use `–` or empty.) Replace it with `'–'` if the copy linter flags it.

- [ ] **Step 2: Implement `TicketQueueList.tsx`**

```tsx
import { cn } from '@/lib/utils'; // confirmed path from the grep above
import SlaChip from './SlaChip';
import { statusConfig, priorityConfig, type TicketSummary } from './ticketConfig';

interface Props {
  tickets: TicketSummary[];
  selectedId: string | null;
  onSelect: (t: TicketSummary) => void;
  loading: boolean;
}

function timeAgo(iso: string): string {
  const mins = (Date.now() - new Date(iso).getTime()) / 60_000;
  if (mins < 60) return `${Math.max(1, Math.floor(mins))}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

export default function TicketQueueList({ tickets, selectedId, onSelect, loading }: Props) {
  if (loading) {
    return (
      <div className="divide-y" data-testid="tickets-queue-loading">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-3 py-3 animate-pulse">
            <div className="h-3.5 w-3/4 rounded bg-muted" />
            <div className="mt-2 h-3 w-1/2 rounded bg-muted/60" />
          </div>
        ))}
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground" data-testid="tickets-queue-empty">
        No tickets match.
      </div>
    );
  }

  return (
    <ul className="divide-y" role="listbox" aria-label="Ticket queue" data-testid="tickets-queue">
      {tickets.map((t) => (
        <li key={t.id}>
          <button
            type="button"
            role="option"
            aria-selected={t.id === selectedId}
            onClick={() => onSelect(t)}
            data-testid={`ticket-row-${t.id}`}
            className={cn(
              'w-full px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              t.id === selectedId && 'bg-primary/5 border-l-0' // selection tint; brand color reserved for selection
            )}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground shrink-0">{t.internalNumber ?? '·'}</span>
              <span className="truncate text-sm font-medium">{t.subject}</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium', priorityConfig[t.priority].color)}
              >
                {priorityConfig[t.priority].label}
              </span>
              <span
                className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium', statusConfig[t.status].color)}
              >
                {statusConfig[t.status].label}
              </span>
              <span className="truncate">{t.orgName ?? ''}</span>
              <span className="ml-auto shrink-0 flex items-center gap-2">
                <SlaChip ticket={t} />
                <span title={new Date(t.updatedAt).toLocaleString()}>{timeAgo(t.updatedAt)}</span>
              </span>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 3: Type-check, commit**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git add apps/web/src/components/tickets/
git commit -m "feat(tickets-ui): SLA chip and queue list"
```

---

### Task 4: Composer (internal-note safety) — TDD

**Files:**
- Create: `apps/web/src/components/tickets/TicketComposer.tsx`
- Create: `apps/web/src/components/tickets/TicketComposer.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TicketComposer from './TicketComposer';

describe('TicketComposer', () => {
  const onSend = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => onSend.mockClear());

  it('defaults to public reply mode', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Send reply');
    expect(screen.queryByTestId('ticket-composer-internal-banner')).toBeNull();
    expect(screen.getByTestId('ticket-composer-input')).toHaveAttribute('placeholder', 'Reply to Pat…');
  });

  it('internal mode shows the banner, changes the send label and placeholder', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    expect(screen.getByTestId('ticket-composer-internal-banner')).toHaveTextContent('Internal');
    expect(screen.getByTestId('ticket-composer-send')).toHaveTextContent('Add internal note');
    expect(screen.getByTestId('ticket-composer-input')).toHaveAttribute('placeholder', 'Add an internal note…');
  });

  it('sends with isPublic matching the active mode', async () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    fireEvent.change(screen.getByTestId('ticket-composer-input'), { target: { value: 'note body' } });
    fireEvent.click(screen.getByTestId('ticket-composer-send'));
    expect(onSend).toHaveBeenCalledWith('note body', false);
  });

  it('disables send on empty content', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    expect(screen.getByTestId('ticket-composer-send')).toBeDisabled();
  });

  it('Cmd+Enter sends', () => {
    render(<TicketComposer requesterName="Pat" onSend={onSend} />);
    const input = screen.getByTestId('ticket-composer-input');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(onSend).toHaveBeenCalledWith('hi', true);
  });
});
```

(If `@testing-library/react` is not present, check `grep -rn "@testing-library/react" apps/web/package.json` — it is the standard for existing component tests; if a different util is used, follow that one.)

- [ ] **Step 2: Run to verify failure, then implement**

```tsx
import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  requesterName: string | null;
  onSend: (content: string, isPublic: boolean) => Promise<void>;
  disabled?: boolean;
}

export default function TicketComposer({ requesterName, onSend, disabled }: Props) {
  const [mode, setMode] = useState<'reply' | 'internal'>('reply'); // public reply default (UI brief)
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const isPublic = mode === 'reply';

  const send = useCallback(async () => {
    if (!content.trim() || sending) return;
    setSending(true);
    try {
      await onSend(content.trim(), isPublic);
      setContent('');
    } finally {
      setSending(false);
    }
  }, [content, isPublic, onSend, sending]);

  return (
    <div
      className={cn(
        'border-t',
        !isPublic && 'bg-warning/10 dark:bg-warning/15' // unmistakable internal wash
      )}
      data-testid="ticket-composer"
    >
      <div className="flex items-center gap-1 px-3 pt-2">
        <button
          type="button"
          onClick={() => setMode('reply')}
          aria-selected={isPublic}
          data-testid="ticket-composer-tab-reply"
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium', isPublic ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          Reply
        </button>
        <button
          type="button"
          onClick={() => setMode('internal')}
          aria-selected={!isPublic}
          data-testid="ticket-composer-tab-internal"
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium', !isPublic ? 'bg-warning/20 text-warning' : 'text-muted-foreground hover:text-foreground')}
        >
          Internal note
        </button>
        {!isPublic && (
          <span className="ml-2 text-xs font-medium text-warning" data-testid="ticket-composer-internal-banner">
            Internal: not visible to requester
          </span>
        )}
      </div>
      <div className="p-3">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={isPublic ? `Reply to ${requesterName ?? 'requester'}…` : 'Add an internal note…'}
          rows={3}
          disabled={disabled || sending}
          data-testid="ticket-composer-input"
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void send()}
            disabled={!content.trim() || sending || disabled}
            data-testid="ticket-composer-send"
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              isPublic ? 'bg-primary hover:bg-primary/90' : 'bg-warning hover:bg-warning/90 text-warning-foreground'
            )}
          >
            {sending ? 'Sending' : isPublic ? 'Send reply' : 'Add internal note'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Run tests, commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/TicketComposer.test.tsx`
Expected: PASS (5 tests).

```bash
git add apps/web/src/components/tickets/TicketComposer*
git commit -m "feat(tickets-ui): composer with public-default + unmistakable internal-note mode"
```

---

### Task 5: Activity feed

**Files:**
- Create: `apps/web/src/components/tickets/TicketFeed.tsx`

- [ ] **Step 1: Implement**

System events (status_change/assignment/system) render as compact one-liners; runs of 3+ consecutive system events collapse behind a "show" toggle. Human comments render as bubbles; internal notes get the amber wash.

```tsx
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { statusConfig, type TicketComment, type TicketStatus } from './ticketConfig';

const SYSTEM_TYPES = new Set(['status_change', 'assignment', 'system', 'time_entry']);

function systemLine(c: TicketComment): string {
  if (c.commentType === 'status_change') {
    const from = statusConfig[c.oldValue as TicketStatus]?.label ?? c.oldValue;
    const to = statusConfig[c.newValue as TicketStatus]?.label ?? c.newValue;
    return `${c.authorName ?? 'System'} changed status: ${from} to ${to}`;
  }
  if (c.commentType === 'assignment') {
    return c.newValue ? `${c.authorName ?? 'System'} assigned this ticket` : `${c.authorName ?? 'System'} unassigned this ticket`;
  }
  return c.content || 'System event';
}

type FeedBlock = { kind: 'comment'; item: TicketComment } | { kind: 'system-run'; items: TicketComment[] };

function groupFeed(comments: TicketComment[]): FeedBlock[] {
  const blocks: FeedBlock[] = [];
  for (const c of comments) {
    if (SYSTEM_TYPES.has(c.commentType)) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'system-run') last.items.push(c);
      else blocks.push({ kind: 'system-run', items: [c] });
    } else {
      blocks.push({ kind: 'comment', item: c });
    }
  }
  return blocks;
}

function SystemRun({ items }: { items: TicketComment[] }) {
  const [open, setOpen] = useState(items.length < 3);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="px-1 text-xs text-muted-foreground hover:text-foreground"
        data-testid="ticket-feed-system-collapsed"
      >
        {items.length} changes. Show
      </button>
    );
  }
  return (
    <div className="space-y-1">
      {items.map((c) => (
        <div key={c.id} className="flex items-baseline gap-2 px-1 text-xs text-muted-foreground">
          <span>{systemLine(c)}</span>
          <span title={new Date(c.createdAt).toLocaleString()}>{new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      ))}
    </div>
  );
}

export default function TicketFeed({ comments }: { comments: TicketComment[] }) {
  const blocks = useMemo(() => groupFeed(comments), [comments]);

  if (comments.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="ticket-feed-empty">No activity yet.</p>;
  }

  return (
    <div className="space-y-3 p-4" data-testid="ticket-feed">
      {blocks.map((b, i) =>
        b.kind === 'system-run' ? (
          <SystemRun key={`run-${i}`} items={b.items} />
        ) : (
          <div
            key={b.item.id}
            className={cn(
              'rounded-lg border p-3',
              !b.item.isPublic && 'border-warning/30 bg-warning/10'
            )}
            data-testid={`ticket-comment-${b.item.id}`}
          >
            <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{b.item.authorName ?? (b.item.portalUserId ? 'Requester' : 'Technician')}</span>
              {!b.item.isPublic && <span className="font-medium text-warning">Internal</span>}
              <span className="ml-auto" title={new Date(b.item.createdAt).toLocaleString()}>
                {new Date(b.item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <p className="whitespace-pre-wrap text-sm">{b.item.content}</p>
          </div>
        )
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check, commit**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git add apps/web/src/components/tickets/TicketFeed.tsx
git commit -m "feat(tickets-ui): activity feed with collapsed system-event runs"
```

---

### Task 6: Workbench (header + rail + status/assign + resolve flow)

**Files:**
- Create: `apps/web/src/components/tickets/TicketWorkbench.tsx`

- [ ] **Step 1: Implement**

Props-driven so it serves both the split-pane and the full page. Inline mutations via `runAction`; resolve expands an inline note form (no modal). Composer focus is exposed via refs for the keyboard hook.

```tsx
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
}

const STATUS_OPTIONS: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'];
const PRIORITY_OPTIONS: TicketPriority[] = ['urgent', 'high', 'normal', 'low'];

export default function TicketWorkbench({ ticketId, onChanged, expanded }: Props) {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const [railOpen, setRailOpen] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetchWithAuth(`/tickets/${ticketId}`);
      if (!res.ok) throw new Error('Ticket failed to load.');
      const body = await res.json();
      setTicket(body.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Ticket failed to load.');
    } finally {
      setLoading(false);
    }
  }, [ticketId]);

  useEffect(() => { void load(); }, [load]);

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
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify({ content, isPublic }) }),
        errorFallback: 'Reply failed. Retry.',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await load();
      onChanged?.();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      throw err; // composer keeps the draft on failure
    }
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
        <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Retry</button>
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
              }).then(() => { void load(); onChanged?.(); }).catch(() => undefined);
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
```

(`railOpen` toggle button can be added in the header later; the rail hides below `lg` per the brief's breakpoint behavior. The assign-to-me action comes from the page level / keyboard hook via the `/assign` endpoint.)

- [ ] **Step 2: Type-check, commit**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git add apps/web/src/components/tickets/TicketWorkbench.tsx
git commit -m "feat(tickets-ui): ticket workbench — header, inline status/resolve, feed, rail"
```

---

### Task 7: Keyboard triage hook — TDD

**Files:**
- Create: `apps/web/src/components/tickets/useQueueKeyboard.ts`
- Create: `apps/web/src/components/tickets/useQueueKeyboard.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useQueueKeyboard } from './useQueueKeyboard';

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

describe('useQueueKeyboard', () => {
  const handlers = {
    onMove: vi.fn(),
    onOpen: vi.fn(),
    onAssignMe: vi.fn(),
    onFocusReply: vi.fn(),
    onFocusInternal: vi.fn(),
    onResolve: vi.fn(),
    onEscape: vi.fn()
  };

  beforeEach(() => Object.values(handlers).forEach((h) => h.mockClear()));
  afterEach(() => { document.body.innerHTML = ''; });

  it('j/k move selection', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('j');
    expect(handlers.onMove).toHaveBeenCalledWith(1);
    press('k');
    expect(handlers.onMove).toHaveBeenCalledWith(-1);
  });

  it('maps a/r/n/e/Escape/Enter', () => {
    renderHook(() => useQueueKeyboard(handlers));
    press('a'); expect(handlers.onAssignMe).toHaveBeenCalled();
    press('r'); expect(handlers.onFocusReply).toHaveBeenCalled();
    press('n'); expect(handlers.onFocusInternal).toHaveBeenCalled();
    press('e'); expect(handlers.onResolve).toHaveBeenCalled();
    press('Escape'); expect(handlers.onEscape).toHaveBeenCalled();
    press('Enter'); expect(handlers.onOpen).toHaveBeenCalled();
  });

  it('is suspended while an input is focused', () => {
    renderHook(() => useQueueKeyboard(handlers));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('ignores modified keys (Cmd+R etc.)', () => {
    renderHook(() => useQueueKeyboard(handlers));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true }));
    expect(handlers.onFocusReply).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

```typescript
import { useEffect } from 'react';

export interface QueueKeyboardHandlers {
  onMove: (delta: 1 | -1) => void;
  onOpen: () => void;
  onAssignMe: () => void;
  onFocusReply: () => void;
  onFocusInternal: () => void;
  onResolve: () => void;
  onEscape: () => void;
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (EDITABLE.has(el.tagName) || el.isContentEditable);
}

export function useQueueKeyboard(h: QueueKeyboardHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') { h.onEscape(); return; } // Escape works even from inputs (blur + back)
      if (isEditing()) return;
      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); h.onMove(1); break;
        case 'k': case 'ArrowUp': e.preventDefault(); h.onMove(-1); break;
        case 'Enter': case 'o': e.preventDefault(); h.onOpen(); break;
        case 'a': e.preventDefault(); h.onAssignMe(); break;
        case 'r': e.preventDefault(); h.onFocusReply(); break;
        case 'n': e.preventDefault(); h.onFocusInternal(); break;
        case 'e': e.preventDefault(); h.onResolve(); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [h]);
}
```

Note: the Escape-from-input test above expects Escape to fire even while editing; the third test presses `j` (not Escape) from a textarea. Both behaviors are intentional: Escape always works, letters only outside inputs.

- [ ] **Step 3: Run tests, commit**

Run: `cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/useQueueKeyboard.test.ts`
Expected: PASS (4 tests).

```bash
git add apps/web/src/components/tickets/useQueueKeyboard*
git commit -m "feat(tickets-ui): keyboard triage hook (j/k, a, r, n, e, Esc)"
```

---

### Task 8: TicketsPage — split-pane assembly

**Files:**
- Create: `apps/web/src/components/tickets/TicketsPage.tsx`
- Create: `apps/web/src/pages/tickets/index.astro`
- Create: `apps/web/src/pages/tickets/[id].astro`

- [ ] **Step 1: Implement `TicketsPage.tsx`**

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import TicketQueueList from './TicketQueueList';
import TicketWorkbench from './TicketWorkbench';
import { useQueueKeyboard } from './useQueueKeyboard';
import type { TicketSummary } from './ticketConfig';

type Tab = 'mine' | 'unassigned' | 'open' | 'breaching' | 'closed';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'mine', label: 'My tickets' },
  { id: 'unassigned', label: 'Unassigned' },
  { id: 'open', label: 'All open' },
  { id: 'breaching', label: 'Breaching soon' },
  { id: 'closed', label: 'Closed' }
];

function tabQuery(tab: Tab): string {
  switch (tab) {
    case 'mine': return 'statusGroup=open&assignee=me';
    case 'unassigned': return 'statusGroup=open&assignee=unassigned';
    case 'open': return 'statusGroup=open';
    case 'breaching': return 'statusGroup=open'; // client-filters to at-risk/breached below
    case 'closed': return 'statusGroup=closed&sort=newest';
  }
}

function selectionFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  return window.location.hash.replace('#', '') || null;
}

export default function TicketsPage() {
  const [tab, setTab] = useState<Tab>('open');
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [stats, setStats] = useState<{ open: number; unassigned: number; mine: number; breached: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedNumber, setSelectedNumber] = useState<string | null>(selectionFromHash);
  const [search, setSearch] = useState('');

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams(tabQuery(tab));
      if (search) params.set('search', search);
      params.set('limit', '100');
      const res = await fetchWithAuth(`/tickets?${params.toString()}`);
      if (!res.ok) {
        if (res.status === 401) { void navigateTo('/login', { replace: true }); return; }
        throw new Error('Tickets failed to load.');
      }
      const body = await res.json();
      setTickets(body.data ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Tickets failed to load.');
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  const fetchStats = useCallback(async () => {
    const res = await fetchWithAuth('/tickets/stats');
    if (res.ok) {
      const body = await res.json();
      setStats(body.data ?? null);
    }
  }, []);

  useEffect(() => { void fetchTickets(); void fetchStats(); }, [fetchTickets, fetchStats]);

  useEffect(() => {
    const onHash = () => setSelectedNumber(selectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const visible = useMemo(() => {
    if (tab !== 'breaching') return tickets;
    return tickets.filter((t) => t.slaBreachedAt !== null);
  }, [tickets, tab]);

  const selected = useMemo(
    () => visible.find((t) => t.internalNumber === selectedNumber || t.id === selectedNumber) ?? null,
    [visible, selectedNumber]
  );

  // Auto-select first row when nothing valid is selected (UI brief: no-selection state auto-selects)
  useEffect(() => {
    if (!loading && visible.length > 0 && !selected) {
      const first = visible[0];
      window.location.hash = first.internalNumber ?? first.id;
      setSelectedNumber(first.internalNumber ?? first.id);
    }
  }, [loading, visible, selected]);

  const select = useCallback((t: TicketSummary) => {
    const key = t.internalNumber ?? t.id;
    window.location.hash = key;
    setSelectedNumber(key);
  }, []);

  const move = useCallback((delta: 1 | -1) => {
    if (visible.length === 0) return;
    const idx = selected ? visible.findIndex((t) => t.id === selected.id) : -1;
    const next = visible[Math.min(visible.length - 1, Math.max(0, idx + delta))];
    if (next) select(next);
  }, [visible, selected, select]);

  const assignMe = useCallback(async () => {
    if (!selected) return;
    try {
      const meRes = await fetchWithAuth('/users/me');
      if (!meRes.ok) return;
      const me = await meRes.json();
      await runAction({
        request: () => fetchWithAuth(`/tickets/${selected.id}/assign`, { method: 'POST', body: JSON.stringify({ assigneeId: me.id ?? me.data?.id }) }),
        errorFallback: 'Assign failed. Retry.',
        successMessage: 'Assigned to you',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      void fetchTickets();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [selected, fetchTickets]);

  const focusComposer = useCallback((internal: boolean) => {
    const tabBtn = document.querySelector<HTMLButtonElement>(
      internal ? '[data-testid="ticket-composer-tab-internal"]' : '[data-testid="ticket-composer-tab-reply"]'
    );
    tabBtn?.click();
    document.querySelector<HTMLTextAreaElement>('[data-testid="ticket-composer-input"]')?.focus();
  }, []);

  useQueueKeyboard({
    onMove: move,
    onOpen: () => { if (selected) void navigateTo(`/tickets/${selected.id}`); },
    onAssignMe: () => void assignMe(),
    onFocusReply: () => focusComposer(false),
    onFocusInternal: () => focusComposer(true),
    onResolve: () => {
      const statusSel = document.querySelector<HTMLSelectElement>('[data-testid="ticket-workbench-status"]');
      if (statusSel) { statusSel.value = 'resolved'; statusSel.dispatchEvent(new Event('change', { bubbles: true })); }
    },
    onEscape: () => (document.activeElement as HTMLElement | null)?.blur()
  });

  const tabCount = (id: Tab): number | null => {
    if (!stats) return null;
    if (id === 'mine') return stats.mine;
    if (id === 'unassigned') return stats.unassigned;
    if (id === 'open') return stats.open;
    if (id === 'breaching') return stats.breached;
    return null;
  };

  const trueEmpty = !loading && tickets.length === 0 && tab === 'open' && !search;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="tickets-page">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-semibold" data-testid="tickets-heading">Tickets</h1>
        <a
          href="/tickets/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90"
          data-testid="tickets-create-button"
        >
          <Plus className="h-4 w-4" /> Create ticket
        </a>
      </div>

      <div className="mb-3 flex items-center gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`tickets-tab-${t.id}`}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium -mb-px',
              tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
            {tabCount(t.id) !== null && <span className="ml-1.5 text-xs text-muted-foreground">{tabCount(t.id)}</span>}
          </button>
        ))}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tickets"
          data-testid="tickets-search-input"
          className="ml-auto mb-1 w-56 rounded-md border bg-background px-2.5 py-1.5 text-sm"
        />
      </div>

      {trueEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center text-center" data-testid="tickets-empty">
          <h2 className="text-base font-medium">No tickets yet</h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            Tickets arrive from the customer portal, from alert rules, and from technicians. Create the first one, or wire an alert rule to open tickets automatically.
          </p>
          <div className="mt-3 flex gap-2">
            <a href="/tickets/new" className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90">Create ticket</a>
            <a href="/settings/ticketing" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Ticketing settings</a>
          </div>
        </div>
      ) : error ? (
        <div className="flex flex-1 items-center justify-center" data-testid="tickets-error">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">{error}</p>
            <button type="button" onClick={() => void fetchTickets()} className="mt-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Retry</button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border">
          <div className="w-2/5 min-w-[320px] max-w-[480px] overflow-y-auto border-r">
            <TicketQueueList tickets={visible} selectedId={selected?.id ?? null} onSelect={select} loading={loading} />
          </div>
          <div className="min-w-0 flex-1">
            {selected ? (
              <TicketWorkbench ticketId={selected.id} onChanged={() => { void fetchTickets(); void fetchStats(); }} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground" data-testid="tickets-no-selection">
                <p>Select a ticket. Use j/k to move, Enter to expand.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

Responsive note (brief §4): below ~1100px the split-pane collapses; simplest compliant Phase 1 behavior is hiding the workbench pane (`hidden min-[1100px]:block` on the right pane wrapper) and making row clicks navigate to `/tickets/[id]` when `window.innerWidth < 1100` — add that conditional in `select()`.

- [ ] **Step 2: Create the Astro pages**

`apps/web/src/pages/tickets/index.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import TicketsPage from '../../components/tickets/TicketsPage';
---

<DashboardLayout title="Tickets">
  <TicketsPage client:load />
</DashboardLayout>
```

`apps/web/src/pages/tickets/[id].astro` (full-page expand; client island reads the id):

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import TicketWorkbench from '../../components/tickets/TicketWorkbench';

const { id } = Astro.params;
---

<DashboardLayout title="Ticket">
  <div class="mb-3">
    <a href="/tickets" class="text-sm text-muted-foreground hover:text-foreground" data-testid="ticket-back-link">← Back to queue</a>
  </div>
  <div class="h-[calc(100vh-10rem)] rounded-lg border">
    <TicketWorkbench ticketId={id!} expanded client:load />
  </div>
</DashboardLayout>
```

(Check whether `[id].astro` dynamic routes need `export const prerender = false` in this app: `grep -rn "prerender" apps/web/src/pages --include="*.astro" | head -3` and copy the convention.)

- [ ] **Step 3: Type-check, run the dev server, eyeball both pages, commit**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git add apps/web/src/components/tickets/TicketsPage.tsx apps/web/src/pages/tickets/
git commit -m "feat(tickets-ui): split-pane tickets page with tabs, hash selection, keyboard triage"
```

---

### Task 9: Create-ticket page

**Files:**
- Create: `apps/web/src/components/tickets/CreateTicketPage.tsx`
- Create: `apps/web/src/pages/tickets/new.astro`

- [ ] **Step 1: Implement the form component**

Full-page form (no modal, per brief). Fields: org (required select, from `/organizations`), subject, description, device (optional select filtered by org, from `/devices?orgId=`), category (from `/ticket-categories`), priority. Submits via `runAction` then navigates to `/tickets#<internalNumber>`.

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import type { TicketPriority } from './ticketConfig';

interface Option { id: string; name: string }

export default function CreateTicketPage() {
  const [orgs, setOrgs] = useState<Option[]>([]);
  const [devices, setDevices] = useState<Option[]>([]);
  const [categories, setCategories] = useState<Option[]>([]);
  const [orgId, setOrgId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const [orgRes, catRes] = await Promise.all([fetchWithAuth('/organizations'), fetchWithAuth('/ticket-categories')]);
      if (orgRes.ok) {
        const b = await orgRes.json();
        setOrgs((b.data ?? b.organizations ?? []).map((o: { id: string; name: string }) => ({ id: o.id, name: o.name })));
      }
      if (catRes.ok) {
        const b = await catRes.json();
        setCategories((b.data ?? []).filter((c: { isActive: boolean }) => c.isActive).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
      }
    })();
  }, []);

  useEffect(() => {
    if (!orgId) { setDevices([]); setDeviceId(''); return; }
    void (async () => {
      const res = await fetchWithAuth(`/devices?orgId=${orgId}`);
      if (res.ok) {
        const b = await res.json();
        setDevices((b.data ?? b.devices ?? []).map((d: { id: string; displayName?: string; hostname?: string }) => ({
          id: d.id, name: d.displayName ?? d.hostname ?? d.id
        })));
      }
    })();
  }, [orgId]);

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || !subject.trim()) return;
    setSaving(true);
    try {
      const created = await runAction<{ data: { id: string; internalNumber: string | null } }>({
        request: () => fetchWithAuth('/tickets', {
          method: 'POST',
          body: JSON.stringify({
            orgId,
            subject: subject.trim(),
            description: description.trim() || undefined,
            deviceId: deviceId || undefined,
            categoryId: categoryId || undefined,
            priority
          })
        }),
        errorFallback: 'Ticket creation failed. Retry.',
        successMessage: (r) => `Ticket ${r.data.internalNumber ?? ''} created`,
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      void navigateTo(`/tickets#${created.data.internalNumber ?? created.data.id}`);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setSaving(false);
    }
  }, [orgId, subject, description, deviceId, categoryId, priority]);

  const selectCls = 'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm';

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4" data-testid="create-ticket-form">
      <h1 className="text-xl font-semibold" data-testid="create-ticket-heading">Create ticket</h1>
      <div>
        <label className="text-sm font-medium" htmlFor="ct-org">Organization</label>
        <select id="ct-org" value={orgId} onChange={(e) => setOrgId(e.target.value)} required className={selectCls} data-testid="create-ticket-org-input">
          <option value="">Select organization</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="ct-subject">Subject</label>
        <input id="ct-subject" value={subject} onChange={(e) => setSubject(e.target.value)} required maxLength={255} className={selectCls} data-testid="create-ticket-subject-input" />
      </div>
      <div>
        <label className="text-sm font-medium" htmlFor="ct-desc">Description</label>
        <textarea id="ct-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={5} className={selectCls} data-testid="create-ticket-description-input" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="text-sm font-medium" htmlFor="ct-device">Device (optional)</label>
          <select id="ct-device" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={!orgId} className={selectCls} data-testid="create-ticket-device-input">
            <option value="">None</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ct-cat">Category</label>
          <select id="ct-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectCls} data-testid="create-ticket-category-input">
            <option value="">None</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="ct-pri">Priority</label>
          <select id="ct-pri" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)} className={selectCls} data-testid="create-ticket-priority-input">
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <a href="/tickets" className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Cancel</a>
        <button type="submit" disabled={saving || !orgId || !subject.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" data-testid="create-ticket-submit">
          {saving ? 'Creating' : 'Create ticket'}
        </button>
      </div>
    </form>
  );
}
```

`apps/web/src/pages/tickets/new.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import CreateTicketPage from '../../components/tickets/CreateTicketPage';
---

<DashboardLayout title="Create Ticket">
  <CreateTicketPage client:load />
</DashboardLayout>
```

- [ ] **Step 2: Type-check, commit**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git add apps/web/src/components/tickets/CreateTicketPage.tsx apps/web/src/pages/tickets/new.astro
git commit -m "feat(tickets-ui): create-ticket page"
```

---

### Task 10: Navigation, accent, categories settings

**Files:**
- Modify: `apps/web/src/components/layout/Sidebar.tsx`
- Modify: `apps/web/src/layouts/DashboardLayout.astro`
- Create: `apps/web/src/components/settings/TicketCategoriesPage.tsx`
- Create: `apps/web/src/pages/settings/ticketing.astro`

- [ ] **Step 1: Sidebar + accent**

In `topLevelNav` after Alerts (import `Ticket` from lucide-react):

```typescript
  { name: 'Tickets', href: '/tickets', icon: Ticket },
```

In `DashboardLayout.astro`'s `getAccentClass`, add `/tickets` to an existing line or its own (before the settings line):

```typescript
  if (path.startsWith('/tickets')) return 'bg-primary/70';
```

- [ ] **Step 2: Categories settings page**

`TicketCategoriesPage.tsx` — table of categories with inline create row and activate/deactivate, all via `runAction`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';

interface Category {
  id: string; name: string; color: string; defaultPriority: string | null;
  responseSlaMinutes: number | null; resolutionSlaMinutes: number | null; isActive: boolean;
}

export default function TicketCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#1c8a9e');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetchWithAuth('/ticket-categories');
    if (res.ok) setCategories((await res.json()).data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = useCallback(async () => {
    if (!name.trim()) return;
    try {
      await runAction({
        request: () => fetchWithAuth('/ticket-categories', { method: 'POST', body: JSON.stringify({ name: name.trim(), color }) }),
        errorFallback: 'Category creation failed. Retry.',
        successMessage: `Category "${name.trim()}" created`,
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      setName('');
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [name, color, load]);

  const toggleActive = useCallback(async (cat: Category) => {
    try {
      await runAction({
        request: () => fetchWithAuth(`/ticket-categories/${cat.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !cat.isActive }) }),
        errorFallback: 'Update failed. Retry.',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      void load();
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
    }
  }, [load]);

  return (
    <div className="max-w-3xl" data-testid="ticket-categories-page">
      <h1 className="text-xl font-semibold" data-testid="ticket-categories-heading">Ticketing</h1>
      <p className="mt-1 text-sm text-muted-foreground">Categories organize the queue and carry SLA and billing defaults (SLA enforcement arrives with the SLA engine).</p>

      <div className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <label className="text-sm font-medium" htmlFor="cat-name">New category</label>
          <input id="cat-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="ticket-categories-name-input" />
        </div>
        <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded-md border" aria-label="Category color" data-testid="ticket-categories-color-input" />
        <button type="button" onClick={() => void create()} disabled={!name.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" data-testid="ticket-categories-create-button">Add</button>
      </div>

      <table className="mt-4 min-w-full divide-y" data-testid="ticket-categories-table">
        <thead className="bg-muted/40">
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2">Name</th><th className="px-4 py-2">Color</th><th className="px-4 py-2">Status</th><th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading ? (
            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground">Loading.</td></tr>
          ) : categories.length === 0 ? (
            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-muted-foreground" data-testid="ticket-categories-empty">No categories yet. Add the first one above.</td></tr>
          ) : categories.map((c) => (
            <tr key={c.id} data-testid={`ticket-category-row-${c.id}`}>
              <td className="px-4 py-2 text-sm">{c.name}</td>
              <td className="px-4 py-2"><span className="inline-block h-4 w-4 rounded" style={{ backgroundColor: c.color }} /></td>
              <td className="px-4 py-2 text-sm">{c.isActive ? 'Active' : 'Inactive'}</td>
              <td className="px-4 py-2 text-right">
                <button type="button" onClick={() => void toggleActive(c)} className="text-sm text-muted-foreground hover:text-foreground" data-testid={`ticket-category-toggle-${c.id}`}>
                  {c.isActive ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

`apps/web/src/pages/settings/ticketing.astro`:

```astro
---
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import TicketCategoriesPage from '../../components/settings/TicketCategoriesPage';
---

<DashboardLayout title="Ticketing Settings">
  <TicketCategoriesPage client:load />
</DashboardLayout>
```

Also register the settings page in whatever settings index/nav lists settings sections (check `ls apps/web/src/pages/settings/` and the settings landing component for the registration pattern; add a "Ticketing" entry mirroring its neighbors).

- [ ] **Step 3: Type-check, commit**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git add apps/web/src/components/layout/Sidebar.tsx apps/web/src/layouts/DashboardLayout.astro apps/web/src/components/settings/TicketCategoriesPage.tsx apps/web/src/pages/settings/ticketing.astro
git commit -m "feat(tickets-ui): nav entry, accent, ticketing settings (categories)"
```

---

### Task 11: Alert → ticket and device tab integration

**Files:**
- Modify: `apps/web/src/components/alerts/AlertDetails.tsx`
- Modify: `apps/web/src/components/devices/DeviceDetails.tsx`
- Create: `apps/web/src/components/tickets/DeviceTicketsTab.tsx`

- [ ] **Step 1: Create Ticket button in AlertDetails**

Read `AlertDetails.tsx` to find its action-button row (acknowledge/resolve buttons). Add beside them:

```tsx
<button
  type="button"
  onClick={() => {
    void runAction<{ data: { id: string; internalNumber: string | null } }>({
      request: () => fetchWithAuth(`/alerts/${alert.id}/create-ticket`, { method: 'POST', body: JSON.stringify({}) }),
      errorFallback: 'Ticket creation failed. Retry.',
      successMessage: (r) => `Ticket ${r.data.internalNumber ?? ''} created`,
      onUnauthorized: () => void navigateTo('/login', { replace: true })
    }).then((r) => void navigateTo(`/tickets#${r.data.internalNumber ?? r.data.id}`)).catch(() => undefined);
  }}
  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
  data-testid="alert-create-ticket-button"
>
  Create ticket
</button>
```

(Match the file's existing button classes; import `runAction`/`ActionError` if not present.)

- [ ] **Step 2: Device Tickets tab**

`DeviceTicketsTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import SlaChip from './SlaChip';
import { statusConfig, priorityConfig, type TicketSummary } from './ticketConfig';
import { cn } from '@/lib/utils';

export default function DeviceTicketsTab({ deviceId }: { deviceId: string }) {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const res = await fetchWithAuth(`/tickets?limit=50&sort=newest`);
      if (res.ok) {
        const body = await res.json();
        setTickets(((body.data ?? []) as TicketSummary[]).filter((t) => t.deviceId === deviceId));
      }
      setLoading(false);
    })();
  }, [deviceId]);

  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading.</p>;
  if (tickets.length === 0) return <p className="p-4 text-sm text-muted-foreground" data-testid="device-tickets-empty">No tickets for this device.</p>;

  return (
    <ul className="divide-y" data-testid="device-tickets-list">
      {tickets.map((t) => (
        <li key={t.id}>
          <a href={`/tickets/${t.id}`} className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-muted/50" data-testid={`device-ticket-row-${t.id}`}>
            <span className="font-mono text-xs text-muted-foreground">{t.internalNumber}</span>
            <span className="truncate font-medium">{t.subject}</span>
            <span className={cn('ml-auto inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium', statusConfig[t.status].color)}>{statusConfig[t.status].label}</span>
            <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium', priorityConfig[t.priority].color)}>{priorityConfig[t.priority].label}</span>
            <SlaChip ticket={t} />
          </a>
        </li>
      ))}
    </ul>
  );
}
```

Performance note: this filters client-side from the latest 50; if the queue API later grows a `deviceId` filter param (one-line addition to `listTicketsQuerySchema` + route condition — preferred), switch to `/tickets?deviceId=${deviceId}`. Add that param to the Phase 1a API if it merged without it: it is strictly additive.

In `DeviceDetails.tsx`: add `'tickets'` to `VALID_TABS`, a tab strip entry labeled "Tickets", and render `<DeviceTicketsTab deviceId={device.id} />` when active — mirroring how the existing tabs register and render.

- [ ] **Step 3: Type-check, commit**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx tsc --noEmit
git add apps/web/src/components/alerts/AlertDetails.tsx apps/web/src/components/devices/DeviceDetails.tsx apps/web/src/components/tickets/DeviceTicketsTab.tsx
git commit -m "feat(tickets-ui): create-ticket from alert + device tickets tab"
```

---

### Task 12: E2E spec + page object

**Files:**
- Create: `e2e-tests/pages/TicketsPage.ts`
- Create: `e2e-tests/tests/tickets.spec.ts`

- [ ] **Step 1: Page object**

```typescript
import type { Page } from '@playwright/test';

export class TicketsPage {
  url = '/tickets';

  constructor(private page: Page) {}

  heading = () => this.page.getByTestId('tickets-heading');
  queue = () => this.page.getByTestId('tickets-queue');
  empty = () => this.page.getByTestId('tickets-empty');
  createButton = () => this.page.getByTestId('tickets-create-button');
  tab = (id: string) => this.page.getByTestId(`tickets-tab-${id}`);
  row = (id: string) => this.page.getByTestId(`ticket-row-${id}`);
  workbench = () => this.page.getByTestId('ticket-workbench');
  workbenchNumber = () => this.page.getByTestId('ticket-workbench-number');
  statusSelect = () => this.page.getByTestId('ticket-workbench-status');
  resolveNote = () => this.page.getByTestId('ticket-workbench-resolve-note');
  resolveSubmit = () => this.page.getByTestId('ticket-workbench-resolve-submit');
  composerInput = () => this.page.getByTestId('ticket-composer-input');
  composerInternalTab = () => this.page.getByTestId('ticket-composer-tab-internal');
  composerInternalBanner = () => this.page.getByTestId('ticket-composer-internal-banner');
  composerSend = () => this.page.getByTestId('ticket-composer-send');

  // Create form
  formOrg = () => this.page.getByTestId('create-ticket-org-input');
  formSubject = () => this.page.getByTestId('create-ticket-subject-input');
  formSubmit = () => this.page.getByTestId('create-ticket-submit');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }
}
```

- [ ] **Step 2: Spec — create → comment → resolve happy path**

```typescript
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { AuthPage } from '../pages/AuthPage';
import { TicketsPage } from '../pages/TicketsPage';

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('tickets', () => {
  test('create, reply, internal note, resolve', async ({ cleanPage }) => {
    const auth = new AuthPage(cleanPage);
    await auth.goto('/tickets');
    await auth.signIn(process.env.E2E_ADMIN_EMAIL!, process.env.E2E_ADMIN_PASSWORD!, /\/tickets(\?|$|#)/);

    const tickets = new TicketsPage(cleanPage);
    await tickets.heading().waitFor();

    // Create
    await tickets.createButton().click();
    await tickets.formSubject().waitFor();
    await tickets.formOrg().selectOption({ index: 1 });
    await tickets.formSubject().fill('E2E smoke ticket');
    await tickets.formSubmit().click();
    await cleanPage.waitForURL(/\/tickets#/);
    await tickets.workbench().waitFor();
    await expect(tickets.workbenchNumber()).toContainText('T-');

    // Public reply
    await tickets.composerInput().fill('Public reply from e2e');
    await tickets.composerSend().click();
    await expect(cleanPage.getByTestId('ticket-feed')).toContainText('Public reply from e2e');

    // Internal note shows the safety banner
    await tickets.composerInternalTab().click();
    await expect(tickets.composerInternalBanner()).toBeVisible();
    await tickets.composerInput().fill('Internal note from e2e');
    await tickets.composerSend().click();
    await expect(cleanPage.getByTestId('ticket-feed')).toContainText('Internal note from e2e');

    // Resolve requires a note
    await tickets.statusSelect().selectOption('resolved');
    await tickets.resolveNote().waitFor();
    await tickets.resolveNote().fill('Resolved by e2e');
    await tickets.resolveSubmit().click();
    await expect(tickets.statusSelect()).toHaveValue('resolved');
  });
});
```

- [ ] **Step 3: Run locally (env per local Playwright setup memory: `PUBLIC_API_URL=http://localhost`), commit**

```bash
cd e2e-tests && pnpm test -- tests/tickets.spec.ts
git add e2e-tests/pages/TicketsPage.ts e2e-tests/tests/tickets.spec.ts
git commit -m "test(tickets-ui): e2e happy path — create, reply, internal note, resolve"
```

---

### Task 13: Verification + PR

- [ ] **Step 1: Unit tests + type-check**

```bash
cd apps/web && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/components/tickets/ && npx tsc --noEmit
```
Expected: all PASS, no new type errors.

- [ ] **Step 2: Manual sweep against the dev stack**

Walk the UI brief's Key States table: true-empty state (fresh org), filter-empty, loading skeletons, no-selection pane, composer failure (kill the API mid-send: draft must survive), SLA chips (seed a ticket with `sla_breached_at` set via psql), keyboard j/k/a/r/n/e/Esc, dark mode, narrow window (<1100px collapses to full-page navigation).

- [ ] **Step 3: Open PR**

```bash
git push -u origin feat/ticketing-web-ui
gh pr create --title "feat(tickets): technician ticketing UI (Phase 1b)" --body "$(cat <<'EOF'
Split-pane ticket queue + workbench per the UI brief
(docs/superpowers/specs/2026-06-09-native-ticketing-ui-brief.md): tabs, hash selection,
keyboard triage, composer with internal-note safety, inline status/resolve, create flow,
categories settings, alert→ticket button, device tickets tab, e2e coverage.

Depends on #<Phase-1a-PR>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes

- UI brief coverage: split-pane ✓ (T8), tabs/filters ✓ (T8), SLA quiet-until-it-matters ✓ (T2/T3), composer safety ✓ (T4), feed + collapsed system runs ✓ (T5), inline mutations + resolve note ✓ (T6), keyboard core set ✓ (T7), create page ✓ (T9), settings ✓ (T10), empty/loading/error states ✓ (T3/T6/T8), alert/device integration ✓ (T11), e2e ✓ (T12). Deferred per brief: virtualization decision, rail collapse toggle, saved views.
- Investigation points are explicit grep/read steps with stated follow-ups (`cn` path, prerender convention, settings nav registration, testing-library presence, AlertDetails button row).
- Brief's `deviceId` queue filter note (T11) feeds back one additive param to the 1a API; flagged inline.
