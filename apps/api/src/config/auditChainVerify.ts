/** Shared by consumer initialization and readiness declaration. Read at call time. */
export function auditChainVerifyEnabled(): boolean {
  const raw = process.env.AUDIT_CHAIN_VERIFY_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}
