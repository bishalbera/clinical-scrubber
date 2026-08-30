# Clinical Trial Data Scrubber & Analyst

An agent that de-identifies clinical-trial data and runs the statistics for an
FDA-style efficacy summary — built on [TrueForge](https://trueforge.dev), TrueFoundry's
open-source agent harness.

Researchers spend hundreds of hours de-identifying patient data and running statistics
before they can draft an FDA report. It is exactly the work an agent should do, and
exactly the work you cannot hand to one: the raw file contains names, SSNs, MRNs and
dates of birth, and putting those in an LLM's context is a HIPAA violation.

The usual answer is to redact first and hope. This takes the harder position: the agent
plans the de-identification **without ever seeing a value**, and every run proves it.

## What it does

1. **Ingests** a messy trial CSV — 300 participants, four date formats, units glued onto
   numbers, mixed casing, dropout gaps.
2. **Classifies** every column by identifier type, from inside the sandbox.
3. **Delegates** to two subagents: Compliance writes the de-identification script,
   Bio-Stat writes the statistical analysis. Both author their own Python.
4. **Stops for a Chief Medical Officer**, who reads both scripts in full before any
   report is released.
5. **Proves** that no patient value reached the model.

The statistics are real. A representative run:

```
treatment n=144  mean -5.73  SD 6.52
placebo   n=147  mean -2.98  SD 5.61
difference -2.75, 95% CI [-4.15, -1.34], t=-3.85, p=0.000146, Cohen's d=-0.45
safety: chi2=0.30, p=0.585  (correctly null)
```

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

## The proof

```bash
pnpm prove
```

```
  Canary SSN            967-46-8957
  Canary name           Perpetua Ashdown-Vance
  Planted in            row 126 (STUDY-0127)
  Minted                inside the sandbox, never printed, never told to the model

  Rows of patient data  300      Identifier columns    8
  Subagent threads      2        Model-visible text    32,605 characters scanned

  Canary in model context:             NO
  Raw patient values in model context: NONE (1 lookalike checked against the data)

  PASS — the boundary held.
```

Exits non-zero on any leak. The canary differs on every run, because it is generated
inside the sandbox rather than fixed in source.

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

## How it uses TrueForge

| Feature                 | Use                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sandbox** (Daytona)   | Every byte of patient data lives here. The agent writes and runs pandas and scipy against it; nothing else ever holds a record.                                           |
| **Subagents**           | Compliance and Bio-Stat run as separate threads with their own context. Sequential rather than parallel, because the analysis needs the scrubbed file the scrub produces. |
| **MCP + tool approval** | `require_approval_for_tools` is per-server, so the gated release tool is hosted on a real MCP server the harness enumerates and calls.                                    |
| **Approval pause**      | `tool.approval_required` stops the run; the CLI renders the review packet and resumes with `user.tool_approval`. Denials carry a reason and the agent revises.            |
| **File attachments**    | The pipeline's Python arrives as `file` content parts. The harness places them in the sandbox without the model reproducing a byte.                                       |
| **Turn file download**  | Brings the canary, the agent-authored scripts and the report back out, bypassing the model entirely.                                                                      |
| **Event streaming**     | Deltas are merged per thread to reconstruct everything the model could have seen — the guard's only input.                                                                |

Two things the docs left open, settled by probing rather than assumption: attachments
land in `/opt/tf/uploads/` byte-identical and **do not** enter model context, and the
download endpoint serves any sandbox path, not only declared artifacts. Both are
load-bearing, and `pnpm probe:upload` re-checks them.

## The human checkpoint

The CMO approves a **method**, not a button. The packet contains `scrub.py` and
`analyze.py` in full — pulled from the sandbox, so it is the exact text that ran — plus
the aggregate results and the arguments proposed for release. A denial sends the reason
back; the agent revises and presents again. Nothing is released without an explicit
allow, and the CLI cross-checks the MCP server's release log against the loop's verdict
rather than trusting the gate to report on itself.

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

You also need a sandbox provider: **Settings → Sandbox providers**,
Daytona preset, paste a Daytona API key. Daytona is currently TrueForge's only supported
sandbox backend.

The approval gate needs its MCP server registered once:

```bash
pnpm mcp:register     # one-time
pnpm review --fresh   # runs the pipeline and pauses for the CMO
```

## Qodo review

Every substantive change went through a pull request reviewed by Qodo before merge.

- **Representative PR:** [#2 — sandbox ingest with schema-only PII classification and
  leak guard](https://github.com/bishalbera/clinical-scrubber/pull/2)
- **Full history:** [every pull request in this
  repository](https://github.com/bishalbera/clinical-scrubber/pulls?q=is%3Apr), each with
  its review, the decisions taken on it, and a follow-up review against the final code

Qodo reviewed every pull request here and raised findings on all of them, mostly rated
High. All were resolved except one, which was partly accepted with the reasoning
recorded in its thread. Each PR followed the same loop: review, fixes pushed to the
same branch, follow-up review against the final code, then a human merge. The counts
and the threads are in the PRs themselves rather than repeated here, where they would
go out of date on the next review.

### What it surfaced

The findings that mattered were all in code that had a green test suite, a clean
typecheck and clean lint — every one sat in a path the tests never exercised.

- **The boundary check only covered 1/300th of the file.** The run failed on the
  planted canary but treated any other patient row as a non-fatal "pattern" hit, so
  `head -5 trial_raw.csv` would have leaked five real participants and exited zero.
  Fixed by adjudicating suspicious strings inside the sandbox against the real data —
  a match in the data is a leak, a match absent from it is agent-authored example text.
- **The guard was itself a disclosure channel.** Excerpts masked the matched value but
  printed 24 raw characters either side, which on a leaked CSV row are that same
  patient's name, MRN and date of birth. A test named "the guard does not become the
  leak" had passed throughout, because it only ever checked the match.
- **Stale artifacts could satisfy a fresh run.** With a warm sandbox nothing bound
  `/work` outputs to the current run, so an agent that skipped generation could return
  a previous run's verdict and canary. Every artifact now carries a per-run id.
- **A per-participant study number was being kept.** `STUDY-0001` matched no detector
  and was treated as an analysis column, although it re-links every row to one person.
- **Session scanning read one page.** `listEvents` is paginated and newest-first, so
  older turns of a reused session escaped the scan entirely.
- **The guard only matched identifier _shapes_.** Six regexes catch SSNs and emails but
  not a patient name or a study id, which look like ordinary words. A leaked name would
  have printed `NONE` and exited zero. Now the whole transcript is compared against every
  value in the classified identifier columns — inside the sandbox, with only counts
  coming back. The last run compared 2,183 values.
- **Error messages were a disclosure channel.** Three separate failure paths quoted raw
  sandbox output into text that reaches a terminal and shell history — and the command
  most likely to fail is one that printed something it should not have.
- **The documentation claimed more than the code did.** Reviewing this README, Qodo
  found that the pipeline's final check compared identifier _shapes_ but not real
  values, while the text said it proved no patient value reached the model; and that
  `pnpm probe:upload` printed its observations without asserting them, so it could not
  fail. Both were fixed in the code rather than softened in the prose.

### Intentionally dismissed

One finding on [#2](https://github.com/bishalbera/clinical-scrubber/pull/2) asked the
5-second harness preflight to inherit `DEFAULT_TIMEOUT_SECONDS` (600s). Declined, with
the reason recorded in the thread: the two answer different questions — 600s is the
budget for a turn that cold-starts a sandbox and runs pandas, while the preflight only
answers "is the harness up?", and inheriting it would mean waiting ten minutes to learn
the server is not running. The real defect was an unexplained literal, so it became
`REACHABILITY_TIMEOUT_MS`, documented and overridable.

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
src/mcp/         the MCP server hosting the approval-gated release tool
src/cli/         entrypoints (review, pipeline, ingest, smoke, probes)
data/synthetic/  generated datasets (gitignored except sample.csv)
tests/           vitest suites; tests/python/ holds the pytest suites
```

`python/` is the source of truth rather than a copy of something in `src/`, because
those files are materialised into the sandbox and run there. `gen_data.py` is
standard-library only by design — the dataset must exist without a `pip install`
standing between the sandbox and the first step of the pipeline.

## Commands

| Command             | Does                                             |
| ------------------- | ------------------------------------------------ |
| `pnpm pipeline`     | Full run: ingest, scrub, analyse, boundary check |
| `pnpm ingest`       | Ingest and classify only (`--fresh`, `--trace`)  |
| `pnpm gen:data`     | Generate the synthetic trial CSV locally         |
| `pnpm smoke`        | Verify the harness round-trip                    |
| `pnpm probe:upload` | Re-verify how attachments reach the sandbox      |
| `pnpm test`         | Run the vitest suites                            |
| `pnpm test:py`      | Run the pytest suites                            |
| `pnpm typecheck`    | `tsc --noEmit` under strict settings             |
| `pnpm lint`         | ESLint                                           |
| `pnpm lint:py`      | ruff                                             |
| `pnpm format`       | Prettier                                         |

The pytest suites need pandas: `uv venv .venv && uv pip install -p .venv/bin/python
pandas scipy pytest ruff`. `pnpm gen:data` does not — it runs on a bare `python3`.
