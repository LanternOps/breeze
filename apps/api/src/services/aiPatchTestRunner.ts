import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const VALID_PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const VALID_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SSH_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunArgs {
  packageId: string;
  version: string;
}

export interface RunResult {
  result: 'pass' | 'fail' | 'inconclusive';
  notes: string;
  log: string;
}

export class ValidationError extends Error {}

function validateInputs(args: RunArgs) {
  if (!VALID_PACKAGE_ID.test(args.packageId)) {
    throw new ValidationError(`invalid packageId: ${args.packageId}`);
  }
  if (!VALID_VERSION.test(args.version)) {
    throw new ValidationError(`invalid version: ${args.version}`);
  }
}

function readVmEnv(): { target: string; sshKey: string } | null {
  const target = process.env.WIN_TEST_VM_TARGET;
  const sshKey = process.env.WIN_TEST_VM_SSH_KEY;
  if (!target || !sshKey) return null;
  return { target, sshKey };
}

async function runOnVm(
  target: string,
  sshKey: string,
  command: string
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'ssh',
      ['-i', sshKey, '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', target, command],
      { timeout: SSH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
    );
    return { stdout, stderr, code: 0 };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        code: typeof e.code === 'number' ? e.code : -1,
      };
    }
    throw err;
  }
}

async function analyzeWithClaude(input: {
  packageId: string;
  version: string;
  commands: string[];
  output: string;
}): Promise<{ result: 'pass' | 'fail' | 'inconclusive'; notes: string }> {
  // Dynamic import keeps the SDK out of the cold path when AI testing is disabled.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  const resp = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 512,
    system: [
      {
        type: 'text' as const,
        text:
          'You are a release-test analyst. Given a winget upgrade log, decide if the upgrade succeeded. ' +
          'Respond ONLY with valid JSON of the shape {"result":"pass"|"fail"|"inconclusive","notes":string}. ' +
          'No prose outside the JSON.',
        cache_control: { type: 'ephemeral' as const },
      },
    ],
    messages: [
      {
        role: 'user' as const,
        content: `Package: ${input.packageId}\nVersion: ${input.version}\nCommands run:\n${input.commands.join(
          '\n'
        )}\n\nOutput:\n${input.output.slice(0, 8000)}`,
      },
    ],
  });

  const textBlock = resp.content.find((b) => b.type === 'text');
  const raw = textBlock && textBlock.type === 'text' ? textBlock.text : '{}';
  try {
    const parsed = JSON.parse(raw) as { result: 'pass' | 'fail' | 'inconclusive'; notes?: string };
    if (parsed.result !== 'pass' && parsed.result !== 'fail' && parsed.result !== 'inconclusive') {
      return { result: 'inconclusive', notes: `unexpected verdict: ${raw.slice(0, 200)}` };
    }
    return { result: parsed.result, notes: parsed.notes ?? '' };
  } catch {
    return {
      result: 'inconclusive',
      notes: `failed to parse Claude response as JSON: ${raw.slice(0, 200)}`,
    };
  }
}

export async function runWingetReleaseTest(args: RunArgs): Promise<RunResult> {
  validateInputs(args);

  const env = readVmEnv();
  if (!env) {
    return {
      result: 'inconclusive',
      notes: 'WIN_TEST_VM_TARGET or WIN_TEST_VM_SSH_KEY missing - AI test skipped',
      log: '',
    };
  }

  const commands = [
    `winget upgrade --id ${args.packageId} --silent --accept-package-agreements --accept-source-agreements --disable-interactivity`,
  ];
  const installResult = await runOnVm(env.target, env.sshKey, commands[0]);
  const log = `exit=${installResult.code}\nstdout:\n${installResult.stdout}\nstderr:\n${installResult.stderr}`;

  let verdict: { result: 'pass' | 'fail' | 'inconclusive'; notes: string };
  try {
    verdict = await analyzeWithClaude({
      packageId: args.packageId,
      version: args.version,
      commands,
      output: log,
    });
  } catch (err) {
    verdict = {
      result: 'inconclusive',
      notes: `Claude analysis failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { result: verdict.result, notes: verdict.notes, log };
}
