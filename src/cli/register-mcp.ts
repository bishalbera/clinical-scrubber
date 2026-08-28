/**
 * One-time setup. TrueForge only accepts `remote` MCP servers addressed by URL, so the
 * gated tool has to be registered before an agent can be given it.
 */

import { assertHarnessReachable, readRunConfig } from '../lib/client.js';
import { DEFAULT_MCP_PORT, REPORT_MCP_SERVER } from '../mcp/report-server.js';

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  await assertHarnessReachable(runConfig);

  const manifest = {
    type: 'remote',
    name: REPORT_MCP_SERVER,
    url: `http://127.0.0.1:${DEFAULT_MCP_PORT}/`,
    description: 'Releases the final clinical research summary. Gated on CMO approval.',
  };

  const response = await fetch(`${runConfig.baseUrl}/api/v1/settings/mcp-servers`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      ...(runConfig.token ? { Authorization: `Bearer ${runConfig.token}` } : {}),
    },
    body: JSON.stringify({ manifest }),
  });

  if (!response.ok) {
    throw new Error(`Registration failed: ${response.status} ${await response.text()}`);
  }
  console.log(`Registered MCP server "${REPORT_MCP_SERVER}" at ${manifest.url}`);
  console.log('It only answers while `pnpm review` is running, which starts it in-process.');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
