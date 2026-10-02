import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import semver from 'semver';
import {
  orgTicketSettingsSchema,
  retiredAiModelFieldMessage,
  retiredLabourPricingMessage,
  RETIRED_LABOUR_PRICING_FIELDS,
  ticketCategoryInputSchema,
} from '@breeze/shared';
import rawManifest from './breaking-changes.json';
import { BREAKING_CHANGES_MANIFEST, parseBreakingChangesManifest } from './breakingChangesManifest';

// #6605: the manifest ships inside the API image and is the only thing an
// upgrade preflight knows about retirements. These assertions are its CI
// validation. They run in the required Test API job.

// Cumulative ratchet. The manifest is cumulative: an image must describe every
// retirement a deployment on ANY older version could cross by jumping straight
// to it, so an entry is never deleted. Add each new id here in the same PR that
// adds the entry. Never remove one.
const RECORDED_ENTRY_IDS = [
  'ticket-labour-pricing-fields',
  'ai-provider-endpoints',
  'ai-script-policy-reviewer-model',
  'client-ai-policy-allowed-models',
] as const;

describe('breaking-changes.json', () => {
  it('parses against the manifest schema', () => {
    const result = parseBreakingChangesManifest(rawManifest);
    expect(result.success ? [] : result.error.issues).toEqual([]);
  });

  it('never drops an entry (cumulative)', () => {
    const ids = BREAKING_CHANGES_MANIFEST.entries.map((e) => e.id);
    expect(RECORDED_ENTRY_IDS.filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => !(RECORDED_ENTRY_IDS as readonly string[]).includes(id))).toEqual([]);
  });

  it('has unique ids and ordered milestones', () => {
    const ids = BREAKING_CHANGES_MANIFEST.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of BREAKING_CHANGES_MANIFEST.entries) {
      if (entry.removedIn) {
        expect(semver.lte(entry.deprecatedIn, entry.removedIn), entry.id).toBe(true);
      }
    }
  });

  it('rejects a manifest whose removal version precedes its deprecation', () => {
    const bad = structuredClone(rawManifest) as { entries: Array<Record<string, unknown>> };
    bad.entries[0]!.deprecatedIn = '0.120.0';
    expect(parseBreakingChangesManifest(bad).success).toBe(false);
  });

  it('rejects a non-semver version and an invalid date', () => {
    const badVersion = structuredClone(rawManifest) as { entries: Array<Record<string, unknown>> };
    badVersion.entries[0]!.removedIn = 'v0.116';
    expect(parseBreakingChangesManifest(badVersion).success).toBe(false);
    const badDate = structuredClone(rawManifest) as { entries: Array<Record<string, unknown>> };
    badDate.entries[0]!.earliestRemovalDate = '2026-13-40';
    expect(parseBreakingChangesManifest(badDate).success).toBe(false);
  });

  describe('ticket-labour-pricing-fields agrees with the code that enforces it', () => {
    const entry = BREAKING_CHANGES_MANIFEST.entries.find((e) => e.id === 'ticket-labour-pricing-fields')!;

    it('names exactly the fields the shared validators retire, on every surface', () => {
      expect(entry.surfaces.length).toBeGreaterThan(0);
      for (const surface of entry.surfaces) {
        expect([...surface.fields].sort(), surface.endpoint).toEqual([...RETIRED_LABOUR_PRICING_FIELDS].sort());
      }
    });

    it('matches the version the rejection message announces', () => {
      const removed = semver.parse(entry.removedIn!)!;
      expect(retiredLabourPricingMessage('defaultHourlyRate', 'organization')).toContain(
        `retired in v${removed.major}.${removed.minor}`,
      );
    });

    it('is enforced: each retired field is rejected by every validator the surfaces use', () => {
      const validators = {
        orgTicketSettings: (field: string) => orgTicketSettingsSchema.safeParse({ [field]: 1 }),
        categoryCreate: (field: string) => ticketCategoryInputSchema.safeParse({ name: 'x', [field]: 1 }),
        categoryUpdate: (field: string) => ticketCategoryInputSchema.partial().safeParse({ [field]: 1 }),
      };
      for (const field of RETIRED_LABOUR_PRICING_FIELDS) {
        for (const [name, validate] of Object.entries(validators)) {
          expect(validate(field).success, `${name} accepted ${field}`).toBe(false);
        }
      }
    });
  });
});

describe('ai-provider-endpoints (#7606)', () => {
  const entry = () => BREAKING_CHANGES_MANIFEST.entries.find((e) => e.id === 'ai-provider-endpoints')!;

  it('the route file and its mount are gone', () => {
    expect(existsSync(join(__dirname, '..', 'routes', 'aiProvider.ts'))).toBe(false);
    expect(readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')).not.toMatch(/['"]\/ai\/provider['"]/);
  });

  it('retires every /ai/provider endpoint and names its /ai/models replacement', () => {
    expect(entry().kind).toBe('api-endpoint');
    expect(entry().surfaces.map((s) => s.endpoint).sort()).toEqual([
      'DELETE /api/v1/ai/provider',
      'GET /api/v1/ai/provider',
      'PATCH /api/v1/ai/provider',
      'POST /api/v1/ai/provider/endpoint',
      'POST /api/v1/ai/provider/key',
    ]);
    expect(entry().replacement).toContain('/api/v1/ai/models/connections');
    expect(entry().replacement).toContain('PUT /api/v1/ai/models/assignments');
  });
});

describe('retired AI model fields match their message (#7606)', () => {
  it.each([
    ['ai-script-policy-reviewer-model', 'reviewerModel'],
    ['client-ai-policy-allowed-models', 'allowedModels'],
  ] as const)('%s', (id, field) => {
    const entry = BREAKING_CHANGES_MANIFEST.entries.find((e) => e.id === id)!;
    expect(entry, id).toBeDefined();
    const removed = semver.parse(entry.removedIn!)!;
    expect(retiredAiModelFieldMessage(field)).toContain(`retired in v${removed.major}.${removed.minor}`);
    expect(entry.surfaces.length).toBeGreaterThan(0);
    for (const surface of entry.surfaces) expect(surface.fields).toEqual([field]);
  });
});
