import { describe, expect, it } from 'vitest';
import { configuredDocsOrigin, isDocsEmbeddableOrigin } from './docsEmbed';

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

  it('rejects a custom app origin when no docs origin is configured', () => {
    expect(isDocsEmbeddableOrigin('https://rmm.example.com', {})).toBe(false);
    expect(isDocsEmbeddableOrigin('https://rmm.example.com', { PUBLIC_DOCS_URL: '' })).toBe(false);
  });

  it('allows a self-hosted app origin once PUBLIC_DOCS_URL is configured', () => {
    const env = { PUBLIC_DOCS_URL: 'https://docs.example.com' };
    // The operator stood up their own docs origin and authorized framing — the
    // custom app origin (https or plain http) is now embed-eligible.
    expect(isDocsEmbeddableOrigin('https://rmm.example.com', env)).toBe(true);
    expect(isDocsEmbeddableOrigin('http://rmm.internal', env)).toBe(true);
  });

  it('still rejects non-http(s) origins even with PUBLIC_DOCS_URL set', () => {
    const env = { PUBLIC_DOCS_URL: 'https://docs.example.com' };
    expect(isDocsEmbeddableOrigin('ftp://rmm.example.com', env)).toBe(false);
    expect(isDocsEmbeddableOrigin('not-a-url', env)).toBe(false);
  });

  it('ignores an invalid PUBLIC_DOCS_URL', () => {
    expect(isDocsEmbeddableOrigin('https://rmm.example.com', { PUBLIC_DOCS_URL: 'not a url' })).toBe(false);
    expect(isDocsEmbeddableOrigin('https://rmm.example.com', { PUBLIC_DOCS_URL: 'mailto:a@b.c' })).toBe(false);
  });
});

describe('configuredDocsOrigin', () => {
  it('returns the bare origin of a valid PUBLIC_DOCS_URL', () => {
    expect(configuredDocsOrigin({ PUBLIC_DOCS_URL: 'https://docs.example.com/help/' })).toBe(
      'https://docs.example.com',
    );
    expect(configuredDocsOrigin({ PUBLIC_DOCS_URL: 'http://docs.internal:8080/x' })).toBe(
      'http://docs.internal:8080',
    );
  });

  it('returns null when unset or invalid', () => {
    expect(configuredDocsOrigin({})).toBeNull();
    expect(configuredDocsOrigin({ PUBLIC_DOCS_URL: '   ' })).toBeNull();
    expect(configuredDocsOrigin({ PUBLIC_DOCS_URL: 'not a url' })).toBeNull();
    expect(configuredDocsOrigin({ PUBLIC_DOCS_URL: 'mailto:a@b.c' })).toBeNull();
  });
});
