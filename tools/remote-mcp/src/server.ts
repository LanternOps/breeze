/**
 * Remote MCP Server
 *
 * HTTP wrapper for claude-code-mcp that enables remote Claude Code access.
 * Runs on each test node (Windows, Linux, macOS) and exposes MCP tools over HTTP.
 *
 * Usage:
 *   npm start                    # Start server on default port 3100
 *   PORT=3200 npm start          # Start on custom port
 *   AUTH_TOKEN=secret npm start  # Require bearer token auth
 */

// Type declarations for express (outside workspace, types loaded at runtime)
interface ExpressRequest {
  headers: { authorization?: string };
  body: unknown;
  on(event: string, callback: () => void): void;
}

interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(data: string): void;
}

type ExpressNextFunction = () => void;

interface ExpressApplication {
  use(handler: unknown): void;
  get(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void): void;
  post(path: string, handler: (req: ExpressRequest, res: ExpressResponse) => void | Promise<void>): void;
  listen(port: number, host: string, callback: () => void): void;
}

interface ExpressStatic {
  (): ExpressApplication;
  json(options?: { limit?: string }): unknown;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const express = require('express') as ExpressStatic;
type Request = ExpressRequest;
type Response = ExpressResponse;
type NextFunction = ExpressNextFunction;
import { spawn, ChildProcess } from 'child_process';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.PORT || '3100', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN;

// Bearer token authentication middleware
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== AUTH_TOKEN) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }

  next();
}

app.use(authMiddleware);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    node: process.env.NODE_NAME || 'unknown',
  });
});

// MCP endpoint - forwards JSON-RPC requests to claude-code-mcp via stdio
app.post('/mcp', async (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const result = await forwardToMcp(req.body);
    console.log(`[MCP] Request completed in ${Date.now() - startTime}ms`);
    res.json(result);
  } catch (error) {
    console.error('[MCP] Error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : 'Internal error',
      },
      id: req.body?.id || null,
    });
  }
});

// SSE endpoint for streaming MCP (optional, for long-running operations)
app.get('/mcp/stream', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 30000);

  _req.on('close', () => {
    clearInterval(keepAlive);
  });
});

/**
 * Forward a JSON-RPC request to claude-code-mcp via stdio
 */
async function forwardToMcp(request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = 120000; // 2 minute timeout for Claude operations

    // Spawn claude-code-mcp process
    const mcpProcess: ChildProcess = spawn('npx', ['-y', '@steipete/claude-code-mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure Claude Code runs in non-interactive mode
        CI: 'true',
      },
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        mcpProcess.kill('SIGTERM');
        reject(new Error('MCP request timed out'));
      }
    }, timeout);

    mcpProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();

      // Try to parse complete JSON-RPC response
      try {
        const lines = stdout.split('\n').filter((line) => line.trim());
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.jsonrpc === '2.0' && (parsed.result !== undefined || parsed.error !== undefined)) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              mcpProcess.kill('SIGTERM');
              resolve(parsed);
            }
          }
        }
      } catch {
        // Not yet a complete JSON response, continue collecting
      }
    });

    mcpProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      console.error('[MCP stderr]', data.toString());
    });

    mcpProcess.on('error', (error: Error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        reject(error);
      }
    });

    mcpProcess.on('close', (code: number | null) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);

        if (code !== 0 && !stdout) {
          reject(new Error(`MCP process exited with code ${code}: ${stderr}`));
        } else if (stdout) {
          try {
            resolve(JSON.parse(stdout.trim().split('\n').pop() || '{}'));
          } catch {
            reject(new Error(`Failed to parse MCP response: ${stdout}`));
          }
        } else {
          reject(new Error('MCP process exited without response'));
        }
      }
    });

    // Send the request
    mcpProcess.stdin?.write(JSON.stringify(request) + '\n');
    mcpProcess.stdin?.end();
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  process.exit(0);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║           Breeze Remote MCP Server                        ║
╠═══════════════════════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(49)}║
║  Auth: ${AUTH_TOKEN ? 'Enabled (Bearer token)'.padEnd(49) : 'Disabled'.padEnd(49)}║
║  Node: ${(process.env.NODE_NAME || 'Not set').padEnd(49)}║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                               ║
║    GET  /health     - Health check                        ║
║    POST /mcp        - MCP JSON-RPC endpoint               ║
║    GET  /mcp/stream - SSE streaming (optional)            ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export { app };
