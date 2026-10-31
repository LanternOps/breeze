import '@/lib/i18n';

import { render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { FilterPreviewFooter, isAwaitingValue } from './FilterPreviewFooter';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchMock = vi.mocked(fetchWithAuth);

function okResponse(totalCount: number) {
  return { ok: true, status: 200, json: async () => ({ data: { totalCount } }) } as unknown as Response;
}

function group(...conditions: FilterConditionGroup['conditions']): FilterConditionGroup {
  return { operator: 'AND', conditions };
}

async function flushDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
  // let the awaited fetch + json resolve
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FilterPreviewFooter (#9857)', () => {
  it('site chip with no site ticked: no request, neutral hint, no count', async () => {
    fetchMock.mockResolvedValue(okResponse(0));
    render(<FilterPreviewFooter group={group({ field: 'siteId', operator: 'in', value: [] })} />);
    await flushDebounce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('filter-preview-hint')).toHaveTextContent('Pick a value to see matching devices');
    expect(screen.queryByTestId('filter-preview-count')).toBeNull();
  });

  it('group chip with an empty string value is also treated as awaiting a value', async () => {
    fetchMock.mockResolvedValue(okResponse(0));
    render(<FilterPreviewFooter group={group({ field: 'groupId', operator: 'equals', value: '' })} />);
    await flushDebounce();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('filter-preview-hint')).toBeInTheDocument();
  });

  it('keeps the count once a value is chosen, with a singular form for one match', async () => {
    fetchMock.mockResolvedValue(okResponse(1));
    render(<FilterPreviewFooter group={group({ field: 'siteId', operator: 'in', value: ['site-1'] })} />);
    await flushDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('filter-preview-count')).toHaveTextContent('~1 device matches');
    expect(screen.queryByTestId('filter-preview-hint')).toBeNull();
  });

  it('uses the plural form for several matches', async () => {
    fetchMock.mockResolvedValue(okResponse(7));
    render(<FilterPreviewFooter group={group({ field: 'siteId', operator: 'in', value: ['a', 'b'] })} />);
    await flushDebounce();

    expect(screen.getByTestId('filter-preview-count')).toHaveTextContent('~7 devices match');
  });

  it('value-less operators (isNull) still preview', async () => {
    fetchMock.mockResolvedValue(okResponse(4));
    render(<FilterPreviewFooter group={group({ field: 'siteId', operator: 'isNull', value: '' })} />);
    await flushDebounce();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('filter-preview-count')).toHaveTextContent('~4 devices match');
  });
});

describe('FilterPreviewFooter state transitions', () => {
  it('aborts an in-flight preview and drops the count when the value is cleared, then refetches when set again', async () => {
    let firstSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url, init) => {
      firstSignal = (init as RequestInit).signal ?? undefined;
      return new Promise<Response>(() => {}); // never resolves: stays in flight
    });
    const filled = group({ field: 'siteId', operator: 'in', value: ['site-1'] });
    const { rerender } = render(<FilterPreviewFooter group={filled} />);
    await flushDebounce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('filter-preview-count')).toHaveTextContent('…counting');

    rerender(<FilterPreviewFooter group={group({ field: 'siteId', operator: 'in', value: [] })} />);
    await flushDebounce();
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByTestId('filter-preview-hint')).toBeInTheDocument();
    expect(screen.queryByTestId('filter-preview-count')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(okResponse(2));
    rerender(<FilterPreviewFooter group={group({ field: 'siteId', operator: 'in', value: ['site-2'] })} />);
    await flushDebounce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('filter-preview-count')).toHaveTextContent('~2 devices match');
  });
});

describe('isAwaitingValue', () => {
  it('is true when every leaf, including nested ones, still needs a value', () => {
    expect(
      isAwaitingValue(group(
        { field: 'hostname', operator: 'contains', value: '   ' },
        { operator: 'OR', conditions: [{ field: 'siteId', operator: 'in', value: [] }] }
      ))
    ).toBe(true);
  });

  it('is false for a partly filled group, so the sentence builder keeps its count', () => {
    expect(
      isAwaitingValue(group(
        { field: 'status', operator: 'equals', value: 'online' },
        { operator: 'OR', conditions: [{ field: 'siteId', operator: 'in', value: [] }] }
      ))
    ).toBe(false);
  });

  it('treats NaN and partially blank range / relative-date objects as awaiting', () => {
    expect(isAwaitingValue(group({ field: 'metrics.cpuPercent', operator: 'greaterThan', value: Number.NaN }))).toBe(true);
    expect(isAwaitingValue(group({ field: 'lastSeenAt', operator: 'withinLast', value: { amount: Number.NaN, unit: 'days' } }))).toBe(true);
    expect(isAwaitingValue(group({ field: 'lastSeenAt', operator: 'withinLast', value: { amount: 7, unit: 'days' } }))).toBe(false);
    expect(isAwaitingValue(group({ field: 'lastSeenAt', operator: 'before', value: new Date('2026-01-01') }))).toBe(false);
  });

  it('is false for an empty group (nothing to preview is handled separately)', () => {
    expect(isAwaitingValue(group())).toBe(false);
  });

  it('is false when every leaf has a value or a value-less operator', () => {
    expect(
      isAwaitingValue(group(
        { field: 'status', operator: 'equals', value: 'online' },
        { field: 'metrics.cpuPercent', operator: 'greaterThan', value: 0 },
        { field: 'isHeadless', operator: 'equals', value: false },
        { field: 'siteId', operator: 'isNotEmpty', value: [] }
      ))
    ).toBe(false);
  });
});
