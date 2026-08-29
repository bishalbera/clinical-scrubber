/**
 * `pnpm probe:upload` — does a file attached to a user message land in the sandbox,
 * byte-identical, without its contents entering model context?
 *
 * Both answers are yes; this re-verifies them against a future harness build. Asks
 * only for paths and hashes, never contents.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertHarnessReachable, createClient, readRunConfig } from '../lib/client.js';
import { EventIndex, type IndexedEvent } from '../lib/event-index.js';
import { downloadSandboxText, execResults, SANDBOX_UPLOAD_DIR } from '../lib/sandbox.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLASSIFY = resolve(HERE, '../../python/classify.py');

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  await assertHarnessReachable(runConfig);
  const client = createClient(runConfig);

  const source = readFileSync(CLASSIFY);
  const localSha = createHash('sha256').update(source).digest('hex');
  console.log(
    `local     python/classify.py  ${source.length} bytes  sha256 ${localSha.slice(0, 16)}…`,
  );

  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: runConfig.model },
        instructions:
          'You are a sandbox probe. Run the shell commands you are asked to run and ' +
          'report their output verbatim. Never print the contents of a file.',
        config: {
          sandbox: { enabled: true, fileDownloads: true },
          dynamicSubAgents: { enabled: false },
          generativeUi: { enabled: false },
        },
      },
    },
  });
  console.log(`session   ${session.id}`);

  const index = new EventIndex();
  const started = Date.now();

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [
      {
        type: 'user.message',
        content: [
          {
            type: 'text',
            text:
              'A Python file is attached. Do NOT print its contents.\n\n' +
              'Run this single shell command and paste the output verbatim:\n\n' +
              `find / -name 'classify*.py' -not -path '*/node_modules/*' 2>/dev/null | head -20; ` +
              `echo "--- hashes ---"; ` +
              `find / -name 'classify*.py' 2>/dev/null | head -20 | xargs -r sha256sum; ` +
              `echo "--- cwd ---"; pwd; ls -la`,
          },
          {
            type: 'file',
            name: 'classify.py',
            data: `data:text/x-python;base64,${source.toString('base64')}`,
          },
        ],
      },
    ],
  });

  for await (const { data: event, id } of stream.withMetadata()) {
    const typed = event as unknown as IndexedEvent;
    index.add(typed, id);
    const at = ((Date.now() - started) / 1000).toFixed(1);

    if (typed.type === 'sandbox.created') console.log(`  · [${at}s] sandbox created`);
    if (typed.type === 'tool.response' && typeof typed.content === 'string') {
      console.log(`  ← [${at}s] ${typed.content.slice(0, 1800)}`);
    }
  }

  const output = execResults(index.allEvents())
    .map((r) => r.output)
    .join('\n');

  const failures: string[] = [];

  // 1. The harness places the file where we think it does.
  const placed = new RegExp(`${SANDBOX_UPLOAD_DIR}/classify\\.py`).test(output);
  if (!placed) failures.push(`not placed under ${SANDBOX_UPLOAD_DIR}`);

  // 2. It arrives byte-identical. Compared, not merely printed.
  const remoteSha = new RegExp(`([0-9a-f]{64})\\s+${SANDBOX_UPLOAD_DIR}/classify\\.py`).exec(
    output,
  )?.[1];
  if (remoteSha === undefined) failures.push('no sha256 reported for the placed file');
  else if (remoteSha !== localSha) failures.push(`sha256 differs (${remoteSha.slice(0, 12)}…)`);

  // 3. The download endpoint serves a path nobody declared as an artifact. The canary
  //    side channel depends on this, so it is checked rather than assumed.
  const turnId = index.turnId;
  if (turnId === undefined) {
    failures.push('no turn id, cannot test the download channel');
  } else {
    try {
      const fetched = await downloadSandboxText(
        client,
        session.id,
        turnId,
        `${SANDBOX_UPLOAD_DIR}/classify.py`,
      );
      if (fetched !== source.toString('utf8')) {
        failures.push('downloaded bytes differ from the local file');
      }
    } catch (error) {
      failures.push(
        `undeclared-path download failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // An attachment that were decoded into the conversation would be no better than pasting.
  // 4. The contents must not reach the model. This is what makes attachments a
  //    boundary mechanism rather than a slower way of pasting.
  const visible = index.allModelVisibleText();
  const markers = ['MIN_LEAK_CHECK_LENGTH', 'assert_no_values_leaked', 'MATCH_THRESHOLD'];
  const inlined = markers.filter((marker) => visible.includes(marker));
  if (inlined.length > 0) failures.push(`attachment inlined into context (${inlined.join(', ')})`);

  console.log(`\nlocal sha256          ${localSha.slice(0, 16)}…`);
  console.log(`placed under upload   ${placed ? 'yes' : 'NO'}`);
  console.log(`sha256 matches        ${remoteSha === localSha ? 'yes' : 'NO'}`);
  console.log(
    `undeclared download   ${failures.some((f) => f.includes('download')) ? 'NO' : 'yes'}`,
  );
  console.log(`kept out of context   ${inlined.length === 0 ? 'yes' : 'NO'}`);
  console.log(`model-visible text    ${visible.length} chars`);

  if (failures.length > 0) {
    console.error(`\nFAIL — the documented behaviour no longer holds:`);
    for (const failure of failures) console.error(`  · ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nPASS — attachments arrive byte-identical, stay out of model context,');
  console.log('and the download endpoint serves undeclared paths.');
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
