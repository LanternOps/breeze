/**
 * AI Remote Tools
 *
 * Tools for remote device control and session management.
 * - take_screenshot (Tier 2): Capture a screenshot of the device screen
 * - analyze_screen (Tier 2): Take a screenshot and analyze what is visible
 * - computer_control (Tier 3): Control a device by sending mouse/keyboard input
 * - list_remote_sessions (Tier 1): List active and recent remote sessions
 * - create_remote_session (Tier 3): Create a new remote session
 */

import { db } from '../db';
import { devices, remoteSessions } from '../db/schema';
import { eq, and, desc, SQL } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

type AiToolTier = 1 | 2 | 3 | 4;

async function verifyDeviceAccess(
  deviceId: string,
  auth: AuthContext,
  requireOnline = false
): Promise<{ device: typeof devices.$inferSelect } | { error: string }> {
  const conditions: SQL[] = [eq(devices.id, deviceId)];
  const orgCond = auth.orgCondition(devices.orgId);
  if (orgCond) conditions.push(orgCond);
  const [device] = await db.select().from(devices).where(and(...conditions)).limit(1);
  if (!device) return { error: 'Device not found or access denied' };
  if (requireOnline && device.status !== 'online') return { error: `Device ${device.hostname} is not online (status: ${device.status})` };
  return { device };
}

let _commandQueue: typeof import('./commandQueue') | null = null;
async function getCommandQueue() {
  if (!_commandQueue) _commandQueue = await import('./commandQueue');
  return _commandQueue;
}

export function registerRemoteTools(aiTools: Map<string, AiTool>): void {
  function registerTool(tool: AiTool): void {
    aiTools.set(tool.definition.name, tool);
  }

  // ============================================
  // take_screenshot - Tier 2 (auto-execute + audit)
  // ============================================

  registerTool({
    tier: 2 as AiToolTier,
    definition: {
      name: 'take_screenshot',
      description: 'Capture a screenshot of the device screen. Returns the image for visual analysis. Use this when you need to see what is displayed on the device screen.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          monitor: { type: 'number', description: 'Monitor index to capture (default: 0 = primary)' }
        },
        required: ['deviceId']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();
      const result = await executeCommand(deviceId, 'take_screenshot', {
        monitor: input.monitor ?? 0
      }, { userId: auth.user.id, timeoutMs: 30000 });

      if (result.status !== 'completed') {
        return JSON.stringify({ error: result.error || 'Screenshot capture failed' });
      }

      try {
        const screenshotData = JSON.parse(result.stdout ?? '{}');
        if (!screenshotData.imageBase64) {
          console.error(`[AiTools] take_screenshot returned no imageBase64 data for device ${deviceId}`);
          return JSON.stringify({ error: 'Screenshot captured but no image data returned by agent' });
        }
        return JSON.stringify({
          imageBase64: screenshotData.imageBase64,
          width: screenshotData.width,
          height: screenshotData.height,
          format: screenshotData.format,
          sizeBytes: screenshotData.sizeBytes,
          monitor: screenshotData.monitor,
          capturedAt: screenshotData.capturedAt
        });
      } catch (err) {
        const rawPreview = (result.stdout ?? '').slice(0, 200);
        console.error(`[AiTools] Failed to parse take_screenshot response:`, err, 'Raw stdout preview:', rawPreview);
        return JSON.stringify({ error: 'Failed to parse screenshot response' });
      }
    }
  });

  // ============================================
  // analyze_screen - Tier 2 (auto-execute + audit)
  // ============================================

  registerTool({
    tier: 2 as AiToolTier,
    definition: {
      name: 'analyze_screen',
      description: 'Take a screenshot and analyze what is visible on the device screen. Combines screenshot capture with device context for AI visual analysis. Use this for troubleshooting what the user sees.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          context: { type: 'string', description: 'What to look for or analyze on screen (e.g., "error dialogs", "performance issues", "application state")' },
          monitor: { type: 'number', description: 'Monitor index to capture (default: 0 = primary)' }
        },
        required: ['deviceId']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();
      const result = await executeCommand(deviceId, 'take_screenshot', {
        monitor: input.monitor ?? 0
      }, { userId: auth.user.id, timeoutMs: 30000 });

      if (result.status !== 'completed') {
        return JSON.stringify({ error: result.error || 'Screenshot capture failed' });
      }

      try {
        const screenshotData = JSON.parse(result.stdout ?? '{}');
        if (!screenshotData.imageBase64) {
          console.error(`[AiTools] analyze_screen returned no imageBase64 data for device ${deviceId}`);
          return JSON.stringify({ error: 'Screenshot captured but no image data returned by agent' });
        }
        return JSON.stringify({
          imageBase64: screenshotData.imageBase64,
          width: screenshotData.width,
          height: screenshotData.height,
          format: screenshotData.format,
          sizeBytes: screenshotData.sizeBytes,
          capturedAt: screenshotData.capturedAt,
          analysisContext: input.context || 'general screen analysis',
          device: {
            id: access.device.id,
            hostname: access.device.hostname,
            osType: access.device.osType,
            osVersion: access.device.osVersion,
            status: access.device.status
          }
        });
      } catch (err) {
        const rawPreview = (result.stdout ?? '').slice(0, 200);
        console.error(`[AiTools] Failed to parse analyze_screen response:`, err, 'Raw stdout preview:', rawPreview);
        return JSON.stringify({ error: 'Failed to parse screenshot response' });
      }
    }
  });

  // ============================================
  // computer_control - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
    definition: {
      name: 'computer_control',
      description: 'Control a device by sending mouse/keyboard input and capturing screenshots. Returns a screenshot after each action by default (configurable via captureAfter). Actions: screenshot, left_click, right_click, middle_click, double_click, mouse_move, scroll, key, type.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
          action: {
            type: 'string',
            enum: ['screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'mouse_move', 'scroll', 'key', 'type'],
            description: 'The input action to perform'
          },
          x: { type: 'number', description: 'X coordinate (required for click/move/scroll actions)' },
          y: { type: 'number', description: 'Y coordinate (required for click/move/scroll actions)' },
          text: { type: 'string', description: 'Text to type (required for type action)' },
          key: { type: 'string', description: 'Key to press (required for key action, e.g., "Enter", "Tab", "Escape")' },
          modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'alt', 'shift', 'meta'] }, description: 'Modifier keys to hold during key press' },
          scrollDelta: { type: 'number', description: 'Scroll amount (negative=up, positive=down)' },
          monitor: { type: 'number', description: 'Monitor index to capture (default: 0)' },
          captureAfter: { type: 'boolean', description: 'Whether to capture a screenshot after the action (default: true)' },
          captureDelayMs: { type: 'number', description: 'Milliseconds to wait before capturing screenshot (default: 500, max: 3000)' }
        },
        required: ['deviceId', 'action']
      }
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;

      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      const { executeCommand } = await getCommandQueue();
      const result = await executeCommand(deviceId, 'computer_action', {
        action: input.action,
        x: input.x,
        y: input.y,
        text: input.text,
        key: input.key,
        modifiers: input.modifiers,
        scrollDelta: input.scrollDelta,
        monitor: input.monitor ?? 0,
        captureAfter: input.captureAfter ?? true,
        captureDelayMs: input.captureDelayMs ?? 500,
      }, { userId: auth.user.id, timeoutMs: 30000 });

      if (result.status !== 'completed') {
        return JSON.stringify({ error: result.error || 'Computer action failed' });
      }

      try {
        const data = JSON.parse(result.stdout ?? '{}');
        return JSON.stringify({
          actionExecuted: data.actionExecuted,
          imageBase64: data.screenshot?.imageBase64,
          width: data.screenshot?.width,
          height: data.screenshot?.height,
          format: data.screenshot?.format,
          sizeBytes: data.screenshot?.sizeBytes,
          monitor: data.screenshot?.monitor,
          capturedAt: data.screenshot?.capturedAt,
          screenshotError: data.screenshotError || undefined,
        });
      } catch (err) {
        const rawPreview = (result.stdout ?? '').slice(0, 200);
        console.error(`[AiTools] Failed to parse computer_control response:`, err, 'Raw stdout preview:', rawPreview);
        return JSON.stringify({ error: 'Failed to parse computer action response' });
      }
    }
  });

  // ============================================
  // list_remote_sessions - Tier 1 (auto-execute)
  // ============================================

  registerTool({
    tier: 1 as AiToolTier,
    definition: {
      name: 'list_remote_sessions',
      description: 'List active and recent remote sessions (terminal, desktop, file transfer).',
      input_schema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'connecting', 'active', 'disconnected', 'failed'],
            description: 'Filter by session status',
          },
          type: {
            type: 'string',
            enum: ['terminal', 'desktop', 'file_transfer'],
            description: 'Filter by session type',
          },
          deviceId: {
            type: 'string',
            description: 'Filter by device UUID',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 25, max 100)',
          },
        },
      },
    },
    handler: async (input, auth) => {
      const limit = Math.min((input.limit as number) || 25, 100);

      const conditions: SQL[] = [];
      const orgCond = auth.orgCondition(devices.orgId);
      if (orgCond) conditions.push(orgCond);

      if (input.status) {
        conditions.push(eq(remoteSessions.status, input.status as typeof remoteSessions.status.enumValues[number]));
      }
      if (input.type) {
        conditions.push(eq(remoteSessions.type, input.type as typeof remoteSessions.type.enumValues[number]));
      }
      if (input.deviceId) {
        conditions.push(eq(remoteSessions.deviceId, input.deviceId as string));
      }

      const sessions = await db
        .select({
          id: remoteSessions.id,
          deviceHostname: devices.hostname,
          type: remoteSessions.type,
          status: remoteSessions.status,
          startedAt: remoteSessions.startedAt,
          endedAt: remoteSessions.endedAt,
          durationSeconds: remoteSessions.durationSeconds,
          bytesTransferred: remoteSessions.bytesTransferred,
        })
        .from(remoteSessions)
        .innerJoin(devices, eq(remoteSessions.deviceId, devices.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(remoteSessions.createdAt))
        .limit(limit);

      return JSON.stringify({ sessions, total: sessions.length });
    },
  });

  // ============================================
  // create_remote_session - Tier 3 (requires approval)
  // ============================================

  registerTool({
    tier: 3 as AiToolTier,
    definition: {
      name: 'create_remote_session',
      description: 'Create a new remote terminal or file transfer session to a device.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: {
            type: 'string',
            description: 'Device UUID to connect to',
          },
          type: {
            type: 'string',
            enum: ['terminal', 'file_transfer'],
            description: 'Session type',
          },
        },
        required: ['deviceId', 'type'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const sessionType = input.type as string;

      // Verify device access and require online status
      const access = await verifyDeviceAccess(deviceId, auth, true);
      if ('error' in access) return JSON.stringify({ error: access.error });

      // Insert new remote session
      const [session] = await db
        .insert(remoteSessions)
        .values({
          deviceId,
          userId: auth.user.id,
          type: sessionType as 'terminal' | 'file_transfer',
          status: 'pending',
        })
        .returning({ id: remoteSessions.id, status: remoteSessions.status });

      return JSON.stringify({
        id: session!.id,
        status: session!.status,
        deviceId,
        type: sessionType,
      });
    },
  });
}
