/**
 * `list_operator_tasks` and `get_operator_task` (full-control W10, #6780): the
 * AI twins of GET /ai/operator/tasks and GET /ai/operator/tasks/:id.
 *
 * Tier 1, read-only, denied to headless agents (`AGENT_DENIED_READ_TOOLS`):
 * `objective`, `handoffSummary`, `outcomeDetail` and step / event text are free
 * text written by humans and by other agent runs.
 *
 * The queries are the routes' own (services/aiOperator/taskReadQueries.ts).
 * The OUTPUT is not the route's: every shape below is an explicit allow-list
 * projection, so a field added to a REST DTO later reaches the model only when
 * someone decides it should. What it deliberately drops (plan fact 3, quorum
 * QW1): every pointer to the one-time credential reveal — `accounts[].intentId`
 * / revealer / window, `operations[].intentId` and `executionRef`, plan
 * `intentId`, the wait dependency id, a target account's external and
 * connection ids — plus user ids and the Wisp grantor. A created account
 * reduces to `{ provider, principalLabel, credentialState }`.
 *
 * Site- or device-restricted sessions get nothing: a device-less root task can
 * carry device targets in its graph, and the REST gate only checks the root
 * (plan fact 5, quorum QW2).
 */
import type {
  AiOperatorPlanApprovalDto,
  AiOperatorTaskListItemDto,
  AiOperatorTaskState,
} from '@breeze/shared';
import { AI_OPERATOR_TASK_STATES } from '@breeze/shared';
import type { AiTool } from './aiTools';
import { listOperatorTasks, loadOperatorTaskDetail, type OperatorTaskDetail } from './aiOperator/taskReadQueries';
import { bounded, clampInt, jsonError, notFound, restrictedReadDenied, str, thrown } from './aiToolsAiReadsShared';

const TASK = 'Task';

export function projectTaskListItem(task: AiOperatorTaskListItemDto) {
  return {
    id: task.id,
    orgId: task.orgId,
    agent: { kind: task.agent.kind, name: task.agent.name },
    workflowKey: task.workflowKey,
    workflowVersion: task.workflowVersion,
    mode: task.mode,
    originKind: task.originKind,
    objective: task.objective,
    target: {
      deviceId: task.target.deviceId,
      label: task.target.label,
      detachedAt: task.target.detachedAt,
      detachedReason: task.target.detachedReason,
    },
    state: task.state,
    phase: task.phase,
    waitReason: task.waitReason,
    // The kind only: the id of an approval / intent dependency is a pointer the model has no use for.
    waitDependencyKind: task.waitDependency?.kind ?? null,
    revision: task.revision,
    attemptOrdinal: task.attemptOrdinal,
    currentStepKey: task.currentStepKey,
    deadlineAt: task.deadlineAt,
    nextWakeAt: task.nextWakeAt,
    outcome: task.outcome,
    outcomeDetail: task.outcomeDetail,
    handoffSummary: task.handoffSummary,
    successorOfTaskId: task.successorOfTaskId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    nextAction: task.nextAction,
  };
}

function projectPlan(plan: AiOperatorPlanApprovalDto[]) {
  return plan.map((approval) => ({
    id: approval.id,
    planRevision: approval.planRevision,
    effectCount: approval.effectCount,
    state: approval.state,
    approvedAt: approval.approvedAt,
    supersededByRevision: approval.supersededByRevision,
    createdAt: approval.createdAt,
    effects: approval.effects.map((effect) => ({
      ordinal: effect.ordinal,
      toolName: effect.toolName,
      provider: effect.provider,
      targetLabel: effect.targetLabel,
      principalLabel: effect.principalLabel,
      rendering: effect.rendering,
      idempotencyClass: effect.idempotencyClass,
      operationState: effect.operationState,
      noop: effect.noop,
    })),
  }));
}

export function projectTaskDetail(task: OperatorTaskDetail) {
  const dto = task;
  return {
    ...projectTaskListItem(dto),
    operations: dto.operations.map((op) => ({
      operationKey: op.operationKey,
      attemptOrdinal: op.attemptOrdinal,
      dispatchState: op.dispatchState,
      resultState: op.resultState,
      dispatchedAt: op.dispatchedAt,
      resultAt: op.resultAt,
    })),
    runs: dto.runs.map((run) => ({
      id: run.id,
      status: run.status,
      attemptOrdinal: run.attemptOrdinal,
      promptVersion: run.promptVersion,
      resolvedModel: run.resolvedModel,
    })),
    targets: dto.targets.map((target) => ({
      id: target.id,
      targetKind: target.targetKind,
      deviceId: target.deviceId,
      ticketId: target.ticketId,
      contactId: target.contactId,
      label: target.label,
      ordinal: target.ordinal,
      state: target.state,
      detachedAt: target.detachedAt,
      detachedReason: target.detachedReason,
      accounts: target.accounts.map((account) => ({ provider: account.provider, principalLabel: account.principalLabel })),
    })),
    steps: dto.steps.map((step) => ({
      id: step.id,
      stepKey: step.stepKey,
      stepKind: step.stepKind,
      targetId: step.targetId,
      attemptOrdinal: step.attemptOrdinal,
      state: step.state,
      planRevision: step.planRevision,
      expectedCriterion: step.expectedCriterion,
      dependencyKind: step.dependency?.kind ?? null,
      detail: step.detail,
      startedAt: step.startedAt,
      settledAt: step.settledAt,
    })),
    events: dto.events.map((event) => ({
      id: event.id,
      transitionSeq: event.transitionSeq,
      eventType: event.eventType,
      actorKind: event.actorKind,
      stepKey: event.stepKey,
      targetId: event.targetId,
      detail: event.detail,
      createdAt: event.createdAt,
    })),
    plan: projectPlan(dto.plan ?? []),
    ...(dto.accounts
      ? { accounts: dto.accounts.map((a) => ({ provider: a.provider, principalLabel: a.principalLabel, credentialState: a.credentialState })) }
      : {}),
  };
}

export function registerOperatorTaskReadTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_operator_tasks', {
    tier: 1,
    domain: 'ai',
    searchHint: 'AI operator tasks, workflows the AI is running or finished, tasks waiting on approval or a device, task state',
    // The device filter is checked by the executor like any other device argument; restricted sessions never reach it (refused below).
    deviceArgs: ['device_id'],
    definition: {
      name: 'list_operator_tasks',
      description:
        'List AI operator tasks (multi-step workflows the AI runs for you), newest first, with state, objective, target and what happens next. Organization-wide: not available to site-restricted sessions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          device_id: { type: 'string', description: 'Only tasks targeting this device UUID' },
          state: { type: 'string', enum: [...AI_OPERATOR_TASK_STATES], description: 'Only tasks in this state' },
          limit: { type: 'number', description: 'Max results (default 25, max 50)' },
          cursor: { type: 'string', description: 'nextCursor from a previous call with the same filters' },
        },
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const denied = restrictedReadDenied(auth, 'Operator tasks');
      if (denied) return denied;
      try {
        const limit = clampInt(input.limit, 25, 50);
        const result = await listOperatorTasks(auth, {
          cursorToken: str(input.cursor),
          limit,
          deviceId: str(input.device_id),
          state: str(input.state) as AiOperatorTaskState | undefined,
        });
        if (!result.ok) return jsonError('cursor is not a nextCursor value from a previous call', 'CURSOR_INVALID');
        return bounded({
          tasks: result.data.map(projectTaskListItem),
          showing: result.data.length,
          limit,
          hasMore: result.nextCursor !== null,
          nextCursor: result.nextCursor,
        });
      } catch (error) {
        return thrown('list_operator_tasks', error);
      }
    },
  });

  aiTools.set('get_operator_task', {
    tier: 1,
    domain: 'ai',
    searchHint: 'one AI operator task in detail: steps, events, plan, operations, linked runs, why it is waiting',
    deviceArgs: [],
    definition: {
      name: 'get_operator_task',
      description:
        'One AI operator task: objective, state, targets, steps, event timeline (newest 500), the plan it proposed and linked agent runs. Credential hand-over details are never shown; created accounts show only a credential state.',
      input_schema: {
        type: 'object' as const,
        properties: {
          taskId: { type: 'string', description: 'Operator task UUID' },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const denied = restrictedReadDenied(auth, 'Operator tasks');
      if (denied) return denied;
      const taskId = str(input.taskId);
      if (!taskId) return jsonError('taskId is required', 'VALIDATION_ERROR');
      try {
        const task = await loadOperatorTaskDetail(auth, taskId);
        if (!task) return notFound(TASK);
        const full = projectTaskDetail(task);
        const text = JSON.stringify(full);
        if (text.length <= 96 * 1024) return text;
        // A very long task: keep the newest events and the first steps, and say so rather than refuse.
        return bounded({ ...full, events: full.events.slice(-100), steps: full.steps.slice(0, 100), truncated: true });
      } catch (error) {
        return thrown('get_operator_task', error);
      }
    },
  });
}
