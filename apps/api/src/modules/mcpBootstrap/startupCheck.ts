const REQUIRED_ENVS = [
  'STRIPE_SECRET_KEY',
  'BREEZE_BILLING_URL',
  'EMAIL_PROVIDER_KEY',
  'PUBLIC_ACTIVATION_BASE_URL',
];

export function checkMcpBootstrapStartup(): void {
  const missing = REQUIRED_ENVS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `MCP_BOOTSTRAP_ENABLED is true but required env vars are missing: ${missing.join(', ')}. ` +
      `Either set these vars or set MCP_BOOTSTRAP_ENABLED=false.`
    );
  }
}
