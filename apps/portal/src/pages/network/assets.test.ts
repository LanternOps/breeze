import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(new URL('./index.astro', import.meta.url), 'utf8');

describe('network page asset table (#6641)', () => {
  it('fetches the first page of assets and mounts the client island with the org timezone', () => {
    expect(pageSource).toContain('portalApi.getNetworkAssets(');
    expect(pageSource).toMatch(/<NetworkAssetTable[\s\S]*timezone=/);
    expect(pageSource).toMatch(/<NetworkAssetTable[\s\S]*client:load/);
  });

  it('treats a 401 from the assets call like the overview: back to login', () => {
    expect(pageSource).toContain('assets.statusCode === 401');
  });
});
