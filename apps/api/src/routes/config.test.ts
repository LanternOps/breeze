import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { configRoutes } from './config';

describe('GET /config', () => {
  const originalEnv = process.env.BREEZE_BILLING_URL;

  beforeEach(() => {
    delete process.env.BREEZE_BILLING_URL;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BREEZE_BILLING_URL;
    } else {
      process.env.BREEZE_BILLING_URL = originalEnv;
    }
  });

  const request = async () => {
    const app = new Hono().route('/config', configRoutes);
    const res = await app.request('/config');
    return { status: res.status, body: await res.json() as any };
  };

  it('returns both flags false when BREEZE_BILLING_URL unset', async () => {
    const { status, body } = await request();
    expect(status).toBe(200);
    expect(body.features).toEqual({ billing: false, support: false });
  });

  it('returns both flags true when BREEZE_BILLING_URL is set', async () => {
    process.env.BREEZE_BILLING_URL = 'http://localhost:4000';
    const { status, body } = await request();
    expect(status).toBe(200);
    expect(body.features).toEqual({ billing: true, support: true });
  });
});
