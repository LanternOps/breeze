/**
 * #7768 — the picker store's URL is built by the REAL `applyOrgId` (the
 * ambient-org injection inside `fetchWithAuth`), then checked against the REAL
 * shared validator. Mocking `fetchWithAuth` wholesale is what hid this bug.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chatModelChoicesQuerySchema } from '@breeze/shared';

const AMBIENT_ORG = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const urls: string[] = [];

vi.mock('./auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('./auth')>();
  return {
    ...real,
    fetchWithAuth: async (rawUrl: string, o: { skipOrgIdInjection?: boolean; orgIdOverride?: string | null } = {}) => {
      urls.push(real.applyOrgId(rawUrl, { skipOrgIdInjection: o.skipOrgIdInjection, orgIdOverride: o.orgIdOverride, ambient: AMBIENT_ORG }));
      return { ok: true, status: 200, json: async () => ({ data: { surface: 'chat', allowUserChoice: true, defaultOfferingId: null, current: null, choices: [] } }) };
    },
  };
});

import { useAiModelPickerStore } from './aiModelPickerStore';

const queryOf = (url: string) => Object.fromEntries(new URL(url, 'http://x').searchParams);

beforeEach(() => { urls.length = 0; useAiModelPickerStore.getState().reset(); });

describe('picker choices request under an ambient org', () => {
  it('a session request carries no orgId and passes the shared validator', async () => {
    await useAiModelPickerStore.getState().load({ sessionId: SESSION });
    expect(queryOf(urls[0]!)).toEqual({ sessionId: SESSION });
    expect(chatModelChoicesQuerySchema.safeParse(queryOf(urls[0]!)).success).toBe(true);
  });

  it('a no-session request names the org explicitly and passes the validator', async () => {
    await useAiModelPickerStore.getState().load({ orgId: AMBIENT_ORG });
    expect(queryOf(urls[0]!)).toEqual({ orgId: AMBIENT_ORG });
    expect(chatModelChoicesQuerySchema.safeParse(queryOf(urls[0]!)).success).toBe(true);
  });
});
