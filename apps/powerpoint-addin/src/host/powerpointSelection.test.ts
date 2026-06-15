import { describe, expect, it, vi } from 'vitest';
import { getOfficeMock, MockShapeState } from '../__tests__/officeMock';
import { capturePptSelectionLabel, subscribePptSelectionChanged } from './powerpointSelection';

describe('powerpointSelection — host-bound PowerPoint wiring', () => {
  it('capturePptSelectionLabel returns a snippet of the selected shape text', async () => {
    const mock = getOfficeMock();
    mock.selectShapes([new MockShapeState('Selected caption')]);
    expect(await capturePptSelectionLabel()).toBe('Selected caption');
  });

  it('falls back to a slide locator when slides (not shapes) are selected', async () => {
    const mock = getOfficeMock();
    mock.setSlides([['One'], ['Two']]);
    mock.selectShapes([]);
    mock.selectSlides([1]);
    const label = await capturePptSelectionLabel();
    expect(label).toContain('Slide 2');
  });

  it('returns undefined when nothing is selected', async () => {
    const mock = getOfficeMock();
    mock.selectShapes([]);
    mock.selectedSlideIndices = [];
    expect(await capturePptSelectionLabel()).toBeUndefined();
  });

  it('fires the callback on every DocumentSelectionChanged', () => {
    const cb = vi.fn();
    subscribePptSelectionChanged(cb);
    getOfficeMock().selectShapes([new MockShapeState('a')]);
    getOfficeMock().selectShapes([new MockShapeState('b')]);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('registers the handler under the DocumentSelectionChanged event type', () => {
    const before = getOfficeMock().selectionHandlers.length;
    subscribePptSelectionChanged(() => undefined);
    expect(getOfficeMock().selectionHandlers.length).toBe(before + 1);
  });

  it('returns a callable no-op unsubscribe', () => {
    const unsubscribe = subscribePptSelectionChanged(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    expect(() => unsubscribe()).not.toThrow();
  });
});
