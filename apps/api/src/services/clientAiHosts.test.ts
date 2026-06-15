import { describe, it, expect } from 'vitest';
import {
  CLIENT_HOSTS,
  CLIENT_SESSION_TYPES,
  clientSessionType,
  clientHostFromType,
  isClientHost,
  normalizeTemplateHosts,
} from './clientAiHosts';

describe('clientAiHosts', () => {
  it('enumerates the four supported Office hosts', () => {
    expect(CLIENT_HOSTS).toEqual(['excel', 'word', 'powerpoint', 'outlook']);
  });

  it('maps host -> session type and back', () => {
    expect(clientSessionType('excel')).toBe('excel_client');
    expect(clientSessionType('word')).toBe('word_client');
    expect(clientHostFromType('excel_client')).toBe('excel');
    expect(clientHostFromType('powerpoint_client')).toBe('powerpoint');
  });

  it('CLIENT_SESSION_TYPES is every host type', () => {
    expect(CLIENT_SESSION_TYPES).toEqual([
      'excel_client', 'word_client', 'powerpoint_client', 'outlook_client',
    ]);
  });

  it('returns null for non-client types', () => {
    expect(clientHostFromType('general')).toBeNull();
    expect(clientHostFromType('agent')).toBeNull();
  });

  it('isClientHost narrows unknown strings', () => {
    expect(isClientHost('excel')).toBe(true);
    expect(isClientHost('keynote')).toBe(false);
  });

  describe('normalizeTemplateHosts', () => {
    it('collapses null/empty/all-hosts to null (= all apps)', () => {
      expect(normalizeTemplateHosts(null)).toBeNull();
      expect(normalizeTemplateHosts(undefined)).toBeNull();
      expect(normalizeTemplateHosts([])).toBeNull();
      expect(normalizeTemplateHosts(['excel', 'word', 'powerpoint', 'outlook'])).toBeNull();
    });

    it('keeps a genuine subset and dedupes', () => {
      expect(normalizeTemplateHosts(['powerpoint', 'word'])).toEqual(['powerpoint', 'word']);
      expect(normalizeTemplateHosts(['excel', 'excel'])).toEqual(['excel']);
    });
  });
});
