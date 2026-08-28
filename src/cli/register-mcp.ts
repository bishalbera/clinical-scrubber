/**
 * One-time setup. TrueForge only accepts `remote` MCP servers addressed by URL, so the
 * gated tool has to be registered before an agent can be given it.
 */

import { assertHarnessReachable, readRunConfig } from '../lib/client.js';
import { REPORT_MCP_SERVER, reportServerUrl, startReportServer } from '../mcp/report-server.js';

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  await assertHarnessReachable(runConfig);

  const manifest = {
    type: 'remote',
    name: REPORT_MCP_SERVER,
    url: reportServerUrl(),
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

  // Registration succeeding proves nothing about reachability: the harness dials this
  // URL from wherever it runs, which is not necessarily from here.
  const stop = await startReportServer();
  try {
    const probe = await fetch(
      `${runConfig.baseUrl}/api/v1/mcp-servers/${REPORT_MCP_SERVER}/tools`,
      { headers: runConfig.token ? { Authorization: `Bearer ${runConfig.token}` } : {} },
    );
    const body = await probe.text();
    if (probe.ok && body.includes('generate_final_report')) {
      console.log('The harness reached it and can see generate_final_report.');
    } else {
      console.error(
        `\nThe harness could not enumerate the tool (${probe.status}).\n` +
          `It dials ${manifest.url} from its own network. If the harness is remote or\n` +
          'containerised, set REPORT_SERVER_URL to an address reachable from there, and\n' +
          'REPORT_SERVER_HOST=0.0.0.0 so this process accepts that connection.',
      );
      process.exitCode = 1;
    }
  } finally {
    await stop();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
