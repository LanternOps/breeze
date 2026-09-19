/**
 * Deny-mode measurement with the shared base prompt as a constant term.
 * After A-W02, compose BASE + renderToolIndexByDomain(listChatSurfaceToolNames())
 * + AI_SYSTEM_PROMPT_TAIL here as well.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AI_SYSTEM_PROMPT_BASE } from '../../aiAgentSystemPrompt';
import { createBreezeMcpServer, TOOL_TIERS } from '../../aiAgentSdkTools';
import { createScriptBuilderMcpServer, SCRIPT_BUILDER_MCP_TOOL_NAMES } from '../../scriptBuilderTools';
import { createStreamObserver, type StreamObservation } from './streamObserver';
import type { CaptureSurface, CaptureSurfaceId } from './surfaces';

export interface RunSurfaceOptions {
  surface: CaptureSurface;
  prompt: string;
  model: string;
  env: Record<string, string>;
  resume?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface SurfaceCaptureResult {
  surface: CaptureSurfaceId;
  registeredToolCount: number;
  allowedToolCount: number;
  observation: StreamObservation;
}

const denyAuth = () => { throw new Error('tool-capture: handlers never execute (deny mode)'); };

export async function runSurfaceCapture(opts: RunSurfaceOptions): Promise<SurfaceCaptureResult> {
  const { surface } = opts;
  const mcpServer = surface.server === 'breeze'
    ? createBreezeMcpServer(denyAuth, undefined, undefined, undefined, [], surface.onlyTools ? { onlyTools: surface.onlyTools } : undefined)
    : createScriptBuilderMcpServer(denyAuth);
  const registeredToolCount = surface.server === 'breeze'
    ? (surface.onlyTools ? surface.onlyTools.size : Object.keys(TOOL_TIERS).length)
    : SCRIPT_BUILDER_MCP_TOOL_NAMES.length;
  const observer = createStreamObserver();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 90_000);
  timer.unref();
  try {
    const session = query({
      prompt: opts.prompt,
      options: {
        systemPrompt: AI_SYSTEM_PROMPT_BASE,
        model: opts.model,
        maxTurns: opts.maxTurns ?? 2,
        tools: [],
        allowedTools: [...surface.allowedTools],
        mcpServers: { [surface.mcpServerName]: mcpServer },
        includePartialMessages: surface.includePartialMessages,
        canUseTool: async () => ({ behavior: 'deny', message: 'tool-capture harness: execution disabled' }),
        env: opts.env,
        resume: opts.resume,
        persistSession: true,
        settingSources: [],
        thinking: { type: 'disabled' },
        abortController: abort,
        stderr: (data: string) => observer.onStderr(data),
      },
    });
    for await (const message of session) observer.onMessage(message);
  } finally {
    clearTimeout(timer);
  }
  return { surface: surface.id, registeredToolCount, allowedToolCount: surface.allowedTools.length, observation: observer.finish() };
}
