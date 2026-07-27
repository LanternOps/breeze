import { pathToFileURL } from 'node:url';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHANGE_TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

type DesktopFinalizationCliArgs =
  | {
      command: 'inspect';
      apiBaseUrl: string;
      sessionId: string;
      token: string;
    }
  | {
      command: 'reconcile';
      apiBaseUrl: string;
      sessionId: string;
      expectedFinalizationId: string;
      changeTicket: string;
      token: string;
    };

function parseOptions(argv: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('every CLI option requires one value');
    }
    if (options.has(name)) throw new Error(`duplicate option: ${name}`);
    options.set(name, value);
  }
  return options;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`missing required option: ${name}`);
  return value;
}

function uuid(value: string, name: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

function changeTicket(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length < 3
    || trimmed.length > 128
    || !CHANGE_TICKET_PATTERN.test(trimmed)
  ) {
    throw new Error('change ticket is invalid');
  }
  return trimmed;
}

export function parseDesktopFinalizationCliArgs(
  argv: string[],
  env: { BREEZE_OPERATOR_ACCESS_TOKEN?: string } = process.env,
): DesktopFinalizationCliArgs {
  const [command, ...rawOptions] = argv;
  if (command !== 'inspect' && command !== 'reconcile') {
    throw new Error('command must be inspect or reconcile');
  }
  const allowed = new Set([
    '--api-base-url',
    '--session-id',
    ...(command === 'reconcile'
      ? ['--expected-finalization-id', '--change-ticket']
      : []),
  ]);
  const options = parseOptions(rawOptions);
  for (const option of options.keys()) {
    if (!allowed.has(option)) throw new Error(`unsupported option: ${option}`);
  }

  const rawApiBaseUrl = required(options, '--api-base-url');
  const apiBaseUrl = new URL(rawApiBaseUrl);
  if (apiBaseUrl.protocol !== 'https:' && apiBaseUrl.hostname !== 'localhost') {
    throw new Error('base URL must use HTTPS');
  }
  if (
    apiBaseUrl.username
    || apiBaseUrl.password
    || apiBaseUrl.search
    || apiBaseUrl.hash
  ) {
    throw new Error('API base URL may not contain credentials, query, or fragment');
  }
  apiBaseUrl.pathname = apiBaseUrl.pathname.replace(/\/+$/, '');
  const token = env.BREEZE_OPERATOR_ACCESS_TOKEN;
  if (!token) {
    throw new Error('BREEZE_OPERATOR_ACCESS_TOKEN is required');
  }
  const common = {
    apiBaseUrl: apiBaseUrl.toString().replace(/\/$/, ''),
    sessionId: uuid(required(options, '--session-id'), 'session ID'),
    token,
  };
  if (command === 'inspect') return { command, ...common };
  return {
    command,
    ...common,
    expectedFinalizationId: uuid(
      required(options, '--expected-finalization-id'),
      'expected finalization ID',
    ),
    changeTicket: changeTicket(required(options, '--change-ticket')),
  };
}

export function buildDesktopFinalizationRequest(
  args: DesktopFinalizationCliArgs,
): { url: string; init: RequestInit } {
  const base =
    `${args.apiBaseUrl}/admin/desktop-finalizations/${args.sessionId}`;
  const headers = {
    authorization: `Bearer ${args.token}`,
    accept: 'application/json',
  };
  if (args.command === 'inspect') {
    return { url: base, init: { method: 'GET', headers } };
  }
  return {
    url: `${base}/reconcile`,
    init: {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedFinalizationId: args.expectedFinalizationId,
        changeTicket: args.changeTicket,
      }),
    },
  };
}

export function redactDesktopFinalizationCliError(
  error: unknown,
  token: string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.split(token).join('[REDACTED]') : message;
}

export async function runDesktopFinalizationCli(argv: string[]): Promise<number> {
  let token = '';
  try {
    const args = parseDesktopFinalizationCliArgs(argv);
    token = args.token;
    if (args.command === 'reconcile') {
      const inspectionRequest = buildDesktopFinalizationRequest({
        command: 'inspect',
        apiBaseUrl: args.apiBaseUrl,
        sessionId: args.sessionId,
        token: args.token,
      });
      const inspectionResponse = await fetch(
        inspectionRequest.url,
        inspectionRequest.init,
      );
      const inspectionBody = await inspectionResponse.text();
      if (!inspectionResponse.ok) {
        throw new Error(
          `Inspection HTTP ${inspectionResponse.status}: ${inspectionBody.slice(0, 2_000)}`,
        );
      }
      let inspection: unknown;
      try {
        inspection = JSON.parse(inspectionBody);
      } catch {
        throw new Error('Inspection returned invalid JSON');
      }
      if (
        !inspection
        || typeof inspection !== 'object'
        || Array.isArray(inspection)
        || (inspection as Record<string, unknown>).state !== 'persisted'
        || (inspection as Record<string, unknown>).finalizationId
          !== args.expectedFinalizationId
      ) {
        throw new Error('Inspection does not match the expected persisted finalization ID');
      }
    }
    const request = buildDesktopFinalizationRequest(args);
    const response = await fetch(request.url, request.init);
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 2_000)}`);
    process.stdout.write(`${body}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${redactDesktopFinalizationCliError(error, token)}\n`);
    return 1;
  }
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await runDesktopFinalizationCli(process.argv.slice(2));
}
