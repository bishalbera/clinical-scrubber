/** MCP server hosting the approval-gated report release tool. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const REPORT_TOOL_NAME = 'generate_final_report';
export const REPORT_MCP_SERVER = 'clinical-report-release';
export const DEFAULT_MCP_PORT = Number(process.env.REPORT_SERVER_PORT) || 8791;

/**
 * Address the server binds to. Loopback by default, which is right when the harness
 * runs on this machine and wrong the moment it does not.
 */
export const REPORT_SERVER_HOST = process.env.REPORT_SERVER_HOST || '127.0.0.1';

/**
 * URL the harness is told to call.
 *
 * Separate from the bind address on purpose: a containerised or remote harness resolves
 * loopback inside its own network namespace, not this process's, so it needs an address
 * that is reachable from where it runs.
 */
export function reportServerUrl(): string {
  return process.env.REPORT_SERVER_URL || `http://${REPORT_SERVER_HOST}:${DEFAULT_MCP_PORT}/`;
}

const TOOLS = [
  {
    name: REPORT_TOOL_NAME,
    description:
      'Release the final research summary for distribution. Requires Chief Medical ' +
      'Officer approval of both the de-identification script and the statistical ' +
      'methodology. Call only after scrubbing and analysis have completed.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Report title.' },
        summary: {
          type: 'string',
          description: 'Aggregate-level summary. Must contain no patient-level values.',
        },
        methodology_approved: {
          type: 'boolean',
          description: 'Set true once scrub and analysis scripts have been presented for review.',
        },
      },
      required: ['title', 'summary'],
      // Marks the tool as a write for the default approval policy. The pipeline also
      // names it explicitly, so the gate does not depend on annotation handling.
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, title: 'Generate final report' },
  },
];

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Records what the tool was asked to release, for the CLI to display after approval. */
export interface ReleasedReport {
  title: string;
  summary: string;
  releasedAt: string;
}

const released: ReleasedReport[] = [];

export function releasedReports(): readonly ReleasedReport[] {
  return released;
}

function handle(request: JsonRpcRequest): Record<string, unknown> | undefined {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'clinical-report-release', version: '0.1.0' },
      };
    case 'notifications/initialized':
      return undefined;
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const params = (request.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (params.name !== REPORT_TOOL_NAME) {
        return { isError: true, content: [{ type: 'text', text: `Unknown tool ${params.name}` }] };
      }
      const args = params.arguments ?? {};
      const record: ReleasedReport = {
        title: String(args.title ?? 'Untitled'),
        summary: String(args.summary ?? ''),
        releasedAt: new Date().toISOString(),
      };
      released.push(record);
      return {
        content: [
          {
            type: 'text',
            text:
              `Report "${record.title}" released at ${record.releasedAt}. ` +
              `${record.summary.length} characters recorded.`,
          },
        ],
      };
    }
    default:
      return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Start the server. Resolves with a stop function. */
export async function startReportServer(
  port = DEFAULT_MCP_PORT,
  host = REPORT_SERVER_HOST,
): Promise<() => Promise<void>> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }

      let payload: JsonRpcRequest;
      try {
        payload = JSON.parse(await readBody(req)) as JsonRpcRequest;
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'parse error' },
          }),
        );
        return;
      }

      const result = handle(payload);

      // Notifications carry no id and expect no response body.
      if (payload.id === undefined || payload.id === null) {
        res.writeHead(202).end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: result ?? {} }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
