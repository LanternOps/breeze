import { describe, expect, it } from 'vitest';
import { isDocsEmbeddableOrigin } from './docsEmbed';

describe('isDocsEmbeddableOrigin', () => {
  it('allows Breeze-hosted https origins', () => {
    expect(isDocsEmbeddableOrigin('https://app.breezermm.com')).toBe(true);
    expect(isDocsEmbeddableOrigin('https://breezermm.com')).toBe(true);
    expect(isDocsEmbeddableOrigin('https://2breeze.app')).toBe(true);
    expect(isDocsEmbeddableOrigin('https://staging.2breeze.app')).toBe(true);
  });

  it('allows local development origins', () => {
    expect(isDocsEmbeddableOrigin('http://localhost:4321')).toBe(true);
    expect(isDocsEmbeddableOrigin('http://127.0.0.1:4321')).toBe(true);
    expect(isDocsEmbeddableOrigin('http://tauri.localhost')).toBe(true);
  });

  it('rejects unsupported origins', () => {
    expect(isDocsEmbeddableOrigin('https://example.com')).toBe(false);
    expect(isDocsEmbeddableOrigin('https://localhost:4321')).toBe(false);
    expect(isDocsEmbeddableOrigin('not-a-url')).toBe(false);
  });
});
