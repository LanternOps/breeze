import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import {
  commandResultSchema,
  securityCommandTypes,
  filesystemAnalysisCommandType,
  sensitiveDataCommandTypes,
  uuidRegex
} from './schemas';
import {
  handleSecurityCommandResult,
  handleFilesystemAnalysisCommandResult,
  handleSensitiveDataCommandResult,
  handleSoftwareRemediationCommandResult,
  handleCisCommandResult,
} from './helpers';
import { captureException } from '../../services/sentry';
import { processCollectedAuditPolicyCommandResult } from '../../services/auditBaselineService';
import { CommandTypes, queueCommandForExecution } from '../../services/commandQueue';

export const commandsRoutes = new Hono();

commandsRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('json', commandResultSchema),
  async (c) => {
    const commandId = c.req.param('commandId');
    const data = c.req.valid('json');
    const agent = c.get('agent') as { orgId?: string; agentId?: string; deviceId?: string } | undefined;
    const agentId = c.req.param('id');

    if (!agent?.deviceId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }

    // Commands dispatched directly over WebSocket can use non-UUID IDs and
    // intentionally have no device_commands row.
    if (!uuidRegex.test(commandId)) {
      return c.json({ success: true });
    }

    const [command] = await db
      .select()
      .from(deviceCommands)
      .where(
        and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.deviceId, agent.deviceId)
        )
      )
      .limit(1);

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    await db
      .update(deviceCommands)
      .set({
        status: data.status === 'completed' ? 'completed' : 'failed',
        completedAt: new Date(),
        result: {
          status: data.status,
          exitCode: data.exitCode,
          stdout: data.stdout,
          stderr: data.stderr,
          durationMs: data.durationMs,
          error: data.error
        }
      })
      .where(eq(deviceCommands.id, commandId));

    if (
      command.type === securityCommandTypes.collectStatus ||
      command.type === securityCommandTypes.scan ||
      command.type === securityCommandTypes.quarantine ||
      command.type === securityCommandTypes.remove ||
      command.type === securityCommandTypes.restore
    ) {
      try {
        await handleSecurityCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] security command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === filesystemAnalysisCommandType) {
      try {
        await handleFilesystemAnalysisCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] filesystem analysis post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (
      command.type === sensitiveDataCommandTypes.scan ||
      command.type === sensitiveDataCommandTypes.encrypt ||
      command.type === sensitiveDataCommandTypes.secureDelete ||
      command.type === sensitiveDataCommandTypes.quarantine
    ) {
      try {
        await handleSensitiveDataCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] sensitive data post-processing failed for ${commandId}:`, err);
      }
    }

    if (command.type === 'software_uninstall') {
      try {
        await handleSoftwareRemediationCommandResult(command, data);
      } catch (err) {
        const policyId = command.payload && typeof command.payload === 'object'
          ? (command.payload as Record<string, unknown>).policyId ?? 'unknown'
          : 'unknown';
        console.error(
          `[agents] software remediation post-processing failed for command ${commandId} ` +
          `(device ${command.deviceId}, policy ${policyId}) — device may be stuck in_progress:`,
          err
        );
        captureException(err);
      }
    }

    if (command.type === 'collect_audit_policy' && data.status === 'completed') {
      try {
        await processCollectedAuditPolicyCommandResult(command.deviceId, data.stdout);
      } catch (err) {
        console.error(`[agents] audit policy command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === CommandTypes.APPLY_AUDIT_POLICY_BASELINE && data.status === 'completed') {
      try {
        // Break out of the request-scoped transaction so the follow-up command
        // row is committed before the agent can submit its result.
        const collectResult = await runOutsideDbContext(() =>
          withSystemDbAccessContext(() =>
            queueCommandForExecution(
              command.deviceId,
              CommandTypes.COLLECT_AUDIT_POLICY,
              {},
              { preferHeartbeat: false }
            )
          )
        );
        if (!collectResult.command) {
          const errMsg = `failed to enqueue post-apply audit policy collection for ${commandId}: ${collectResult.error ?? 'unknown error'}`;
          console.error(`[agents] ${errMsg}`);
          captureException(new Error(errMsg));
        }
      } catch (err) {
        console.error(`[agents] post-apply verification enqueue failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === 'cis_benchmark' || command.type === 'apply_cis_remediation') {
      try {
        await handleCisCommandResult(command, data);
      } catch (err) {
        console.error(`[agents] CIS command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    writeAuditEvent(c, {
      orgId: agent?.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.command.result.submit',
      resourceType: 'device_command',
      resourceId: commandId,
      details: {
        commandType: command.type,
        status: data.status,
        exitCode: data.exitCode ?? null,
      },
      result: data.status === 'completed' ? 'success' : 'failure',
    });

    return c.json({ success: true });
  }
);
