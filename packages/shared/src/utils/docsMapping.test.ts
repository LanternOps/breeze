import { describe, it, expect } from 'vitest';
import { getDocsForPath, DOCS_BASE_URL } from './docsMapping';

describe('getDocsForPath', () => {
  describe('exact matches', () => {
    it('/devices maps to device management docs', () => {
      const result = getDocsForPath('/devices');
      expect(result.label).toBe('Device Management');
      expect(result.url).toBe(`${DOCS_BASE_URL}/features/device-groups/`);
    });

    it('/alerts maps to alerts docs', () => {
      const result = getDocsForPath('/alerts');
      expect(result.label).toBe('Alerts');
      expect(result.url).toContain('/monitoring/alerts/');
    });

    it('/scripts maps to scripts docs', () => {
      const result = getDocsForPath('/scripts');
      expect(result.label).toBe('Scripts');
    });
  });

  describe('prefix matches', () => {
    it('/devices/abc-123 matches device management', () => {
      const result = getDocsForPath('/devices/abc-123');
      expect(result.label).toBe('Device Management');
      expect(result.url).toBe(`${DOCS_BASE_URL}/features/device-groups/`);
    });

    it('/settings/users/some-id matches users entry', () => {
      const result = getDocsForPath('/settings/users/some-id');
      expect(result.label).toBe('Users & Roles');
    });
  });

  describe('specificity — more-specific pattern wins', () => {
    it('/settings/users matches Users & Roles, not generic Settings', () => {
      const result = getDocsForPath('/settings/users');
      expect(result.label).toBe('Users & Roles');
      expect(result.url).toContain('/reference/users-and-roles/');
    });

    it('/settings/api-keys matches API Keys, not generic Settings', () => {
      const result = getDocsForPath('/settings/api-keys');
      expect(result.label).toBe('API Keys');
    });

    it('/alerts/rules matches Alert Rules, not generic Alerts', () => {
      const result = getDocsForPath('/alerts/rules');
      expect(result.label).toBe('Alert Rules');
      expect(result.url).toContain('/monitoring/alert-templates/');
    });
  });

  describe('root path', () => {
    it('/ matches Getting Started', () => {
      const result = getDocsForPath('/');
      expect(result.label).toBe('Getting Started');
      expect(result.url).toContain('/getting-started/quickstart/');
    });
  });

  describe('unknown paths', () => {
    it('returns base docs URL with Documentation label for unknown path', () => {
      const result = getDocsForPath('/some-unknown-page');
      expect(result.url).toBe(DOCS_BASE_URL);
      expect(result.label).toBe('Documentation');
    });

    it('handles empty string input', () => {
      // Empty string is normalized to "/" by the function
      const result = getDocsForPath('');
      expect(result.label).toBe('Getting Started');
    });
  });

  describe('backup & incident routes', () => {
    it('/backup maps to device backup docs', () => {
      const result = getDocsForPath('/backup');
      expect(result.label).toBe('Backup');
      expect(result.url).toContain('/features/device-backup/');
    });

    it('/c2c maps to cloud-to-cloud backup docs', () => {
      const result = getDocsForPath('/c2c');
      expect(result.label).toBe('Cloud-to-Cloud Backup');
      expect(result.url).toContain('/features/device-backup/');
    });

    it('/dr maps to disaster recovery docs', () => {
      const result = getDocsForPath('/dr');
      expect(result.label).toBe('Disaster Recovery');
      expect(result.url).toContain('/features/device-backup/');
    });

    it('/incidents maps to incident response docs', () => {
      const result = getDocsForPath('/incidents');
      expect(result.label).toBe('Incident Response');
      expect(result.url).toContain('/features/incident-response/');
    });

    it('/incidents/abc-123 matches incident response', () => {
      const result = getDocsForPath('/incidents/abc-123');
      expect(result.label).toBe('Incident Response');
    });
  });

  describe('trailing slash normalization', () => {
    it('/devices/ is treated the same as /devices', () => {
      const withSlash = getDocsForPath('/devices/');
      const withoutSlash = getDocsForPath('/devices');
      expect(withSlash).toEqual(withoutSlash);
    });
  });
});
