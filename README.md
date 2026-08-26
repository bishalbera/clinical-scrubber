# Clinical Trial Data Scrubber & Analyst

An agent that de-identifies clinical-trial data and runs the statistics for an
FDA-style efficacy summary — built on [TrueForge](https://trueforge.dev), TrueFoundry's
open-source agent harness.

The interesting part is not the report. It is the boundary.

## The claim

> **Raw patient-level values never enter the model's prompt context.**
>
> The model may see _schema_ (column names, dtypes) and _aggregates and verdicts_
> computed inside the sandbox — "column `ssn` matches the SSN pattern in 98% of rows",
> "n=240, mean change −5.6, p=0.0004". It never sees an individual record.

Most "HIPAA-safe AI" demos assert something like this. This one proves it. A fake but
realistically-shaped SSN is planted in the raw dataset, the whole pipeline runs, and
then every scrap of text the model could have seen — every assistant message, every
tool result, every reasoning trace, every tool-call argument, across every subagent
thread of every turn — is concatenated and searched for that string. If it appears
anywhere, the run exits non-zero.

The canary is not a value we hid from the model. It is minted from a CSPRNG _inside
the sandbox_ at generation time, written to a side file, and never printed. The
orchestrator reads it back through the harness's file-download endpoint — a channel the
model has no part in. So the model has no way to know the string at all, and if it ever
appears in a transcript, the only available explanation is that something read the raw
data.

## How the boundary is enforced

The design consequence of the claim is that the agent cannot look at the data in order
to decide how to clean it. So it doesn't:

- **Classification is schema-only.** To decide what to scrub, the agent reads
  `df.columns` and `df.dtypes`. The actual pattern matching against values runs as a
  detector _inside_ the sandbox ([`python/classify.py`](./python/classify.py)) and
  returns `{name, dtype, populated, pii_type, match_rate}` with `example` null by
  construction — there is no code path in which a matched value can be returned. A
  backstop in the same file re-reads the rendered verdict and refuses to print it if
  any cell value appears.
- **In a pipeline run, the sandbox is the only place raw data exists.** The CSV is
  generated inside the sandbox and never printed into a tool result. (`pnpm gen:data`
  also writes a local copy, but that is for fixtures and offline tests; the pipeline
  never sends it anywhere.)
- **Everything crossing sandbox → model passes a guard** that scans for the canary and
  for PII-shaped patterns, and fails loudly rather than quietly redacting.
- **Instructions are not the boundary.** They tell the agent what to do; the guard is
  what makes it true. A prompt-injected or simply careless agent still cannot leak
  without the run failing.

Be precise about what that last point does and does not claim. TrueForge's sandbox tool
is a **shell**, so an agent that types `head -3 trial_raw.csv` really does put patient
records into a tool response. Nothing structurally prevents that. What the design does
is remove the _reason_ to do it — the classifier already returns everything needed to
plan a scrub — and then detect it with certainty if it happens anyway. The claim is
"we check every run", not "it cannot occur".

## Status

Built in phases; this is the state of the tree.

| Phase | What it adds                                          | Status |
| ----- | ----------------------------------------------------- | ------ |
| 1     | Scaffold, synthetic data generator, SDK round-trip    | ✅     |
| 2     | Sandbox ingest, schema-only classification, PII guard | ✅     |
| 3     | Compliance + Bio-Stat subagents                       | ⬜     |
| 4     | CMO approval gate on scrub script **and** methodology | ⬜     |
| 5     | Report generation, storage push, canary leak proof    | ⬜     |
| 6     | Resume-after-disconnect, compliance Skill, self-audit | ⬜     |

## Quick start

Requires Node 22.14+ and pnpm.

```bash
pnpm install
cp .env.example .env
pnpm gen:data          # writes the synthetic dataset with the canary planted
pnpm test              # offline unit tests, no harness needed
```

Then bring up the harness in a second terminal and point the project at it:

```bash
npx @truefoundry/trueforge        # serves UI + API on http://localhost:8790
```

Open <http://localhost:8790>, go to **Settings → Models**, pick a provider and paste an
API key. Agent specs reference models by name only (`provider/model`) — the key lives
in the harness, never in this repo and never in the sandbox. Set `TRUEFORGE_MODEL` in
`.env` to whatever you configured.

```bash
pnpm smoke             # creates a session, streams one turn, prints the reply
```

From Phase 2 onward you also need a sandbox provider: **Settings → Sandbox providers**,
Daytona preset, paste a Daytona API key. Daytona is currently TrueForge's only supported
sandbox backend.

## Data policy

**No real patient data is used, generated, committed, or accepted by this project.**

Everything comes from [`python/gen_data.py`](./python/gen_data.py), and its fabricated
identifiers are drawn from ranges that cannot collide with real ones:

- SSNs use area group `900-999`, which the SSA has never issued.
- Emails use `example.com`, reserved by RFC 2606 and unregistrable.
- Phone numbers use the `555-0100`–`555-0199` fictional block.
- Names, streets and cities are invented.

`data/synthetic/` is gitignored apart from a small canary-free `sample.csv` used as a
test fixture.

## Layout

```
python/          the scripts that run in-sandbox — source of truth for the data path
src/lib/         TrueForge client, event index, PII guard, canary side channel
src/pipeline/    orchestration: ingest → scrub → analyze → report
src/agents/      agent specs (root, compliance, bio-stat)
src/cli/         entrypoints (ingest, smoke, probes, prove-no-leak)
data/synthetic/  generated datasets (gitignored except sample.csv)
tests/           vitest suites; tests/python/ holds the pytest suites
```

`python/` is the source of truth rather than a copy of something in `src/`, because
those files are materialised into the sandbox and run there. `gen_data.py` is
standard-library only by design — the dataset must exist without a `pip install`
standing between the sandbox and the first step of the pipeline.

## Commands

| Command             | Does                                                      |
| ------------------- | --------------------------------------------------------- |
| `pnpm ingest`       | Run Phase 2 against a live sandbox (`--fresh`, `--trace`) |
| `pnpm gen:data`     | Generate the synthetic trial CSV locally                  |
| `pnpm smoke`        | Verify the harness round-trip                             |
| `pnpm probe:upload` | Re-verify how attachments reach the sandbox               |
| `pnpm test`         | Run the vitest suites                                     |
| `pnpm test:py`      | Run the pytest suites                                     |
| `pnpm typecheck`    | `tsc --noEmit` under strict settings                      |
| `pnpm lint`         | ESLint                                                    |
| `pnpm lint:py`      | ruff                                                      |
| `pnpm format`       | Prettier                                                  |

The pytest suites need pandas: `uv venv .venv && uv pip install -p .venv/bin/python
pandas scipy pytest ruff`. `pnpm gen:data` does not — it runs on a bare `python3`.
