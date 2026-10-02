/**
 * Shared types for an agent policy's model binding (AI model registry W03,
 * W05 #7603, W08 #7606). A policy binds to a registry OFFERING at write time
 * (agentOfferingBinding.ts); the policy `model` string, and the string-lookup
 * path that bound it, were retired in W08 — a write naming `model` is rejected
 * by the validator with a pointer to `offeringId`.
 *
 * The run-time resolver re-checks the bound offering against the `ai_agents`
 * permitted set at admission and dispatch, because that set can narrow after
 * the write.
 */
export { AgentModelNotAllowedError } from './agentModelErrors';
export type { AgentPolicyWriter } from './agentOfferingBinding';

/** The owner of an agent row (`ai_agents` is org XOR partner owned). */
export interface AgentModelOwner {
  orgId: string | null;
  partnerId: string | null;
}

export interface AgentModelBinding {
  offeringId: string | null;
  offeringPartnerId: string | null;
}
