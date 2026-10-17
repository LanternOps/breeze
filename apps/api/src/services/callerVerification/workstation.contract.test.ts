/**
 * Caller verification W02 (#6354) registration contract. Fails when a piece
 * of the workstation wire is unregistered on one side: both API transports,
 * the shared registry, the worker registry, the agent handler, the IPC names
 * and the helper's capability frame and window guard.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const repo = '../../../../../';

describe('workstation tier registrations', () => {
  it('both API transports reach the one shared handler', () => {
    expect(source('../../routes/agents/commands.ts')).toMatch(/REGISTRY_DISPATCHED_COMMAND_TYPES = new Set\(\[[\s\S]*?'caller_verify'[\s\S]*?\]\);/);
    expect(source('../commandResultHandlers.ts')).toContain('caller_verify: handleCallerVerifyResult');
    // Late "not me" paths on both transports.
    expect(source('../../routes/agents/commands.ts')).toContain('persistCallerNotMeReceipt');
    expect(source('../../routes/agentWs.ts')).toContain('applyLateCallerVerifyRejection');
  });

  it('the reconciliation worker is registered and declared ready', () => {
    expect(source('../workerRegistry.ts')).toContain("name: 'callerVerificationReconciliation'");
    expect(source('../../jobs/workerReadinessManifest.ts')).toContain("consumers('callerVerificationReconciliation')");
  });

  it('the agent registers caller_verify and selects only a capable console Assist helper', () => {
    expect(source(`${repo}agent/internal/heartbeat/caller_verify.go`)).toContain('handlerRegistry[cmdCallerVerify] = handleCallerVerify');
    const selection = source(`${repo}agent/internal/sessionbroker/caller_verify.go`);
    expect(selection).toContain('ipc.HelperRoleAssist');
    expect(selection).toContain('ipc.ScopeConsentUI');
    expect(selection).toContain('caps.CallerVerify');
    for (const forbidden of ['SessionForUser(', 'PreferredSessionWithScope(', 'ScopeConsentUIFallback', 'consentUISessionForTarget']) {
      expect(selection).not.toContain(forbidden);
    }
  });

  it('the IPC and capability names match on agent and helper', () => {
    const ipc = source(`${repo}agent/internal/ipc/caller_verify.go`);
    expect(ipc).toContain('TypeCallerVerifyRequest  = "caller_verify_request"');
    expect(ipc).toContain('TypeCallerVerifyResponse = "caller_verify_response"');
    expect(source(`${repo}agent/internal/ipc/message.go`)).toContain('json:"callerVerify"');
    const client = source(`${repo}apps/helper/src-tauri/src/ipc/client.rs`);
    expect(client).toContain('"caller_verify_request"');
    expect(client).toContain('"caller_verify_response"');
    expect(client).toContain('Capabilities { caller_verify: true }');
    expect(source(`${repo}apps/helper/src-tauri/src/lib.rs`)).toContain('label_matches(window.label(), &verification_id)');
    expect(source(`${repo}apps/helper/src-tauri/capabilities/default.json`)).toContain('"caller-verify-*"');
  });
});
