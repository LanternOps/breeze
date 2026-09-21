import { expect, it } from 'vitest';
import { sameLayoutFence, LAYOUT_VERSION, type LayoutFence } from './layoutTypes';

const base: LayoutFence = { requestId: 'r1', graphRevision: 'g1', layoutRevision: 'l1', measurementRevision: 'm1', algorithmVersion: LAYOUT_VERSION };

it('matches when every fence field is identical', () => {
  expect(sameLayoutFence(base, { ...base })).toBe(true);
});

it.each(['requestId', 'graphRevision', 'layoutRevision', 'measurementRevision', 'algorithmVersion'] as const)(
  'rejects a mismatch on %s alone',
  (field) => {
    expect(sameLayoutFence(base, { ...base, [field]: 'different' })).toBe(false);
  },
);
