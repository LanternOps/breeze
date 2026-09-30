/**
 * AI tools that read stored device data by default and reach the device only
 * when a boolean input asks for fresh data.
 *
 * Sending a live command to a device to read its state requires an
 * execute-level permission; stored data stays on read. For these tools the
 * live request is not an `action` string, so the (tool, action) tier and
 * permission tables in aiGuardrails.ts cannot tell the two apart. This table
 * names the input that does, and `requestsLiveDeviceRead` is the one
 * predicate the guardrails (tier + permission) and the tool handlers all ask,
 * so the handler can never reach the device on an input the guardrails
 * classified as a stored read.
 *
 * A leaf module (no imports) on purpose: aiGuardrails.ts imports the tool
 * registry, so the tool files cannot import aiGuardrails.ts back.
 */
export const LIVE_READ_INPUT_FLAGS: Readonly<Record<string, string>> = {
  // POST /devices/:id/filesystem/scan sends the same filesystem_analysis command.
  analyze_disk_usage: 'refresh',
  // POST /devices/:id/collect-boot-metrics sends the same collect_boot_performance command.
  analyze_boot_performance: 'triggerCollection',
};

/**
 * True when this call asks the device for fresh data. Strict `=== true`: the
 * input schemas type these flags as booleans, and anything else is a stored
 * read, in the guardrails and in the handler alike.
 */
export function requestsLiveDeviceRead(toolName: string, input: Record<string, unknown>): boolean {
  const flag = LIVE_READ_INPUT_FLAGS[toolName];
  return flag !== undefined && input[flag] === true;
}
