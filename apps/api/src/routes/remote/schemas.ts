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

export const iceCandidateSchema = z.object({
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional()
  })
});
