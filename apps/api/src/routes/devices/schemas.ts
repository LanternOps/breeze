import { z } from 'zod';

export const listDevicesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']).optional(),
  osType: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

export const updateDeviceSchema = z.object({
  displayName: z.string().min(1).max(255).optional(),
  siteId: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(
    z.string().max(100),
    z.union([z.string().max(10000), z.number(), z.boolean(), z.null()])
  ).optional()
});

export const metricsQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  interval: z.enum(['1m', '5m', '1h', '1d']).optional(),
  range: z.enum(['1h', '6h', '24h', '7d', '30d']).optional()
});

export const softwareQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  search: z.string().optional()
});

export const createCommandSchema = z.object({
  type: z.enum(['script', 'reboot', 'shutdown', 'update']),
  payload: z.any().optional()
});

export const bulkCommandSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1),
  type: z.enum(['script', 'reboot', 'shutdown', 'update']),
  payload: z.any().optional()
});

export const maintenanceModeSchema = z.object({
  enable: z.boolean(),
  durationHours: z.number().int().positive().max(168).optional()
});

export const createGroupSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  siteId: z.string().uuid().optional(),
  type: z.enum(['static', 'dynamic']),
  rules: z.any().optional(),
  parentId: z.string().uuid().optional()
});

export const updateGroupSchema = createGroupSchema.partial().omit({ orgId: true });
