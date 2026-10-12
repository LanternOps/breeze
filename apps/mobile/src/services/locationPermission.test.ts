import { describe, expect, it } from 'vitest';

import { canReadForArrival, toLocationPermissionState } from './locationPermission';

type Perm = Parameters<typeof toLocationPermissionState>[0];
const granted: Perm = { status: 'granted', canAskAgain: true };

describe('toLocationPermissionState', () => {
  it('services off wins over every permission state', () => {
    for (const perm of [
      granted,
      { status: 'denied', canAskAgain: false } as Perm,
      { status: 'undetermined', canAskAgain: true } as Perm,
    ]) {
      expect(toLocationPermissionState(perm, false, false)).toBe('services-off');
    }
  });

  it('undetermined stays undetermined', () => {
    expect(
      toLocationPermissionState({ status: 'undetermined', canAskAgain: true }, true, false)
    ).toBe('undetermined');
  });

  it('granted → granted', () => {
    expect(toLocationPermissionState(granted, true, false)).toBe('granted');
  });

  it('granted + observed reduced precision (iOS path) → granted-approximate', () => {
    expect(toLocationPermissionState(granted, true, true)).toBe('granted-approximate');
  });

  it('granted + android coarse → granted-approximate', () => {
    expect(
      toLocationPermissionState({ ...granted, android: { accuracy: 'coarse' } }, true, false)
    ).toBe('granted-approximate');
  });

  it('granted + android fine → granted', () => {
    expect(
      toLocationPermissionState({ ...granted, android: { accuracy: 'fine' } }, true, false)
    ).toBe('granted');
  });

  it('denied + canAskAgain:false → denied-blocked', () => {
    expect(toLocationPermissionState({ status: 'denied', canAskAgain: false }, true, false)).toBe(
      'denied-blocked'
    );
  });

  it('denied + canAskAgain:true → denied-can-ask', () => {
    expect(toLocationPermissionState({ status: 'denied', canAskAgain: true }, true, false)).toBe(
      'denied-can-ask'
    );
  });
});

describe('canReadForArrival', () => {
  it('is true only for granted', () => {
    expect(canReadForArrival('granted')).toBe(true);
    for (const s of [
      'undetermined',
      'granted-approximate',
      'denied-can-ask',
      'denied-blocked',
      'services-off',
    ] as const) {
      expect(canReadForArrival(s)).toBe(false);
    }
  });
});
