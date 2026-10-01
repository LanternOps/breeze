// AI model registry (#7598) hub. Import from the specific module in hot or
// pure code (aiModel.ts, aiCostTracker.ts, wire-option call sites): this hub
// also re-exports platformModels.ts, which loads the database module.
export * from './capabilities';
export * from './wireParams';
export * from './pricing';
export * from './platformModelSnapshot';
export * from './platformModelAdmin';
export * from './platformModels';
export * from './modelWireOptions';
export * from './discovery';
export * from './connections';
export * from './offerings';
export * from './registryWriteErrors';
export * from './offeringWrites';
export * from './assignmentWrites';
export * from './residency';
export * from './connectionSettings';
export * from './assignments';
export * from './legacyProjection';
export * from './legacyReconcile';
export * from './legacyCostEvents';
export { recordInvocation, registerInvocationLedgerShadow, recordShadowInvocation, surfaceFromSession, buildShadowRateSnapshot, shadowCostDiff, type NewInvocation } from './invocationLedger';
export {
  resolveModel,
  unavailableMessage,
  PLATFORM_ONLY_SURFACES,
  type ResolveModelInput,
  type ResolveModelResult,
  type ResolvedModel,
  type ModelUnavailable,
  type ResolvedOffering,
  type ResolvedRefusalFallback,
  type RequestOrigin,
} from './resolveModel';
export { defaultTransport, transportCarries, type DispatchTransport, type TransportCarriage } from './transport';
export type { ResolveFailureReason } from './eligibility';
