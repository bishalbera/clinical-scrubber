/** `pnpm probe:sandbox` — what the Daytona image ships and how sandbox events look. */
import { assertHarnessReachable, createClient, readRunConfig } from '../lib/client.js';
import { EventIndex, type IndexedEvent } from '../lib/event-index.js';

const PROBE_PATH = '/tmp/probe-side-channel.json';

const PROBE_INSTRUCTIONS = `You are a sandbox probe. Run exactly the shell commands you are asked to run and report their output verbatim. Do not summarise, do not add commentary, do not run anything extra.`;

const PROBE_REQUEST = `Run this in the sandbox, as a single command, and paste the full output:

python3 -c "import sys, importlib.util as u; print('python', sys.version.split()[0]); [print(m, 'present' if u.find_spec(m) else 'MISSING') for m in ['pandas','scipy','numpy']]"; echo "--- pip ---"; (pip --version 2>&1 | head -1); echo "--- write ---"; printf '{\\"probe\\":\\"side-channel\\"}' > ${PROBE_PATH}; echo "wrote ${PROBE_PATH}"; pwd; whoami`;

async function main(): Promise<void> {
  const runConfig = readRunConfig();
  await assertHarnessReachable(runConfig);
  const client = createClient(runConfig);

  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: runConfig.model },
        instructions: PROBE_INSTRUCTIONS,
        config: {
          sandbox: { enabled: true, fileDownloads: true },
          // A subagent would open a second thread and muddy the trace.
          dynamicSubAgents: { enabled: false },
          generativeUi: { enabled: false },
        },
      },
    },
  });

  console.log(`session   ${session.id}`);

  const index = new EventIndex();
  const seenTypes = new Map<string, number>();
  let turnId: string | undefined;

  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: 'user.message', content: PROBE_REQUEST }],
  });

  for await (const { data: event, id } of stream.withMetadata()) {
    const typed = event as unknown as IndexedEvent;
    index.add(typed, id);
    seenTypes.set(typed.type, (seenTypes.get(typed.type) ?? 0) + 1);

    if (typed.type === 'turn.created') turnId = String(typed.id);
    if (typed.type === 'sandbox.created') {
      console.log(`sandbox   ${JSON.stringify(event)}`);
    }
    if (typed.type === 'tool.response') {
      console.log(`\n--- tool.response ---\n${JSON.stringify(event, null, 2).slice(0, 4000)}`);
    }
  }

  console.log('\n--- event types seen ---');
  for (const [type, count] of [...seenTypes].sort()) console.log(`  ${type} x${count}`);

  // Tool-call arguments arrive as deltas, so only the merged event shows them.
  console.log('\n--- merged events (per thread) ---');
  for (const threadId of index.threadIds()) {
    for (const merged of index.eventsFor(threadId)) {
      console.log(
        `\n[${threadId}] ${merged.type}\n${JSON.stringify(merged, null, 2).slice(0, 2500)}`,
      );
    }
  }

  console.log('\n--- main text ---');
  console.log(index.getMainText().slice(0, 2000));

  console.log('\n--- all model-visible text (what the guard scans) ---');
  console.log(index.allModelVisibleText().slice(0, 2000));

  console.log(`\n--- turn ${index.turnId ?? turnId ?? '(unknown)'} ---`);

  // Question 3: will it serve a path the assistant never declared as an artifact?
  const effectiveTurnId = index.turnId ?? turnId;
  if (effectiveTurnId === undefined) {
    console.log('download  SKIPPED (no turn id captured)');
    return;
  }

  try {
    const file = await client.sessions.downloadSandboxFile(session.id, effectiveTurnId, {
      path: PROBE_PATH,
    });
    console.log(`download  returned ${file?.constructor?.name ?? typeof file}`);
    console.log(`download  keys: ${JSON.stringify(Object.keys(file as object))}`);
    console.log(
      `download  proto: ${JSON.stringify(Object.getOwnPropertyNames(Object.getPrototypeOf(file)))}`,
    );
    console.log(`download  raw: ${JSON.stringify(file).slice(0, 300)}`);
  } catch (error) {
    console.log(`download  FAILED — ${error instanceof Error ? error.message : String(error)}`);
    console.log('          (the canary side channel needs another route)');
  }
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
