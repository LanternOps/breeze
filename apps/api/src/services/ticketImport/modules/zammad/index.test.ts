import { describe, expect, it } from 'vitest';
import { describeTicketImportModule, getTicketImportModule, listTicketImportModules } from '../../moduleRegistry';
import { zammadTicketImportModule } from './index';
import { zammadOptionsSchema } from './options';

/** Registration and options (spec 2026-10-19 §5.1, §5.7 `GET /ticket-imports/modules`, §6.3). */

describe('the Zammad module', () => {
  it('is a built-in module of the registry', () => {
    expect(getTicketImportModule('zammad')).toBe(zammadTicketImportModule);
    expect(listTicketImportModules().map((m) => m.id)).toContain('zammad');
  });

  it('describes its options as JSON Schema for the wizard', () => {
    const described = describeTicketImportModule(zammadTicketImportModule);
    expect(described).toMatchObject({ id: 'zammad', label: 'Zammad 7.2' });
    expect(described.optionsSchema).toMatchObject({
      type: 'object',
      properties: {
        priorityMap: expect.objectContaining({ type: 'object' }),
        systemArticles: expect.objectContaining({ enum: ['skip', 'internal_note'] }),
        timeAccountingNote: expect.objectContaining({ type: 'boolean' }),
        timeUnitLabel: expect.objectContaining({ type: 'string' }),
      },
    });
  });

  it('defaults: no priority map, System articles skipped, the time note on, in minutes', () => {
    expect(zammadOptionsSchema.parse({})).toEqual({ priorityMap: {}, systemArticles: 'skip', timeAccountingNote: true, timeUnitLabel: 'minutes' });
  });

  it('refuses unknown keys, a priority outside Breeze\'s, a non-numeric priority key and a control character', () => {
    expect(zammadOptionsSchema.safeParse({ createContacts: true }).success).toBe(false);
    expect(zammadOptionsSchema.safeParse({ priorityMap: { '4': 'critical' } }).success).toBe(false);
    expect(zammadOptionsSchema.safeParse({ priorityMap: { high: 'high' } }).success).toBe(false);
    expect(zammadOptionsSchema.safeParse({ timeUnitLabel: 'min\nutes' }).success).toBe(false);
    expect(zammadOptionsSchema.safeParse({ priorityMap: { '4': 'urgent' }, systemArticles: 'internal_note' }).success).toBe(true);
  });
});
