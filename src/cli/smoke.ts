/**
 * `pnpm smoke` — verify the SDK round-trip. No sandbox, no MCP, no subagents: if this
 * fails the problem is the harness or the model provider, not this project.
 */

import {
  assertHarnessReachable,
  createClient,
  listConfiguredModels,
  readRunConfig,
  type RunConfig,
} from '../lib/client.js';
import { EventIndex, type IndexedEvent } from '../lib/event-index.js';

/** Turn a session-creation failure into something a first-time user can act on. */
async function explainModelFailure(error: unknown, runConfig: RunConfig): Promise<string> {
  const message = error instanceof Error ? error.message : String(error);
  const raw = `${message}\n${JSON.stringify(error)}`;

  if (!/provider not configured|Unknown model|fully qualified/i.test(raw)) return message;

  const available = await listConfiguredModels(runConfig);
  const lines = [`The harness does not know the model "${runConfig.model}".`, ''];

  if (!runConfig.model.includes('/')) {
    lines.push(
      'TrueForge wants a fully-qualified `provider/model` name. Try prefixing the',
      `provider, e.g. anthropic/${runConfig.model}.`,
      '',
    );
  }

  if (available.length === 0) {
    lines.push(
      'No model providers are configured yet. Open',
      `  ${runConfig.baseUrl}  →  Settings → Models`,
      'pick a provider, paste an API key, then set TRUEFORGE_MODEL in .env to the',
      'model FQN it exposes (for example anthropic/claude-sonnet-4-6).',
    );
  } else {
    lines.push('Configured models:', ...available.map((name) => `  ${name}`));
    lines.push('', 'Set TRUEFORGE_MODEL in .env to one of these.');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  console.log(`harness  ${runConfig.baseUrl}`);
  console.log(`model    ${runConfig.model}`);
  console.log('');

  await assertHarnessReachable(runConfig);

  const client = createClient(runConfig);

  const { data: session } = await client.sessions
    .create({
      agent: {
        spec: {
          model: { name: runConfig.model },
          instructions: 'You are a concise assistant. Answer in one short sentence.',
        },
      },
    })
    .catch(async (error: unknown) => {
      throw new Error(await explainModelFailure(error, runConfig), { cause: error });
    });
  console.log(`session  ${session.id}`);
  console.log('');

  const index = new EventIndex();
  let status: string | undefined;

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [
      {
        type: 'user.message',
        content: 'Reply with exactly: TrueForge round-trip OK.',
      },
    ],
  });

  process.stdout.write('reply    ');
  for await (const { data: event, id } of stream.withMetadata()) {
    index.add(event as unknown as IndexedEvent, id);

    if (event.type === 'model.message.delta' && typeof event.content === 'string') {
      process.stdout.write(event.content);
    }
    if (event.type === 'turn.done') {
      status = event.state.status;
    }
  }
  process.stdout.write('\n\n');

  console.log(`turn     ${index.turnId ?? '(none)'}`);
  console.log(`status   ${status ?? '(no turn.done seen)'}`);
  console.log(`events   ${index.size()} merged across threads [${index.threadIds().join(', ')}]`);

  if (status !== 'done') {
    console.error(`\nSmoke test did not reach status "done" (got "${status}").`);
    process.exitCode = 1;
    return;
  }

  // A turn can reach "done" having produced nothing at all, which is not a working
  // round-trip. Asserting non-empty rather than exact text: the point is that the
  // model replied, and pinning the wording would break on harmless paraphrasing.
  if (index.getMainText().trim().length === 0) {
    console.error('\nTurn completed but the model produced no text.');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
