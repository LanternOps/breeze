// Phase 3 stub: replaced with a real sender by the MCP bootstrap plan, Task 3.x.
// Kept here so `create_tenant` (Task 2.2) can import the symbol at build time
// while callers mock it in tests. The unmocked runtime path intentionally throws
// until Phase 3 wires up the real transactional-email transport.

export interface SendActivationEmailArgs {
  to: string;
  rawToken: string;
  partnerId: string;
}

export async function sendActivationEmail(_args: SendActivationEmailArgs): Promise<void> {
  throw new Error(
    'sendActivationEmail not implemented yet — wire up the real sender in Phase 3 (MCP bootstrap plan).',
  );
}
