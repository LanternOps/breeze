import { describe, it, expect } from 'vitest';
import {
  AI_AGENT_RUN_DTO_SCHEMA_VERSION,
  AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS,
  type AiAgentRunDetailDto,
  type AiAgentRunTicketProposalDto,
  type AiAgentRunTraceEntryDto,
  type AlertAiVerdictSummaryDto,
  type AlertVerdictSuggestionReason,
} from './aiAgentRuns';

/**
 * Compile-time exhaustiveness check on the trace-entry union. If a fourth
 * variant is ever added to `AiAgentRunTraceEntryDto` without a matching
 * branch here, `x` narrows to something other than `never` and `tsc` fails
 * the assignment below — this function is never called at runtime, it only
 * has to type-check.
 */
function assertTraceEntryExhaustive(entry: AiAgentRunTraceEntryDto): string {
  switch (entry.kind) {
    case 'executed':
      return entry.tool;
    case 'proposed':
      return entry.tool;
    case 'denied':
      return entry.tool;
    default: {
      const neverEntry: never = entry;
      throw new Error(`unreachable: ${JSON.stringify(neverEntry)}`);
    }
  }
}

describe('AiAgentRunTraceEntryDto (leak-impossible union, #3828)', () => {
  it('exhausts all three variants at compile time (assertTraceEntryExhaustive type-checks)', () => {
    const executed: AiAgentRunTraceEntryDto = { kind: 'executed', tool: 'run_script', result: 'ok', durationMs: 120 };
    const proposed: AiAgentRunTraceEntryDto = { kind: 'proposed', tool: 'manage_services' };
    const denied: AiAgentRunTraceEntryDto = { kind: 'denied', tool: 'delete_file', reason: 'not allowlisted' };
    expect(assertTraceEntryExhaustive(executed)).toBe('run_script');
    expect(assertTraceEntryExhaustive(proposed)).toBe('manage_services');
    expect(assertTraceEntryExhaustive(denied)).toBe('delete_file');
  });

  it('has no field literally named args/toolInput/toolOutput/arguments/input/output on any sample variant', () => {
    const samples: AiAgentRunTraceEntryDto[] = [
      {
        kind: 'executed',
        tool: 'manage_services',
        action: 'restart',
        result: 'ok',
        durationMs: 340,
        execution: 'succeeded',
        verification: 'passed',
        verifyDetail: 'service running',
        actOpKey: 'manage_services.restart',
        actTargetName: 'wuauserv',
      },
      {
        kind: 'proposed',
        tool: 'run_script',
        action: 'invoke',
        intentId: '11111111-1111-4111-8111-111111111111',
        downgradeReason: 'missing identity field',
      },
      { kind: 'denied', tool: 'delete_registry_key', reason: 'protected resource' },
    ];
    for (const sample of samples) {
      const keys = Object.keys(sample);
      for (const forbidden of [...AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS, 'input', 'output']) {
        expect(keys).not.toContain(forbidden);
      }
      // Belt + suspenders: the serialized form must not contain the forbidden
      // substrings either (catches a forbidden key nested one level down).
      const json = JSON.stringify(sample);
      for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
        expect(json).not.toContain(`"${forbidden}"`);
      }
    }
  });
});

describe('AiAgentRunTicketProposalDto (phase 2 P2-4, #4191) — safe projection, no autonomous notes', () => {
  it('accepts the minimal shape (version + summary) and the full shape', () => {
    const minimal: AiAgentRunTicketProposalDto = { version: 1, summary: 'Investigated printer spooler crash.' };
    const full: AiAgentRunTicketProposalDto = {
      version: 1,
      summary: 'Spooler service was stuck; a restart resolved it in shadow-mode analysis.',
      fields: {
        categoryId: { value: '11111111-1111-4111-8111-111111111111', confidence: 0.9 },
        priority: { value: 'normal', confidence: 0.8 },
      },
      device: { hostname: 'WKS-042' },
      draftReply: 'Hi — this looks like a stuck print spooler. We recommend a restart.',
      draftResolutionNote: 'Restarted the print spooler service; issue resolved.',
      notes: ['Spooler.exe was consuming 100% CPU', 'No related alerts in the last 24h'],
      intentIds: ['22222222-2222-4222-8222-222222222222'],
      draftsWritten: [{ kind: 'reply', draftId: '33333333-3333-4333-8333-333333333333' }],
    };
    expect(minimal.notes).toBeUndefined();
    expect(full.draftReply).toContain('spooler');
    expect(full.draftsWritten?.[0]?.kind).toBe('reply');
  });

  it('has no field literally named args/toolInput/toolOutput/arguments on the DTO — it is text-only, never a tool payload', () => {
    const sample: AiAgentRunTicketProposalDto = {
      version: 1,
      summary: 'x',
      draftReply: 'y',
      notes: ['n'],
      intentIds: ['11111111-1111-4111-8111-111111111111'],
    };
    const keys = Object.keys(sample);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('AiAgentRunDetailDto carries ticketProposal as nullable (absent for a non-ticket run)', () => {
    const detail: Pick<AiAgentRunDetailDto, 'ticketProposal'> = { ticketProposal: null };
    expect(detail.ticketProposal).toBeNull();
  });

  it('AiAgentRunDetailDto carries anomalyIncidentId as nullable (wave 6 PR 4, #3828)', () => {
    const detail: Pick<AiAgentRunDetailDto, 'anomalyIncidentId'> = { anomalyIncidentId: null };
    expect(detail.anomalyIncidentId).toBeNull();
    const withIncident: Pick<AiAgentRunDetailDto, 'anomalyIncidentId'> = { anomalyIncidentId: 'incident-1' };
    expect(withIncident.anomalyIncidentId).toBe('incident-1');
  });
});

describe('AlertAiVerdictSummaryDto (P2-1 Task 14 — alert list/detail aiVerdict)', () => {
  it('is a nullable-field-friendly, leak-impossible display projection', () => {
    const populated: AlertAiVerdictSummaryDto = {
      id: 'verdict-1',
      classification: 'actionable',
      confidence: 0.87,
      rationale: 'Disk usage climbing steadily with no recovery.',
      patternKind: 'daily',
      feedback: 'up',
      suggestedIntentId: 'intent-1',
      createdAt: '2026-09-22T10:00:00.000Z',
    };
    const absent: AlertAiVerdictSummaryDto | null = null;

    expect(populated.confidence).toBe(0.87);
    expect(absent).toBeNull();
    const keys = Object.keys(populated);
    for (const forbidden of AI_AGENT_RUN_LEAK_TRIPWIRE_KEYS) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('carries the new superseded_concurrently reason (carry-in C, live-verdict partial unique)', () => {
    const reason: AlertVerdictSuggestionReason = 'superseded_concurrently';
    expect(reason).toBe('superseded_concurrently');
  });
});

describe('AI_AGENT_RUN_DTO_SCHEMA_VERSION', () => {
  it('is the literal 1', () => {
    expect(AI_AGENT_RUN_DTO_SCHEMA_VERSION).toBe(1);
  });

  it('stamps every DTO sample with schemaVersion: 1', () => {
    const detail: Pick<AiAgentRunDetailDto, 'schemaVersion'> = { schemaVersion: AI_AGENT_RUN_DTO_SCHEMA_VERSION };
    expect(detail.schemaVersion).toBe(1);
  });
});
