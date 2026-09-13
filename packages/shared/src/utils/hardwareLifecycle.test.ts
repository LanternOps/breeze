import { describe, expect, it } from 'vitest';
import {
  addYears,
  buildHardwareLifecycleRecommendations,
  classifyOsSupport,
  classifyReplacement,
  displayOs,
  humanJoin,
  isPlausibleDate,
  lifeUsedFraction,
  quarterLabel,
  replaceByLabel,
  replacementDueDate,
  sortLifecycleRows,
} from './hardwareLifecycle';
import type { HardwareLifecycleDeviceRow } from '../types/hardwareLifecycleReport';

const TODAY = '2026-06-10';

describe('replacementDueDate', () => {
  it('is purchase + replaceAgeYears when there is no active warranty', () => {
    expect(replacementDueDate('2021-07-15', null, { today: TODAY })).toBe('2025-07-15');
  });

  it('is the warranty end when active coverage runs longer than the age rule', () => {
    // LAW-SRV: bought Oct 2021, warranty to Nov 2026 → never "Replace now" while covered.
    expect(replacementDueDate('2021-10-01', '2026-11-30', { today: TODAY })).toBe('2026-11-30');
  });

  it('ignores an expired warranty — it proves nothing about replacement', () => {
    expect(replacementDueDate('2019-04-01', '2022-04-01', { today: TODAY })).toBe('2023-04-01');
    expect(replacementDueDate(null, '2022-04-01', { today: TODAY })).toBeNull();
  });

  it('uses an active warranty alone when the purchase date is unknown', () => {
    expect(replacementDueDate(null, '2027-05-01', { today: TODAY })).toBe('2027-05-01');
  });

  it('treats a future-dated purchase as unknown, not healthy', () => {
    expect(replacementDueDate('2027-01-01', null, { today: TODAY })).toBeNull();
  });

  it('rejects epoch-era and far-future dates from RMM sources', () => {
    expect(isPlausibleDate('1970-01-01', TODAY)).toBe(false);
    expect(isPlausibleDate('1969-12-31', TODAY)).toBe(false);
    expect(isPlausibleDate('2040-01-01', TODAY)).toBe(false);
    expect(isPlausibleDate('not-a-date', TODAY)).toBe(false);
    expect(isPlausibleDate('2024-03-01', TODAY)).toBe(true);
  });

  it('honours a configured replacement age', () => {
    expect(replacementDueDate('2021-07-15', null, { today: TODAY, replaceAgeYears: 5 })).toBe('2026-07-15');
  });
});

describe('addYears', () => {
  it('clamps Feb 29 to Feb 28 instead of rolling into March', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
  });
});

describe('classifyReplacement', () => {
  it('buckets by due date only', () => {
    expect(classifyReplacement(null, TODAY)).toBe('unknown');
    expect(classifyReplacement('2026-06-10', TODAY)).toBe('replace');
    expect(classifyReplacement('2025-01-01', TODAY)).toBe('replace');
    expect(classifyReplacement('2026-06-11', TODAY)).toBe('due_soon');
    expect(classifyReplacement('2027-06-10', TODAY)).toBe('due_soon');
    expect(classifyReplacement('2027-06-11', TODAY)).toBe('supported');
  });
});

describe('classifyOsSupport', () => {
  it('is conservative: unrecognised strings are unclassified, never ended', () => {
    expect(classifyOsSupport('linux', 'Ubuntu 24.04')).toBe('unclassified');
    expect(classifyOsSupport('windows', '')).toBe('unclassified');
    expect(classifyOsSupport(null, '')).toBe('na');
    expect(classifyOsSupport(null, null)).toBe('na');
  });

  it('classifies Windows client releases', () => {
    expect(classifyOsSupport('windows', 'Windows 11 Pro Edition')).toBe('supported');
    expect(classifyOsSupport('windows', 'Microsoft Windows 10 Pro')).toBe('ended');
    expect(classifyOsSupport('windows', 'Windows 7 Professional')).toBe('ended');
    expect(classifyOsSupport('windows', 'Windows 10 Enterprise LTSC 2021')).toBe('unclassified');
    expect(classifyOsSupport('windows', 'Windows 10 IoT Enterprise')).toBe('unclassified');
  });

  it('classifies Windows Server releases', () => {
    expect(classifyOsSupport('windows', 'Windows Server 2025 Standard')).toBe('supported');
    expect(classifyOsSupport('windows', 'Windows Server 2022 Datacenter')).toBe('supported');
    expect(classifyOsSupport('windows', 'Windows Server 2019 Small Business')).toBe('ending');
    expect(classifyOsSupport('windows', 'Windows Server 2016 Standard')).toBe('ending');
    expect(classifyOsSupport('windows', 'Windows Server 2012 R2')).toBe('ended');
    expect(classifyOsSupport('windows', 'Windows Server 2030')).toBe('unclassified');
  });

  it('classifies macOS by major version', () => {
    expect(classifyOsSupport('macos', 'macOS 26.3.1')).toBe('supported');
    expect(classifyOsSupport('macos', '14.5')).toBe('supported');
    expect(classifyOsSupport('macos', '13.6')).toBe('ended');
    expect(classifyOsSupport('macos', 'Sonoma')).toBe('unclassified');
  });
});

describe('displayOs', () => {
  it('cleans inventory strings for non-technical readers', () => {
    expect(displayOs('macos', 'macOS 26.3.1 (a) (25D77)')).toBe('macOS 26.3.1');
    expect(displayOs('windows', 'Microsoft Windows 11 Professional')).toBe('Windows 11 Pro');
    expect(displayOs('macos', '14.5')).toBe('macOS 14.5');
    expect(displayOs('windows', '10.0.19045')).toBe('Windows 10.0.19045');
  });
});

describe('labels', () => {
  it('quarterLabel + replaceByLabel', () => {
    expect(quarterLabel('2026-11-30')).toBe('Q4 2026');
    expect(quarterLabel('2027-05-01')).toBe('Q2 2027');
    expect(replaceByLabel(null, TODAY)).toBe('Unknown');
    expect(replaceByLabel('2026-06-10', TODAY)).toBe('Overdue');
    expect(replaceByLabel('2028-01-15', TODAY)).toBe('Q1 2028');
  });

  it('humanJoin', () => {
    expect(humanJoin([])).toBe('');
    expect(humanJoin(['a'])).toBe('a');
    expect(humanJoin(['a', 'b'])).toBe('a and b');
    expect(humanJoin(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('lifeUsedFraction is clamped to 1 and null without both dates', () => {
    expect(lifeUsedFraction('2019-04-01', '2023-04-01', TODAY)).toBe(1);
    expect(lifeUsedFraction('2024-03-01', '2028-03-01', TODAY)).toBeCloseTo(0.567, 2);
    expect(lifeUsedFraction(null, '2028-03-01', TODAY)).toBeNull();
    expect(lifeUsedFraction('2024-03-01', null, TODAY)).toBeNull();
  });
});

function row(partial: Partial<HardwareLifecycleDeviceRow> & { name: string }): HardwareLifecycleDeviceRow {
  return {
    id: partial.name,
    kind: 'device',
    os: 'Windows 11 Pro',
    osSupport: 'supported',
    purchaseDate: null,
    purchaseDateSource: null,
    warrantyEndDate: null,
    ageYears: null,
    replaceBy: null,
    replacement: 'unknown',
    warrantyExtended: false,
    lifeUsed: null,
    ...partial,
  };
}

describe('sortLifecycleRows', () => {
  it('orders most urgent first, then no-date rows by name', () => {
    const rows = [
      row({ name: 'zed' }),
      row({ name: 'later', replaceBy: '2028-01-01', replacement: 'supported' }),
      row({ name: 'alpha' }),
      row({ name: 'soon', replaceBy: '2024-01-01', replacement: 'replace' }),
    ];
    expect(sortLifecycleRows(rows).map((r) => r.name)).toEqual(['soon', 'later', 'alpha', 'zed']);
  });
});

describe('buildHardwareLifecycleRecommendations', () => {
  it('reproduces the staged plan from the reference report', () => {
    const rows = [
      row({ name: 'SAM4', replaceBy: '2023-04-01', replacement: 'replace', ageYears: 7.1, os: 'Windows 10 Pro', osSupport: 'ended' }),
      row({ name: 'GBG-LT', replaceBy: '2025-01-01', replacement: 'replace', ageYears: 5.4 }),
      row({ name: 'llr', replaceBy: '2025-07-01', replacement: 'replace', ageYears: 4.9 }),
      row({ name: 'reception', replaceBy: '2025-07-01', replacement: 'replace', ageYears: 4.9 }),
      row({ name: 'LAW-SRV', replaceBy: '2026-11-30', replacement: 'due_soon', warrantyEndDate: '2026-11-30', warrantyExtended: true }),
      row({ name: 'SAM23', replaceBy: '2027-04-15', replacement: 'due_soon' }),
      row({ name: 'SEL-LT7640', replaceBy: '2028-03-01', replacement: 'supported' }),
      row({ name: 'MacBook-Air.local' }),
    ];
    expect(buildHardwareLifecycleRecommendations(rows, TODAY)).toEqual([
      'Plan replacements for SAM4, GBG-LT, llr and reception this quarter, starting with SAM4 (7 years old).',
      'SAM4 no longer receives security updates on the current operating system; prioritize this one when scheduling.',
      'LAW-SRV is covered by warranty until November 2026; budget to replace it when coverage ends.',
      'Budget for SAM23 around Q2 2027; no action needed yet.',
      'We are confirming purchase records for 1 computer; their timelines will appear in an upcoming report.',
    ]);
  });

  it('says so when nothing needs attention', () => {
    expect(buildHardwareLifecycleRecommendations([row({ name: 'x', replaceBy: '2029-01-01', replacement: 'supported' })], TODAY)).toEqual([
      'Nothing needs your attention right now; we will flag the first computer to come due in a future report.',
    ]);
  });

  it('collapses a long replace list', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ name: `pc${i}`, replaceBy: '2024-01-01', replacement: 'replace' }));
    expect(buildHardwareLifecycleRecommendations(rows, TODAY)[0]).toBe(
      'Plan replacements for the 8 computers marked Replace now this quarter.',
    );
  });
});
