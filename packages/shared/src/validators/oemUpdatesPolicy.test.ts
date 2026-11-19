import { describe, expect, it } from 'vitest';
import {
  OEM_UPDATES_POLICY_DEFAULTS,
  armedOemCategories,
  armsBeyond,
  hasArmedCategory,
  oemUpdatesInlineSettingsSchema,
} from './oemUpdatesPolicy';

const base = () => ({
  version: 1 as const,
  enabled: true,
  schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
  catchUpNights: 7,
  reboot: 'overnight',
  vendors: {
    dell: { enabled: true, categories: { driver: true, application: true }, blockedUpdateIds: [] as string[] },
  },
});

describe('oemUpdatesInlineSettingsSchema', () => {
  it('accepts the spec 4.1 shape and the defaults', () => {
    expect(oemUpdatesInlineSettingsSchema.safeParse(base()).success).toBe(true);
    expect(oemUpdatesInlineSettingsSchema.parse(OEM_UPDATES_POLICY_DEFAULTS)).toEqual(OEM_UPDATES_POLICY_DEFAULTS);
  });

  it('defaults are third Wednesday 01:00, 4 h, 7 catch-up nights, overnight reboot, off', () => {
    expect(OEM_UPDATES_POLICY_DEFAULTS).toEqual({
      version: 1,
      enabled: false,
      schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
      catchUpNights: 7,
      reboot: 'overnight',
      vendors: {},
    });
  });

  it('an empty vendors object is valid, and an absent category is simply off', () => {
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), vendors: {} }).success).toBe(true);
    const parsed = oemUpdatesInlineSettingsSchema.parse({
      ...base(),
      vendors: { dell: { enabled: true, categories: {} } },
    });
    expect(parsed.vendors.dell).toEqual({ enabled: true, categories: {}, blockedUpdateIds: [] });
  });

  it('rejects an unknown key at every depth', () => {
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), extra: 1 }).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), schedule: { ...base().schedule, tz: 'UTC' } }).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), vendors: { acer: { enabled: true, categories: {} } } }).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse({
      ...base(),
      vendors: { dell: { enabled: true, categories: { bios: true, bootloader: true } } },
    }).success).toBe(false);
  });

  it('rejects windowHours 0 and 9, catchUpNights 15 and a 25:00 start', () => {
    for (const windowHours of [0, 9, 2.5]) {
      expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), schedule: { ...base().schedule, windowHours } }).success).toBe(false);
    }
    for (const catchUpNights of [-1, 15]) {
      expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), catchUpNights }).success).toBe(false);
    }
    for (const windowStart of ['25:00', '24:00', '1:00', '01:60', '01:00:00']) {
      expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), schedule: { ...base().schedule, windowStart } }).success).toBe(false);
    }
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), schedule: { ...base().schedule, windowStart: '23:59' } }).success).toBe(true);
  });

  it('accepts the ranges at their edges', () => {
    for (const windowHours of [1, 8]) {
      expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), schedule: { ...base().schedule, windowHours } }).success).toBe(true);
    }
    for (const catchUpNights of [0, 14]) {
      expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), catchUpNights }).success).toBe(true);
    }
  });

  it('requires version 1 and the known enums', () => {
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), version: 2 }).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), reboot: 'immediate' }).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), schedule: { ...base().schedule, weekOfMonth: 'fifth' } }).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse({ ...base(), schedule: { ...base().schedule, dayOfWeek: 'wednesday' } }).success).toBe(false);
  });

  it('bounds blocked update IDs: no blanks, no control characters, no duplicates, at most 200', () => {
    const withIds = (blockedUpdateIds: unknown) => ({
      ...base(),
      vendors: { dell: { enabled: true, categories: {}, blockedUpdateIds } },
    });
    expect(oemUpdatesInlineSettingsSchema.safeParse(withIds(['ABC12']).valueOf()).success).toBe(true);
    expect(oemUpdatesInlineSettingsSchema.safeParse(withIds([''])).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse(withIds(['a\nb'])).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse(withIds(['x'.repeat(129)])).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse(withIds(['A', 'A'])).success).toBe(false);
    expect(oemUpdatesInlineSettingsSchema.safeParse(withIds(Array.from({ length: 201 }, (_, i) => `id${i}`))).success).toBe(false);
  });
});

describe('hasArmedCategory', () => {
  it('needs the policy on, the vendor on and a category set true', () => {
    expect(hasArmedCategory(base())).toBe(true);
    expect(hasArmedCategory({ ...base(), enabled: false })).toBe(false);
    expect(hasArmedCategory({ ...base(), vendors: { dell: { enabled: false, categories: { driver: true } } } })).toBe(false);
    expect(hasArmedCategory({ ...base(), vendors: { dell: { enabled: true, categories: { driver: false } } } })).toBe(false);
    expect(hasArmedCategory({ ...base(), vendors: {} })).toBe(false);
  });

  it('reads untrusted input leniently and never throws', () => {
    for (const raw of [null, undefined, 'x', 1, [], { enabled: 'true', vendors: { dell: { enabled: true, categories: { bios: true } } } }, { enabled: true, vendors: 'dell' }]) {
      expect(hasArmedCategory(raw)).toBe(false);
    }
    expect(hasArmedCategory({ enabled: true, vendors: { dell: { enabled: true, categories: { bios: true } } } })).toBe(true);
  });

  it('armedOemCategories names lane:category pairs and ignores unknown lanes and categories', () => {
    expect([...armedOemCategories({
      enabled: true,
      vendors: {
        dell: { enabled: true, categories: { bios: true, driver: false, bootloader: true } },
        acer: { enabled: true, categories: { bios: true } },
      },
    })]).toEqual(['dell:bios']);
  });
});

describe('armsBeyond', () => {
  const off = () => ({ ...base(), enabled: false });
  const cases: Array<[string, unknown, unknown, boolean]> = [
    ['no previous link, enabled policy', null, base(), true],
    ['no previous link, enabled with nothing selected', null, { ...base(), vendors: {} }, true],
    ['no previous link, disabled policy', null, off(), false],
    ['enabled false to true', off(), base(), true],
    ['enabled true to false', base(), off(), false],
    ['a category newly true', base(), { ...base(), vendors: { dell: { ...base().vendors.dell, categories: { driver: true, application: true, bios: true } } } }, true],
    ['a category removed', base(), { ...base(), vendors: { dell: { ...base().vendors.dell, categories: { driver: true } } } }, false],
    ['a category set false', base(), { ...base(), vendors: { dell: { ...base().vendors.dell, categories: { driver: true, application: false } } } }, false],
    ['a vendor turned on with categories already set', { ...base(), vendors: { dell: { ...base().vendors.dell, enabled: false } } }, base(), true],
    ['a vendor turned off', base(), { ...base(), vendors: { dell: { ...base().vendors.dell, enabled: false } } }, false],
    ['a vendor removed', base(), { ...base(), vendors: {} }, false],
    ['a new vendor on with no categories', base(), { ...base(), vendors: { ...base().vendors, hp: { enabled: true, categories: {}, blockedUpdateIds: [] } } }, false],
    ['a blocked ID added', base(), { ...base(), vendors: { dell: { ...base().vendors.dell, blockedUpdateIds: ['X1'] } } }, false],
    ['a blocked ID removed while the vendor is armed', { ...base(), vendors: { dell: { ...base().vendors.dell, blockedUpdateIds: ['X1'] } } }, base(), true],
    ['a blocked ID removed while the vendor is off', { ...base(), vendors: { dell: { ...base().vendors.dell, enabled: false, blockedUpdateIds: ['X1'] } } }, { ...base(), vendors: { dell: { ...base().vendors.dell, enabled: false } } }, false],
    ['the window an hour earlier', base(), { ...base(), schedule: { ...base().schedule, windowStart: '00:00' } }, false],
    ['a longer window and more catch-up nights', base(), { ...base(), schedule: { ...base().schedule, windowHours: 8 }, catchUpNights: 14 }, false],
    ['reboot overnight to never', base(), { ...base(), reboot: 'never' }, false],
    ['reboot never to overnight while armed', { ...base(), reboot: 'never' }, base(), true],
    ['reboot never to overnight with nothing armed', { ...off(), reboot: 'never' }, off(), false],
    ['identical settings', base(), base(), false],
    ['malformed previous settings count as nothing armed', { enabled: 'yes' }, base(), true],
  ];
  for (const [name, prev, next, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(armsBeyond(prev, next)).toBe(expected);
    });
  }
});
