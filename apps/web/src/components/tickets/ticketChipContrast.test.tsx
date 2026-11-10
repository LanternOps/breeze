import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import SlaChip from './SlaChip';
import { SlaTimers } from './SlaTimers';
import TicketQueueList from './TicketQueueList';
import TicketComposer from './TicketComposer';
import TicketFeed from './TicketFeed';
import { priorityConfig, statusConfig, type TicketComment, type TicketDetail, type TicketSummary } from './ticketConfig';
import { TICKET_TYPE_CHIP_CLASS } from './ticketType';

/*
 * Ticket workspace text contrast, measured against the real theme tokens
 * (globals.css :root / .dark) and the Tailwind palette (theme.css). Every
 * chip and label here is text-xs, so the bar is WCAG AA 4.5:1. Tints such as
 * `bg-warning/15` are the token at that alpha composited over the surface
 * under them (Tailwind 4 emits color-mix(... N%, transparent)), and the queue
 * rows add their own selected (primary/5) and hover (muted/50) washes.
 */

type Rgb = [number, number, number];
type Theme = 'light' | 'dark';
type Paint = { name: string; alpha: number };

const css = readFileSync(join(import.meta.dirname, '../../styles/globals.css'), 'utf8');
const palette = readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8');

function block(selector: RegExp): string {
  const m = css.match(selector);
  if (!m || m.index === undefined) throw new Error(`block not found: ${selector}`);
  const start = css.indexOf('{', m.index);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(start, i);
  }
  throw new Error('unbalanced');
}

const THEME_BLOCKS: Record<Theme, string> = {
  light: block(/^\s*:root\s*\{\s*$/m),
  dark: block(/^\s*\.dark\s*\{\s*$/m),
};

function hslToRgb(h: number, sPct: number, lPct: number): Rgb {
  const s = sPct / 100;
  const l = lPct / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const a = C * Math.cos((hDeg * Math.PI) / 180);
  const b = C * Math.sin((hDeg * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((v) => {
    const c = Math.min(1, Math.max(0, v));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  }) as Rgb;
}

/** A theme token (`--warning`) or, failing that, a Tailwind palette color (`amber-700`). */
function colorRgb(theme: Theme, name: string): Rgb | null {
  const token = THEME_BLOCKS[theme].match(
    new RegExp(`--${name}:\\s*(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)%\\s+(\\d+(?:\\.\\d+)?)%`)
  );
  if (token) return hslToRgb(Number(token[1]), Number(token[2]), Number(token[3]));
  const swatch = palette.match(new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
  if (swatch) return oklchToRgb(Number(swatch[1]) / 100, Number(swatch[2]), Number(swatch[3]));
  return null;
}

/** The `text-*` / `bg-*` color class that paints in `theme` (`dark:` wins in dark). */
function paintOf(classes: string, kind: 'text' | 'bg', theme: Theme): Paint | null {
  const list = classes.split(/\s+/);
  const pick = (variant: string): Paint | null => {
    for (const c of list) {
      const m = c.match(new RegExp(`^${variant}${kind}-([a-z0-9-]+?)(?:/(\\d+))?$`));
      if (m && colorRgb(theme, m[1])) return { name: m[1], alpha: m[2] ? Number(m[2]) / 100 : 1 };
    }
    return null;
  };
  return (theme === 'dark' ? pick('dark:') : null) ?? pick('');
}

/** `[--muted-foreground:var(--foreground)_/_0.7]` re-points a token inside a surface. */
function overridesOf(classes: string): Record<string, Paint> {
  const out: Record<string, Paint> = {};
  for (const m of classes.matchAll(/\[--([a-z-]+):var\(--([a-z-]+)\)(?:_\/_([\d.]+))?\]/g)) {
    out[m[1]] = { name: m[2], alpha: m[3] ? Number(m[3]) : 1 };
  }
  return out;
}

const mix = (top: Rgb, alpha: number, under: Rgb): Rgb =>
  top.map((v, i) => v * alpha + under[i] * (1 - alpha)) as Rgb;

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function paint(theme: Theme, p: Paint, under: Rgb): Rgb {
  const rgb = colorRgb(theme, p.name);
  if (!rgb) throw new Error(`unknown color ${p.name}`);
  return mix(rgb, p.alpha, under);
}

/** Surfaces a ticket chip or label can sit on, bottom-most first. */
const BASES: Record<string, Paint[]> = {
  page: [{ name: 'background', alpha: 1 }],
  card: [{ name: 'card', alpha: 1 }],
  'selected row': [{ name: 'background', alpha: 1 }, { name: 'primary', alpha: 0.05 }],
  'hovered row': [{ name: 'background', alpha: 1 }, { name: 'muted', alpha: 0.5 }],
};
const QUEUE_BASES = Object.keys(BASES);
const PANE_BASES = ['page', 'card'];

/**
 * Worst contrast of the text in `elementClasses` over each base, under the
 * `surfaces` (outer → inner class strings) and the element's own background.
 */
function worstContrast(theme: Theme, elementClasses: string, surfaces: string[], bases: string[]) {
  const all = [...surfaces, elementClasses];
  const overrides = Object.assign({}, ...surfaces.map(overridesOf)) as Record<string, Paint>;
  let text = paintOf(elementClasses, 'text', theme);
  if (!text) throw new Error(`no text color in "${elementClasses}"`);
  const redirected = overrides[text.name];
  if (redirected) text = { name: redirected.name, alpha: redirected.alpha * text.alpha };
  let worst = { ratio: Infinity, base: '' };
  for (const base of bases) {
    let under: Rgb = [1, 1, 1];
    for (const layer of BASES[base]) under = paint(theme, layer, under);
    for (const cls of all) {
      const bg = paintOf(cls, 'bg', theme);
      if (bg) under = paint(theme, bg, under);
    }
    const r = ratio(paint(theme, text, under), under);
    if (r < worst.ratio) worst = { ratio: r, base };
  }
  return worst;
}

function expectReadable(label: string, elementClasses: string, surfaces: string[], bases: string[]) {
  for (const theme of ['light', 'dark'] as const) {
    const worst = worstContrast(theme, elementClasses, surfaces, bases);
    expect(
      Number(worst.ratio.toFixed(2)),
      `${label} (${theme}, on ${worst.base}): ${worst.ratio.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(4.5);
  }
}

const baseTicket: TicketSummary = {
  id: 'tk-1',
  internalNumber: 'T-1',
  subject: 'Printer',
  status: 'open',
  priority: 'normal',
  source: 'portal',
  orgId: 'org-1',
  orgName: 'Acme',
  deviceId: null,
  deviceHostname: null,
  assignedTo: null,
  assigneeName: null,
  categoryId: null,
  dueDate: null,
  slaBreachedAt: null,
  firstResponseAt: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

describe('ticket queue chips clear 4.5:1 in both themes', () => {
  it.each(Object.entries(statusConfig))('status chip: %s', (status, { color }) => {
    expectReadable(`status ${status}`, color, [], QUEUE_BASES);
  });

  it.each(Object.entries(priorityConfig))('priority chip: %s', (priority, { color }) => {
    expectReadable(`priority ${priority}`, color, [], QUEUE_BASES);
  });

  it.each(Object.entries(TICKET_TYPE_CHIP_CLASS))('type chip: %s', (type, classes) => {
    expectReadable(`type ${type}`, classes, [], QUEUE_BASES);
  });

  it.each([
    ['paused', { slaPausedAt: inMinutes(-10), resolutionDueAt: inMinutes(60) }],
    ['at-risk', { resolutionDueAt: inMinutes(20), resolutionWarnAt: inMinutes(-5) }],
    ['breached', { slaBreachedAt: inMinutes(-30) }],
  ] as const)('SLA chip: %s', (state, overrides) => {
    render(<SlaChip ticket={{ ...baseTicket, ...overrides }} />);
    expectReadable(`SLA ${state}`, screen.getByTestId('ticket-sla-tk-1').className, [], QUEUE_BASES);
  });
});

describe('other queue and pane labels clear 4.5:1 in both themes', () => {
  it('Merged and checklist-complete row chips', () => {
    render(
      <TicketQueueList
        tickets={[{ ...baseTicket, mergedIntoTicketId: 'tk-9', checklist: { done: 3, total: 3 } }]}
        selectedId={null}
        onSelect={vi.fn()}
        loading={false}
      />
    );
    expectReadable('Merged chip', screen.getByTestId('ticket-row-merged-tk-1').className, [], QUEUE_BASES);
    expectReadable('checklist complete chip', screen.getByTestId('ticket-checklist-chip-tk-1').className, [], QUEUE_BASES);
  });

  it('SLA timer "met" state', () => {
    const detail = {
      ...baseTicket, status: 'resolved', firstResponseAt: inMinutes(-30), responseDueAt: inMinutes(-10),
      description: null, submittedBy: null, submitterName: null, submitterEmail: null, pendingReason: null,
      resolutionNote: null, resolvedAt: inMinutes(-5), comments: [], alertLinks: [],
    } as TicketDetail;
    render(<SlaTimers ticket={detail} />);
    const met = screen.getByText('Met');
    expectReadable('SLA met', met.className, [], PANE_BASES);
  });
});

// The fills --warning and --success are 2.2:1 and 3.4–3.7:1 as text on light
// surfaces. Tickets text uses the *-ink tokens (or -foreground on a fill).
describe('tickets components never paint text with a bright fill token', () => {
  it('has no bare text-warning / text-success classes', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(import.meta.dirname)) {
      if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      source.split('\n').forEach((line, i) => {
        if (/(^|[\s'"`:])text-(warning|success)(\/\d+)?(?=[\s'"`]|$)/.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe('internal-note text on the amber wash clears 4.5:1 in both themes', () => {
  const template = { id: 'tpl-1', name: 'Hi', body: 'Hello', category: null, sortOrder: 0, isActive: true };

  it('composer: selected internal mode, banner, idle reply mode, Attach and Canned responses', () => {
    render(
      <TicketComposer
        requesterName="Pat"
        onSend={vi.fn().mockResolvedValue(undefined)}
        onUploadAttachment={vi.fn()}
        templates={[template]}
      />
    );
    fireEvent.click(screen.getByTestId('ticket-composer-tab-internal'));
    const wash = screen.getByTestId('ticket-composer').className;
    expectReadable('internal mode control', screen.getByTestId('ticket-composer-tab-internal').className, [wash], PANE_BASES);
    expectReadable('internal banner', screen.getByTestId('ticket-composer-internal-banner').className, [wash], PANE_BASES);
    expectReadable('reply mode control (idle)', screen.getByTestId('ticket-composer-tab-reply').className, [wash], PANE_BASES);
    expectReadable('Attach', screen.getByTestId('ticket-composer-attach').className, [wash], PANE_BASES);
    expectReadable('Canned responses', screen.getByTestId('canned-picker-button').className, [wash], PANE_BASES);
  });

  it('feed: the Internal label and the meta line of an internal comment', () => {
    const comment: TicketComment = {
      id: 'int-1', userId: 'u-1', portalUserId: null, authorName: 'Sam', authorType: 'user',
      commentType: 'internal', content: 'Note', isPublic: false, oldValue: null, newValue: null,
      createdAt: '2026-06-01T10:00:00.000Z', editedAt: '2026-06-01T11:00:00.000Z',
    };
    render(<TicketFeed comments={[comment]} />);
    const card = screen.getByTestId('ticket-comment-int-1');
    const label = within(card).getByText('Internal');
    const meta = label.parentElement as HTMLElement;
    expectReadable('Internal label', label.className, [card.className, meta.className], PANE_BASES);
    // Date, "edited" and the Edit/Delete actions inherit the meta line's color.
    expectReadable('internal comment meta line', meta.className, [card.className], PANE_BASES);
  });
});
