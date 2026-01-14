import { describe, it, expect } from 'vitest';
import {
  paginationSchema,
  uuidSchema,
  dateRangeSchema,
  loginSchema,
  registerSchema,
  forgotPasswordSchema,
  refreshTokenSchema,
  mfaVerifySchema,
  passwordResetSchema,
  createOrgSchema,
  createSiteSchema,
  inviteUserSchema,
  createRoleSchema,
  updateDeviceSchema,
  createDeviceGroupSchema,
  deviceQuerySchema,
  createScriptSchema,
  executeScriptSchema,
  alertQuerySchema,
  agentHeartbeatSchema
} from './index';

describe('validators', () => {
  describe('paginationSchema', () => {
    it('should accept valid pagination', () => {
      const result = paginationSchema.safeParse({ page: 1, limit: 50 });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(50);
      }
    });

    it('should use defaults when not provided', () => {
      const result = paginationSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(50);
      }
    });

    it('should coerce string numbers', () => {
      const result = paginationSchema.safeParse({ page: '2', limit: '25' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(2);
        expect(result.data.limit).toBe(25);
      }
    });

    it('should reject page less than 1', () => {
      const result = paginationSchema.safeParse({ page: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject limit greater than 100', () => {
      const result = paginationSchema.safeParse({ limit: 101 });
      expect(result.success).toBe(false);
    });

    it('should reject limit less than 1', () => {
      const result = paginationSchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe('uuidSchema', () => {
    it('should accept valid UUID', () => {
      const result = uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUID', () => {
      const result = uuidSchema.safeParse('not-a-uuid');
      expect(result.success).toBe(false);
    });

    it('should reject empty string', () => {
      const result = uuidSchema.safeParse('');
      expect(result.success).toBe(false);
    });
  });

  describe('dateRangeSchema', () => {
    it('should accept valid date range', () => {
      const result = dateRangeSchema.safeParse({
        from: '2024-01-01',
        to: '2024-12-31'
      });
      expect(result.success).toBe(true);
    });

    it('should accept partial date range', () => {
      const result = dateRangeSchema.safeParse({ from: '2024-01-01' });
      expect(result.success).toBe(true);
    });

    it('should accept empty object', () => {
      const result = dateRangeSchema.safeParse({});
      expect(result.success).toBe(true);
    });
  });

  describe('loginSchema', () => {
    it('should accept valid login', () => {
      const result = loginSchema.safeParse({
        email: 'test@example.com',
        password: 'password123'
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid email', () => {
      const result = loginSchema.safeParse({
        email: 'not-an-email',
        password: 'password123'
      });
      expect(result.success).toBe(false);
    });

    it('should reject short password', () => {
      const result = loginSchema.safeParse({
        email: 'test@example.com',
        password: 'short'
      });
      expect(result.success).toBe(false);
    });

    it('should reject missing fields', () => {
      expect(loginSchema.safeParse({ email: 'test@example.com' }).success).toBe(false);
      expect(loginSchema.safeParse({ password: 'password123' }).success).toBe(false);
      expect(loginSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('registerSchema', () => {
    it('should accept valid registration', () => {
      const result = registerSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
        name: 'Test User'
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty name', () => {
      const result = registerSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
        name: ''
      });
      expect(result.success).toBe(false);
    });

    it('should reject name over 255 chars', () => {
      const result = registerSchema.safeParse({
        email: 'test@example.com',
        password: 'password123',
        name: 'a'.repeat(256)
      });
      expect(result.success).toBe(false);
    });
  });

  describe('mfaVerifySchema', () => {
    it('should accept 6-digit code', () => {
      const result = mfaVerifySchema.safeParse({ code: '123456' });
      expect(result.success).toBe(true);
    });

    it('should reject codes not exactly 6 chars', () => {
      expect(mfaVerifySchema.safeParse({ code: '12345' }).success).toBe(false);
      expect(mfaVerifySchema.safeParse({ code: '1234567' }).success).toBe(false);
    });
  });

  describe('passwordResetSchema', () => {
    it('should accept valid reset', () => {
      const result = passwordResetSchema.safeParse({
        token: 'some-token',
        password: 'newpassword123'
      });
      expect(result.success).toBe(true);
    });

    it('should reject short password', () => {
      const result = passwordResetSchema.safeParse({
        token: 'some-token',
        password: 'short'
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createOrgSchema', () => {
    it('should accept valid org', () => {
      const result = createOrgSchema.safeParse({ name: 'Test Org' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.type).toBe('customer'); // default
      }
    });

    it('should accept org with all fields', () => {
      const result = createOrgSchema.safeParse({
        name: 'Test Org',
        type: 'internal',
        maxDevices: 100,
        contractStart: '2024-01-01',
        contractEnd: '2024-12-31'
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty name', () => {
      const result = createOrgSchema.safeParse({ name: '' });
      expect(result.success).toBe(false);
    });

    it('should reject invalid type', () => {
      const result = createOrgSchema.safeParse({ name: 'Test', type: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  describe('createSiteSchema', () => {
    it('should accept valid site', () => {
      const result = createSiteSchema.safeParse({ name: 'Main Office' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timezone).toBe('UTC'); // default
      }
    });

    it('should accept site with timezone', () => {
      const result = createSiteSchema.safeParse({
        name: 'NYC Office',
        timezone: 'America/New_York'
      });
      expect(result.success).toBe(true);
    });
  });

  describe('inviteUserSchema', () => {
    it('should accept valid invite', () => {
      const result = inviteUserSchema.safeParse({
        email: 'user@example.com',
        name: 'New User',
        roleId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.success).toBe(true);
    });

    it('should accept invite with orgAccess', () => {
      const result = inviteUserSchema.safeParse({
        email: 'user@example.com',
        name: 'New User',
        roleId: '550e8400-e29b-41d4-a716-446655440000',
        orgAccess: 'selected',
        orgIds: ['550e8400-e29b-41d4-a716-446655440001']
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid roleId', () => {
      const result = inviteUserSchema.safeParse({
        email: 'user@example.com',
        name: 'New User',
        roleId: 'not-a-uuid'
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createRoleSchema', () => {
    it('should accept valid role', () => {
      const result = createRoleSchema.safeParse({
        name: 'Admin',
        scope: 'organization',
        permissions: ['devices:read', 'devices:write']
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid scope', () => {
      const result = createRoleSchema.safeParse({
        name: 'Admin',
        scope: 'invalid',
        permissions: []
      });
      expect(result.success).toBe(false);
    });
  });

  describe('updateDeviceSchema', () => {
    it('should accept valid update', () => {
      const result = updateDeviceSchema.safeParse({
        displayName: 'Web Server 01',
        tags: ['production', 'web']
      });
      expect(result.success).toBe(true);
    });

    it('should reject too many tags', () => {
      const result = updateDeviceSchema.safeParse({
        tags: Array(21).fill('tag')
      });
      expect(result.success).toBe(false);
    });

    it('should reject tag over 50 chars', () => {
      const result = updateDeviceSchema.safeParse({
        tags: ['a'.repeat(51)]
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createDeviceGroupSchema', () => {
    it('should accept static group', () => {
      const result = createDeviceGroupSchema.safeParse({
        name: 'Web Servers',
        type: 'static'
      });
      expect(result.success).toBe(true);
    });

    it('should accept dynamic group with rules', () => {
      const result = createDeviceGroupSchema.safeParse({
        name: 'Windows Servers',
        type: 'dynamic',
        rules: { osType: 'windows' }
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid type', () => {
      const result = createDeviceGroupSchema.safeParse({
        name: 'Test',
        type: 'invalid'
      });
      expect(result.success).toBe(false);
    });
  });

  describe('deviceQuerySchema', () => {
    it('should accept valid query', () => {
      const result = deviceQuerySchema.safeParse({
        page: 1,
        limit: 25,
        status: 'online',
        osType: 'windows'
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid status', () => {
      const result = deviceQuerySchema.safeParse({ status: 'invalid' });
      expect(result.success).toBe(false);
    });

    it('should reject invalid osType', () => {
      const result = deviceQuerySchema.safeParse({ osType: 'invalid' });
      expect(result.success).toBe(false);
    });
  });

  describe('createScriptSchema', () => {
    it('should accept valid script', () => {
      const result = createScriptSchema.safeParse({
        name: 'Install Updates',
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Get-WindowsUpdate'
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeoutSeconds).toBe(300); // default
        expect(result.data.runAs).toBe('system'); // default
      }
    });

    it('should accept script with multiple OS types', () => {
      const result = createScriptSchema.safeParse({
        name: 'Check Disk',
        osTypes: ['windows', 'linux', 'macos'],
        language: 'bash',
        content: 'df -h'
      });
      expect(result.success).toBe(true);
    });

    it('should reject empty osTypes', () => {
      const result = createScriptSchema.safeParse({
        name: 'Test',
        osTypes: [],
        language: 'bash',
        content: 'echo test'
      });
      expect(result.success).toBe(false);
    });

    it('should reject timeout over 3600', () => {
      const result = createScriptSchema.safeParse({
        name: 'Test',
        osTypes: ['linux'],
        language: 'bash',
        content: 'echo test',
        timeoutSeconds: 7200
      });
      expect(result.success).toBe(false);
    });
  });

  describe('executeScriptSchema', () => {
    it('should accept deviceIds', () => {
      const result = executeScriptSchema.safeParse({
        deviceIds: ['550e8400-e29b-41d4-a716-446655440000']
      });
      expect(result.success).toBe(true);
    });

    it('should accept groupId', () => {
      const result = executeScriptSchema.safeParse({
        groupId: '550e8400-e29b-41d4-a716-446655440000'
      });
      expect(result.success).toBe(true);
    });

    it('should reject when neither deviceIds nor groupId provided', () => {
      const result = executeScriptSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject empty deviceIds without groupId', () => {
      const result = executeScriptSchema.safeParse({ deviceIds: [] });
      expect(result.success).toBe(false);
    });
  });

  describe('alertQuerySchema', () => {
    it('should accept valid query', () => {
      const result = alertQuerySchema.safeParse({
        status: 'active',
        severity: 'critical'
      });
      expect(result.success).toBe(true);
    });

    it('should accept all severity levels', () => {
      const severities = ['critical', 'high', 'medium', 'low', 'info'];
      for (const severity of severities) {
        const result = alertQuerySchema.safeParse({ severity });
        expect(result.success).toBe(true);
      }
    });

    it('should accept all status values', () => {
      const statuses = ['active', 'acknowledged', 'resolved', 'suppressed'];
      for (const status of statuses) {
        const result = alertQuerySchema.safeParse({ status });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('agentHeartbeatSchema', () => {
    it('should accept valid heartbeat', () => {
      const result = agentHeartbeatSchema.safeParse({
        metrics: {
          cpuPercent: 45.5,
          ramPercent: 60.2,
          ramUsedMb: 4096,
          diskPercent: 75.0,
          diskUsedGb: 150
        },
        status: 'ok',
        agentVersion: '1.0.0'
      });
      expect(result.success).toBe(true);
    });

    it('should reject cpuPercent over 100', () => {
      const result = agentHeartbeatSchema.safeParse({
        metrics: {
          cpuPercent: 150,
          ramPercent: 60,
          ramUsedMb: 4096,
          diskPercent: 75,
          diskUsedGb: 150
        },
        status: 'ok',
        agentVersion: '1.0.0'
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative metrics', () => {
      const result = agentHeartbeatSchema.safeParse({
        metrics: {
          cpuPercent: -10,
          ramPercent: 60,
          ramUsedMb: 4096,
          diskPercent: 75,
          diskUsedGb: 150
        },
        status: 'ok',
        agentVersion: '1.0.0'
      });
      expect(result.success).toBe(false);
    });

    it('should accept optional fields', () => {
      const result = agentHeartbeatSchema.safeParse({
        metrics: {
          cpuPercent: 45.5,
          ramPercent: 60.2,
          ramUsedMb: 4096,
          diskPercent: 75.0,
          diskUsedGb: 150,
          networkInBytes: 1000000,
          networkOutBytes: 500000,
          processCount: 150
        },
        status: 'warning',
        agentVersion: '1.0.0',
        pendingReboot: true,
        lastUser: 'admin'
      });
      expect(result.success).toBe(true);
    });
  });
});
