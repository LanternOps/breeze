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
      expect(result.url).toContain('/features/alerts/');
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

    it('/settings/connected-apps maps to MCP server docs', () => {
      const result = getDocsForPath('/settings/connected-apps');
      expect(result.label).toBe('Connected Apps & MCP');
      expect(result.url).toContain('/features/mcp-server/');
    });

    it('/alerts/rules matches Alert Rules, not generic Alerts', () => {
      const result = getDocsForPath('/alerts/rules');
      expect(result.label).toBe('Alert Rules');
      expect(result.url).toContain('/features/alert-templates/');
    });
  });

  describe('new mappings', () => {
    it('/settings/webhooks maps to webhooks docs', () => {
      const result = getDocsForPath('/settings/webhooks');
      expect(result.label).toBe('Webhooks');
      expect(result.url).toContain('/features/webhooks/');
    });

    it('/settings/integrations/huntress maps to EDR docs', () => {
      const result = getDocsForPath('/settings/integrations/huntress');
      expect(result.label).toBe('EDR Integrations');
      expect(result.url).toContain('/features/edr-integrations/');
    });

    it('/settings/filters maps to filters docs', () => {
      const result = getDocsForPath('/settings/filters');
      expect(result.label).toBe('Filters & Search');
      expect(result.url).toContain('/reference/filters-and-search/');
    });

    it('/remote/tools maps to system tools docs', () => {
      const result = getDocsForPath('/remote/tools');
      expect(result.label).toBe('System Tools');
      expect(result.url).toContain('/features/system-tools/');
    });

    it('/setup maps to setup wizard docs', () => {
      const result = getDocsForPath('/setup');
      expect(result.label).toBe('Setup Wizard');
      expect(result.url).toContain('/features/setup-wizard/');
    });

    it('/security/antivirus maps to antivirus exceptions docs', () => {
      const result = getDocsForPath('/security/antivirus');
      expect(result.label).toBe('Antivirus Exceptions');
      expect(result.url).toContain('/deploy/antivirus-exceptions/');
    });

    it('/devices/groups maps to device groups docs', () => {
      const result = getDocsForPath('/devices/groups');
      expect(result.label).toBe('Device Groups');
      expect(result.url).toContain('/features/device-groups/');
    });

    it('/integrations/webhooks maps to webhooks docs', () => {
      const result = getDocsForPath('/integrations/webhooks');
      expect(result.label).toBe('Webhooks');
      expect(result.url).toContain('/features/webhooks/');
    });

    it('/alerts/channels maps to alerts docs', () => {
      const result = getDocsForPath('/alerts/channels');
      expect(result.label).toBe('Notification Channels');
      expect(result.url).toContain('/features/alerts/');
    });

    it('/settings/sites maps to organizations docs', () => {
      const result = getDocsForPath('/settings/sites');
      expect(result.label).toBe('Sites');
      expect(result.url).toContain('/reference/organizations-and-sites/');
    });

    it('/settings/roles maps to users & roles docs', () => {
      const result = getDocsForPath('/settings/roles');
      expect(result.label).toBe('Roles');
      expect(result.url).toContain('/reference/users-and-roles/');
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
    it('/backup maps to backup overview docs', () => {
      const result = getDocsForPath('/backup');
      expect(result.label).toBe('Backup');
      expect(result.url).toContain('/backup/overview/');
    });

    it('/c2c maps to cloud-to-cloud backup docs', () => {
      const result = getDocsForPath('/c2c');
      expect(result.label).toBe('Cloud-to-Cloud Backup');
      expect(result.url).toContain('/backup/cloud-to-cloud/');
    });

    it('/dr maps to disaster recovery docs', () => {
      const result = getDocsForPath('/dr');
      expect(result.label).toBe('Disaster Recovery');
      expect(result.url).toContain('/backup/disaster-recovery/');
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
