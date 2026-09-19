/**
 * Device function (Fleet Designer W02): the ACTIVE `device_function_assessments`
 * row for a device, as returned by `GET /devices/:id/function`. Every field is
 * null when the device has no active assessment (`evidence` is `[]`).
 */
export type DeviceFunctionSource = 'ai' | 'manual';

export interface DeviceFunctionDto {
  deviceId: string;
  /** A `DEVICE_FUNCTION_KEYS` entry or `custom:<slug>`; null when unset. */
  functionKey: string | null;
  /** Display label for a custom key (null for known keys — use DEVICE_FUNCTION_LABELS). */
  label: string | null;
  source: DeviceFunctionSource | null;
  /** 0..1 for an `ai` row; null for a manual row or when unset. */
  confidence: number | null;
  /** Bounded display strings written by the designer; empty for manual rows. */
  evidence: string[];
  /** ISO timestamp of the active row's creation; null when unset. */
  assessedAt: string | null;
  runId: string | null;
  reportRunId: string | null;
}
