import { z } from 'zod';

// Session schemas
export const createSessionSchema = z.object({
  deviceId: z.string().guid(),
  type: z.enum(['terminal', 'desktop', 'file_transfer'])
});

export const listSessionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().guid().optional(),
  status: z.enum(['pending', 'connecting', 'active', 'disconnected', 'failed']).optional(),
  type: z.enum(['terminal', 'desktop', 'file_transfer']).optional(),
  includeEnded: z.enum(['true', 'false']).optional()
});

export const sessionHistorySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().guid().optional(),
  userId: z.string().guid().optional(),
  type: z.enum(['terminal', 'desktop', 'file_transfer']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

export const webrtcOfferSchema = z.object({
  offer: z.string().min(1).max(65536),
  displayIndex: z.number().int().min(0).max(15).optional(),
  targetSessionId: z.number().int().min(0).max(65535).optional()
});

export const webrtcAnswerSchema = z.object({
  answer: z.string().min(1).max(65536),
  // Optional, additive: present only when the agent answers a session that was
  // in `consent` mode, so the API can emit a `session_consent_granted` audit
  // alongside the existing `session_connected` audit. Absent for notify/off.
  consentReason: z.enum(['user']).optional()
});

// Agent-facing deny verdict for a remote-session consent prompt. `reason`
// distinguishes a genuine user/timeout denial (audited as
// `session_consent_denied`) from a policy bypass / unavailable path
// (`session_consent_bypassed`).
export const sessionDenySchema = z.object({
  reason: z.enum(['user', 'timeout', 'no_user', 'helper_absent', 'policy_proceed'])
});

export const iceCandidateSchema = z.object({
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional()
  })
});

// File transfer schemas
export const createTransferSchema = z.object({
  deviceId: z.string().guid(),
  sessionId: z.string().guid().optional(),
  direction: z.enum(['upload', 'download']),
  remotePath: z.string().min(1),
  localFilename: z.string().min(1),
  sizeBytes: z.number().int().min(0)
});

export const listTransfersSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().guid().optional(),
  status: z.enum(['pending', 'transferring', 'completed', 'failed']).optional(),
  direction: z.enum(['upload', 'download']).optional()
});
