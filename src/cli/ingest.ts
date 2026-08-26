/** `pnpm ingest` — run Phase 2 end to end and show what crossed the boundary. */

import { assertHarnessReachable, readRunConfig } from '../lib/client.js';
import { formatGuardResult } from '../lib/pii-guard.js';
import { runIngest } from '../pipeline/ingest.js';

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  console.log(`harness  ${runConfig.baseUrl}`);
  console.log(`model    ${runConfig.model}`);
  console.log('');

  await assertHarnessReachable(runConfig);

  // Reusing the session reuses its warm sandbox.
  const fresh = process.argv.includes('--fresh');

  // Without this a slow run and a stuck run look identical.
  const trace = process.argv.includes('--trace');
  const started = Date.now();
  const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;

  const result = await runIngest({
    fresh,
    onStep: (message) => console.log(`  · [${elapsed()}] ${message}`),
    ...(trace
      ? {
          onEvent: (event) => {
            const calls = (event.toolCalls ?? event.tool_calls) as
              Array<{ function?: { name?: string; arguments?: string } }> | undefined;
            if (Array.isArray(calls)) {
              for (const call of calls) {
                const args = call.function?.arguments ?? '';
                console.log(
                  `  → [${elapsed()}] tool ${call.function?.name ?? '?'} ` +
                    `(${args.length} chars) ${args.slice(0, 120).replace(/\s+/g, ' ')}`,
                );
              }
            }
            if (event.type === 'tool.response') {
              const body = typeof event.content === 'string' ? event.content : '';
              console.log(
                `  ← [${elapsed()}] response (${body.length} chars) ${body.slice(0, 200)}`,
              );
            }
            if (event.type === 'model.message' && typeof event.content === 'string') {
              console.log(`  ✎ [${elapsed()}] message: ${event.content.slice(0, 200)}`);
            }
          },
        }
      : {}),
  });

  console.log('');
  console.log(`sandbox  ${result.sandboxId ?? '(none)'}`);
  console.log(`turn     ${result.turnId}`);
  console.log('');

  console.log(`Classification of ${result.verdict.row_count} rows, schema only:`);
  console.log('');
  console.log(
    `  ${pad('column', 18)}${pad('dtype', 8)}${pad('identifier', 12)}${pad('rate', 7)}blank`,
  );
  for (const column of result.verdict.columns) {
    console.log(
      `  ${pad(column.name, 18)}${pad(column.dtype, 8)}` +
        `${pad(column.pii_type ?? '—', 12)}${pad(column.match_rate.toFixed(2), 7)}${column.blank}`,
    );
  }

  console.log('');
  console.log(`PII columns: ${result.verdict.pii_columns.join(', ')}`);
  console.log('');
  console.log('--- boundary check ---');
  console.log(formatGuardResult(result.guard));
  console.log('');
  console.log(
    `The canary was minted inside the sandbox and read back over the file-download\n` +
      `endpoint. The model was never told it, and never produced it.`,
  );

  if (!result.guard.canaryClean) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
