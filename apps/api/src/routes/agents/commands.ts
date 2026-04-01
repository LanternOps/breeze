import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
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
import { applyVaultSyncCommandResult } from '../../services/vaultSyncPersistence';
import { processBackupVerificationResult } from '../backup/verificationService';
import { updateRestoreJobByCommandId } from '../../services/restoreResultPersistence';
import { detectResultValidationFamily, validateCriticalCommandResult, DR_COMMAND_TYPES } from '../../services/agentCommandResultValidation';

export const commandsRoutes = new Hono();
const ACCEPTED_COMMAND_RESULT_STATUSES = ['pending', 'sent'] as const;

function commandResultToStdout(data: z.infer<typeof commandResultSchema>): string | undefined {
  return data.stdout ??
    (data.result !== undefined ? JSON.stringify(data.result) : undefined);
}

function buildStoredCommandResult(data: z.infer<typeof commandResultSchema>, stdout: string | undefined) {
  return {
    status: data.status,
    exitCode: data.exitCode,
    stdout,
    stderr: data.stderr,
    durationMs: data.durationMs,
    error: data.error,
  };
}

function normalizeCriticalResultIfNeeded(
  commandType: string,
  commandId: string,
  data: z.infer<typeof commandResultSchema>
) {
  if (!detectResultValidationFamily(commandType)) {
    return {
      normalizedData: data,
      stdout: commandResultToStdout(data),
      validationError: null as string | null,
    };
  }

  try {
    const validated = validateCriticalCommandResult(commandType, {
      commandId,
      status: data.status,
      exitCode: data.exitCode,
      stdout: data.stdout,
      stderr: data.stderr,
      durationMs: data.durationMs,
      error: data.error,
      result: data.result,
    });

    if (!validated) {
      return {
        normalizedData: data,
        stdout: commandResultToStdout(data),
        validationError: null as string | null,
      };
    }

    const stdout = validated.normalizedStdout ?? data.stdout;
    return {
      normalizedData: {
        ...data,
        stdout,
        result: validated.structuredResult,
      },
      stdout,
      validationError: null as string | null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown validation error';
    return {
      normalizedData: {
        ...data,
        status: 'failed' as const,
        error: `Rejected malformed ${commandType} result: ${message}`,
      },
      stdout: commandResultToStdout(data),
      validationError: `Rejected malformed ${commandType} result: ${message}`,
    };
  }
}

const commandResultParamSchema = z.object({
  id: z.string().uuid(),
  commandId: z.string().min(1),
});

commandsRoutes.post(
  '/:id/commands/:commandId/result',
  zValidator('param', commandResultParamSchema),
  zValidator('json', commandResultSchema),
  async (c) => {
    const { id: agentId, commandId } = c.req.valid('param');
    const data = c.req.valid('json');
    const agent = c.get('agent') as { orgId?: string; agentId?: string; deviceId?: string } | undefined;

    if (!agent?.deviceId) {
      return c.json({ error: 'Agent context not found' }, 401);
    }

    const deviceId = agent.deviceId;

    // Commands dispatched directly over WebSocket can use non-UUID IDs and
    // intentionally have no device_commands row.
    if (!uuidRegex.test(commandId)) {
      return c.json({ success: true });
    }

    // Query device_commands OUTSIDE the agentAuth transaction.
    // device_commands has no RLS; querying via the pool (auto-commit)
    // guarantees visibility of recently committed rows.
    const [command] = await runOutsideDbContext(() =>
      db
        .select()
        .from(deviceCommands)
        .where(
          and(
            eq(deviceCommands.id, commandId),
            eq(deviceCommands.deviceId, deviceId)
          )
        )
        .limit(1)
    );

    if (!command) {
      return c.json({ error: 'Command not found' }, 404);
    }

    if (
      command.status &&
      !ACCEPTED_COMMAND_RESULT_STATUSES.includes(command.status as typeof ACCEPTED_COMMAND_RESULT_STATUSES[number])
    ) {
      return c.json({ success: true });
    }

    const {
      normalizedData,
      stdout,
      validationError,
    } = normalizeCriticalResultIfNeeded(command.type, commandId, data);

    const updated = await runOutsideDbContext(async () => {
      const query = db
        .update(deviceCommands)
        .set({
          status: normalizedData.status === 'completed' ? 'completed' : 'failed',
          completedAt: new Date(),
          result: buildStoredCommandResult(normalizedData, stdout)
        })
        .where(and(
          eq(deviceCommands.id, commandId),
          eq(deviceCommands.deviceId, deviceId),
          inArray(deviceCommands.status, ACCEPTED_COMMAND_RESULT_STATUSES)
        )) as any;

      return typeof query.returning === 'function'
        ? query.returning({ id: deviceCommands.id })
        : query;
    });

    const updatedRows = Array.isArray(updated)
      ? updated
      : [];

    if (updated === undefined) {
      console.warn(`[agents] command result update returned undefined for ${commandId} — treating as failed update`);
    }

    if (updatedRows.length === 0) {
      return c.json({ success: true });
    }

    if (validationError) {
      console.warn(`[agents] ${validationError}`);
      return c.json({ success: true });
    }

    if (
      command.type === securityCommandTypes.collectStatus ||
      command.type === securityCommandTypes.scan ||
      command.type === securityCommandTypes.quarantine ||
      command.type === securityCommandTypes.remove ||
      command.type === securityCommandTypes.restore
    ) {
      try {
        await handleSecurityCommandResult(command, normalizedData);
      } catch (err) {
        console.error(`[agents] security command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === filesystemAnalysisCommandType) {
      try {
        await handleFilesystemAnalysisCommandResult(command, normalizedData);
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
        await handleSensitiveDataCommandResult(command, normalizedData);
      } catch (err) {
        console.error(`[agents] sensitive data post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === 'software_uninstall') {
      try {
        await handleSoftwareRemediationCommandResult(command, normalizedData);
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

    if (command.type === 'collect_audit_policy' && normalizedData.status === 'completed') {
      try {
        await processCollectedAuditPolicyCommandResult(command.deviceId, stdout);
      } catch (err) {
        console.error(`[agents] audit policy command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === CommandTypes.APPLY_AUDIT_POLICY_BASELINE && normalizedData.status === 'completed') {
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
        await handleCisCommandResult(command, normalizedData);
      } catch (err) {
        console.error(`[agents] CIS command post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === 'backup_verify' || command.type === 'backup_test_restore') {
      try {
        await processBackupVerificationResult(commandId, {
          status: normalizedData.status,
          stdout,
          error: normalizedData.error,
        });
      } catch (err) {
        console.error(`[agents] backup verification post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === 'vm_restore_from_backup' || command.type === 'vm_instant_boot') {
      try {
        await updateRestoreJobByCommandId({
          commandId,
          deviceId: command.deviceId,
          commandType: command.type,
          result: normalizedData,
        });
      } catch (err) {
        console.error(`[agents] restore job post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (command.type === CommandTypes.VAULT_SYNC) {
      try {
        await applyVaultSyncCommandResult({
          deviceId: command.deviceId,
          command,
          resultStatus: normalizedData.status,
          stdout,
          stderr: normalizedData.stderr,
          error: normalizedData.error,
        });
      } catch (err) {
        console.error(`[agents] vault sync post-processing failed for ${commandId}:`, err);
        captureException(err);
      }
    }

    if (DR_COMMAND_TYPES.has(command.type)) {
      try {
        const commandPayload =
          command.payload && typeof command.payload === 'object' && !Array.isArray(command.payload)
            ? command.payload as Record<string, unknown>
            : {};
        if (typeof commandPayload.drExecutionId === 'string') {
          const { handleDrCommandResult } = await import('../backup/drResultHandler');
          await handleDrCommandResult({
            commandId,
            commandType: command.type,
            deviceId: command.deviceId,
            status: normalizedData.status,
            result: normalizedData.result,
            payload: commandPayload,
          });

          const { enqueueDrExecutionReconcile } = await import('../../jobs/drExecutionWorker');
          await enqueueDrExecutionReconcile(commandPayload.drExecutionId);
        }
      } catch (err) {
        console.error(`[agents] DR command post-processing failed for ${commandId}:`, err);
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
        status: normalizedData.status,
        exitCode: normalizedData.exitCode ?? null,
      },
      result: normalizedData.status === 'completed' ? 'success' : 'failure',
    });

    return c.json({ success: true });
  }
);
