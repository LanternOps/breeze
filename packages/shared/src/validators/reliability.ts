import { z } from 'zod';

export const reliabilityCrashEventSchema = z.object({
  // app_crash = macOS per-app crash report (downweighted vs. whole-device crashes).
  // Keep in sync with ReliabilityCrashEvent (apps/api/src/db/schema/reliability.ts)
  // and the agent emitter (agent/internal/collectors/reliability_unix.go).
  type: z.enum(['bsod', 'kernel_panic', 'system_crash', 'oom_kill', 'app_crash', 'unknown']),
  timestamp: z.string().datetime(),
  details: z.record(z.string(), z.unknown()).optional(),
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
  // 'thermal' is macOS-sourced; classified by type (not source) so the API's
  // genuine-hardware gate recognises it. Keep in sync with ReliabilityHardwareError
  // and the agent's classifyHardwareType (agent/internal/collectors/reliability.go).
  type: z.enum(['mce', 'disk', 'memory', 'thermal', 'unknown']),
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
