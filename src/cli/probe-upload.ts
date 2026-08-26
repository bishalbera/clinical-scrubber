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

  console.log(`\n--- final message ---\n${index.getMainText().slice(0, 1200)}`);
  console.log(`\nlocal sha256 was ${localSha}`);

  // An attachment that were decoded into the conversation would be no better than pasting.
  const visible = index.allModelVisibleText();
  const markers = ['MIN_LEAK_CHECK_LENGTH', 'assert_no_values_leaked', 'MATCH_THRESHOLD'];
  const inlined = markers.filter((marker) => visible.includes(marker));

  console.log(`\n--- did the file content enter model context? ---`);
  console.log(`model-visible text: ${visible.length} chars`);
  console.log(
    inlined.length === 0
      ? 'NO — no marker from classify.py appears. The harness placed the file without inlining it.'
      : `YES — found ${inlined.join(', ')}. Attachments are decoded into context.`,
  );
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
