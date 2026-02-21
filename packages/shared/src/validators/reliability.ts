import { z } from 'zod';

export const reliabilityCrashEventSchema = z.object({
  type: z.enum(['bsod', 'kernel_panic', 'system_crash', 'oom_kill', 'unknown']),
  timestamp: z.string().datetime(),
  details: z.record(z.unknown()).optional(),
});

export const reliabilityAppHangSchema = z.object({
  processName: z.string().min(1).max(255),
  timestamp: z.string().datetime(),
  duration: z.number().int().min(0).max(86_400),
  resolved: z.boolean(),
});

export const reliabilityServiceFailureSchema = z.object({
  serviceName: z.string().min(1).max(255),
  timestamp: z.string().datetime(),
  errorCode: z.string().max(100).optional(),
  recovered: z.boolean(),
});

export const reliabilityHardwareErrorSchema = z.object({
  type: z.enum(['mce', 'disk', 'memory', 'unknown']),
  severity: z.enum(['critical', 'error', 'warning']),
  timestamp: z.string().datetime(),
  source: z.string().min(1).max(255),
  eventId: z.string().max(100).optional(),
});

export const reliabilityMetricsSchema = z.object({
  uptimeSeconds: z.number().int().min(0),
  bootTime: z.string().datetime(),
  crashEvents: z.array(reliabilityCrashEventSchema).max(500).default([]),
  appHangs: z.array(reliabilityAppHangSchema).max(1000).default([]),
  serviceFailures: z.array(reliabilityServiceFailureSchema).max(1000).default([]),
  hardwareErrors: z.array(reliabilityHardwareErrorSchema).max(1000).default([]),
}).passthrough();

export type ReliabilityMetricsPayload = z.infer<typeof reliabilityMetricsSchema>;
