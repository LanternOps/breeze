import { z } from 'zod';

// Session schemas
export const createSessionSchema = z.object({
  deviceId: z.string().uuid(),
  type: z.enum(['terminal', 'desktop', 'file_transfer'])
});

export const listSessionsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  status: z.enum(['pending', 'connecting', 'active', 'disconnected', 'failed']).optional(),
  type: z.enum(['terminal', 'desktop', 'file_transfer']).optional(),
  includeEnded: z.enum(['true', 'false']).optional()
});

export const sessionHistorySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  type: z.enum(['terminal', 'desktop', 'file_transfer']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

export const webrtcOfferSchema = z.object({
  offer: z.string().min(1).max(65536),
  displayIndex: z.number().int().min(0).max(15).optional()
});

export const webrtcAnswerSchema = z.object({
  answer: z.string().min(1).max(65536)
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
  deviceId: z.string().uuid(),
  sessionId: z.string().uuid().optional(),
  direction: z.enum(['upload', 'download']),
  remotePath: z.string().min(1),
  localFilename: z.string().min(1),
  sizeBytes: z.number().int().min(0)
});

export const listTransfersSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  deviceId: z.string().uuid().optional(),
  status: z.enum(['pending', 'transferring', 'completed', 'failed']).optional(),
  direction: z.enum(['upload', 'download']).optional()
});
