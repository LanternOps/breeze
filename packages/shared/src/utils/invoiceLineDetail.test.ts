import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INVOICE_LINE_DETAIL,
  formatWorkDate,
  groupLinesByDay,
  invoiceLineText,
  lineWorkDateToShow,
  lineWorkedVsBilled,
  resolveInvoiceLineDetail,
  stampInvoiceLineDetail,
  type InvoiceLineDetail,
} from './invoiceLineDetail';

const ON: InvoiceLineDetail = { grouping: 'entry', showDate: true, showNote: true, showWorkedTime: true };

describe('resolveInvoiceLineDetail', () => {
  const none = { lineGrouping: null, lineShowDate: null, lineShowNote: null, lineShowWorkedTime: null };

  it('defaults reproduce the pre-#8604 document (note + worked time on, no date, per entry)', () => {
    expect(DEFAULT_INVOICE_LINE_DETAIL).toEqual({ grouping: 'entry', showDate: false, showNote: true, showWorkedTime: true });
    expect(resolveInvoiceLineDetail({ status: 'draft', ...none }, null)).toEqual(DEFAULT_INVOICE_LINE_DETAIL);
  });

  it('a draft inherits the partner default when it has no override', () => {
    const partner = { invoiceLineGrouping: 'day', invoiceLineShowDate: true, invoiceLineShowNote: false, invoiceLineShowWorkedTime: false };
    expect(resolveInvoiceLineDetail({ status: 'draft', ...none }, partner))
      .toEqual({ grouping: 'day', showDate: true, showNote: false, showWorkedTime: false });
  });

  it('a draft override wins over the partner default, field by field', () => {
    const partner = { invoiceLineGrouping: 'day', invoiceLineShowDate: true, invoiceLineShowNote: true, invoiceLineShowWorkedTime: true };
    expect(resolveInvoiceLineDetail({ status: 'draft', ...none, lineShowNote: false, lineGrouping: 'entry' }, partner))
      .toEqual({ grouping: 'entry', showDate: true, showNote: false, showWorkedTime: true });
  });

  it('an issued invoice reads ONLY its frozen columns — the live partner default is ignored', () => {
    const partner = { invoiceLineGrouping: 'day', invoiceLineShowDate: true, invoiceLineShowNote: false, invoiceLineShowWorkedTime: false };
    expect(resolveInvoiceLineDetail({ status: 'sent', lineGrouping: 'entry', lineShowDate: true, lineShowNote: true, lineShowWorkedTime: true }, partner))
      .toEqual({ grouping: 'entry', showDate: true, showNote: true, showWorkedTime: true });
    // Issued before the columns existed (all NULL) → today's document, never the partner's new default.
    expect(resolveInvoiceLineDetail({ status: 'paid', ...none }, partner)).toEqual(DEFAULT_INVOICE_LINE_DETAIL);
  });

  it('day grouping without dates normalises to per-entry (all four combinations)', () => {
    const r = (g: string, d: boolean) => resolveInvoiceLineDetail({ status: 'draft', lineGrouping: g, lineShowDate: d, lineShowNote: null, lineShowWorkedTime: null }, null).grouping;
    expect(r('entry', false)).toBe('entry');
    expect(r('entry', true)).toBe('entry');
    expect(r('day', false)).toBe('entry');
    expect(r('day', true)).toBe('day');
  });

  it('an unknown grouping value coerces to per-entry', () => {
    expect(resolveInvoiceLineDetail({ status: 'draft', ...none, lineGrouping: 'week', lineShowDate: true }, null).grouping).toBe('entry');
  });
});

describe('stampInvoiceLineDetail', () => {
  it('freezes the resolved draft values as concrete columns', () => {
    const partner = { invoiceLineGrouping: 'day', invoiceLineShowDate: true, invoiceLineShowNote: true, invoiceLineShowWorkedTime: false };
    expect(stampInvoiceLineDetail({ lineGrouping: null, lineShowDate: null, lineShowNote: false, lineShowWorkedTime: null }, partner))
      .toEqual({ lineGrouping: 'day', lineShowDate: true, lineShowNote: false, lineShowWorkedTime: false });
  });

  it('stamps the normalised grouping, so the frozen pair can never be {no date, day}', () => {
    expect(stampInvoiceLineDetail({ lineGrouping: 'day', lineShowDate: false, lineShowNote: null, lineShowWorkedTime: null }, null))
      .toEqual({ lineGrouping: 'entry', lineShowDate: false, lineShowNote: true, lineShowWorkedTime: true });
  });
});

describe('lineWorkedVsBilled', () => {
  it('is null for a non-time line or when worked equals billed', () => {
    expect(lineWorkedVsBilled({ quantity: '1.00', workedMinutes: null })).toBeNull();
    expect(lineWorkedVsBilled({ quantity: '1.50', workedMinutes: 90 })).toBeNull();
  });
  it('returns both figures at 2dp when they differ', () => {
    expect(lineWorkedVsBilled({ quantity: '1.50', workedMinutes: 110 })).toEqual({ worked: '1.83', billed: '1.50' });
  });
});

describe('formatWorkDate', () => {
  const original = process.env.TZ;
  afterEach(() => { process.env.TZ = original; });

  it('formats a date-only value with no timezone shift, in any host zone', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = tz;
      expect(formatWorkDate('2026-09-16', 'en')).toBe('Sep 16, 2026');
    }
  });
  it('localises the month', () => {
    expect(formatWorkDate('2026-09-16', 'de-DE')).toMatch(/16\.?\s+Sept?\.?\s+2026/);
  });
  it('returns the input untouched for a malformed value rather than an invented date', () => {
    expect(formatWorkDate('not-a-date', 'en')).toBe('not-a-date');
  });
});

describe('invoiceLineText', () => {
  it('title falls back to description; blurb only when a name exists', () => {
    expect(invoiceLineText({ sourceType: 'time_entry', name: null, description: 'Fixed printer' }, ON)).toEqual({ title: 'Fixed printer', blurb: '' });
    expect(invoiceLineText({ sourceType: 'manual', name: 'Visit', description: 'Travel' }, ON)).toEqual({ title: 'Visit', blurb: 'Travel' });
    expect(invoiceLineText({ sourceType: 'manual', name: null, description: '  ' }, ON)).toEqual({ title: '—', blurb: '' });
    // Same as the pre-#8604 `(name ?? description).trim() || '—'`: an empty name does not fall through.
    expect(invoiceLineText({ sourceType: 'manual', name: '', description: 'Travel' }, ON)).toEqual({ title: '—', blurb: '' });
  });
  it('note OFF hides a time-entry line\'s note (title → null = generic labor label; blurb dropped)', () => {
    const off = { ...ON, showNote: false };
    expect(invoiceLineText({ sourceType: 'time_entry', name: null, description: 'Fixed printer' }, off)).toEqual({ title: null, blurb: '' });
    expect(invoiceLineText({ sourceType: 'time_entry', name: 'Labor — remote', description: 'Fixed printer' }, off)).toEqual({ title: 'Labor — remote', blurb: '' });
  });
  it('note OFF never touches non-time lines', () => {
    const off = { ...ON, showNote: false };
    expect(invoiceLineText({ sourceType: 'part', name: null, description: 'Fuser' }, off)).toEqual({ title: 'Fuser', blurb: '' });
    expect(invoiceLineText({ sourceType: 'contract', name: null, description: 'Block hours overage' }, off)).toEqual({ title: 'Block hours overage', blurb: '' });
  });
});

describe('lineWorkDateToShow', () => {
  it('shows the date only for a dated line, with dates on, per entry', () => {
    expect(lineWorkDateToShow({ workDate: '2026-09-16' }, ON)).toBe('2026-09-16');
    expect(lineWorkDateToShow({ workDate: null }, ON)).toBeNull();
    expect(lineWorkDateToShow({ workDate: '2026-09-16' }, { ...ON, showDate: false })).toBeNull();
    // Per-day: the day header carries the date, so the line does not repeat it.
    expect(lineWorkDateToShow({ workDate: '2026-09-16' }, { ...ON, grouping: 'day' })).toBeNull();
  });
});

describe('groupLinesByDay', () => {
  const l = (id: string, workDate: string | null, quantity: string, lineTotal: string) => ({ id, workDate, quantity, lineTotal });

  it('buckets by date ascending, undated lines last in one bucket, input order kept inside a bucket', () => {
    const lines = [l('a', '2026-09-17', '1.00', '100.00'), l('b', '2026-09-16', '1.50', '150.00'), l('p', null, '1.00', '100.00'), l('c', '2026-09-16', '0.50', '50.00'), l('m', null, '1.00', '75.00')];
    const days = groupLinesByDay(lines);
    expect(days.map((d) => d.workDate)).toEqual(['2026-09-16', '2026-09-17', null]);
    expect(days.map((d) => d.lines.map((x) => x.id))).toEqual([['b', 'c'], ['a'], ['p', 'm']]);
  });

  it('sums hours and amounts per day exactly (no float drift) and never alters a line', () => {
    const lines = [l('a', '2026-09-16', '0.10', '0.10'), l('b', '2026-09-16', '0.20', '0.20'), l('c', '2026-09-16', '0.33', '33.33')];
    const [day] = groupLinesByDay(lines);
    expect(day!.hours).toBe('0.63');
    expect(day!.total).toBe('33.63');
    expect(day!.lines[0]).toBe(lines[0]);
    expect(lines.map((x) => x.lineTotal)).toEqual(['0.10', '0.20', '33.33']);
  });

  it('returns nothing for no lines', () => {
    expect(groupLinesByDay([])).toEqual([]);
  });
});
