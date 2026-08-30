/** TrueForge client factory and shared run configuration. */
import { config as loadDotenv } from 'dotenv';
import { TrueForge } from '@truefoundry/trueforge-sdk';

loadDotenv();

/** Default local-mode address of the harness (`npx @truefoundry/trueforge`). */
export const DEFAULT_BASE_URL = 'http://localhost:8790';

/** Generous enough to cover a Daytona cold start on the first turn of a session. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Preflight budget, separate from the turn budget above: this call only answers
 * "is the harness up?", so it should fail fast rather than inherit a ten-minute wait.
 */
export const REACHABILITY_TIMEOUT_MS = Number(process.env.TRUEFORGE_PREFLIGHT_TIMEOUT_MS) || 5000;

export interface RunConfig {
  baseUrl: string;
  timeoutInSeconds: number;
  /** Model FQN (`provider/model`) for the root agent and the bio-stat work. */
  model: string;
  /** Cheaper model FQN, used for the scrub subagent when multi-model is enabled. */
  cheapModel: string;
  /** Bearer token, only when the harness has OIDC login enabled. */
  token: string | undefined;
}

/** Read run configuration from the environment, applying documented defaults. */
export function readRunConfig(env: NodeJS.ProcessEnv = process.env): RunConfig {
  return {
    baseUrl: env.TRUEFORGE_BASE_URL?.trim() || DEFAULT_BASE_URL,
    timeoutInSeconds: Number(env.TRUEFORGE_TIMEOUT_SECONDS) || DEFAULT_TIMEOUT_SECONDS,
    model: env.TRUEFORGE_MODEL?.trim() || 'anthropic/claude-sonnet-4-6',
    cheapModel: env.TRUEFORGE_MODEL_CHEAP?.trim() || 'anthropic/claude-haiku-4-5-20251001',
    token: env.TRUEFORGE_TOKEN?.trim() || undefined,
  };
}

/** No API key is passed: TrueForge stores provider credentials server-side. */
export function createClient(runConfig: RunConfig = readRunConfig()): TrueForge {
  return new TrueForge({
    baseUrl: runConfig.baseUrl,
    timeoutInSeconds: runConfig.timeoutInSeconds,
    ...(runConfig.token ? { token: runConfig.token } : {}),
  });
}

function harnessFetch(runConfig: RunConfig, path: string): Promise<Response> {
  return fetch(`${runConfig.baseUrl.replace(/\/$/, '')}${path}`, {
    signal: AbortSignal.timeout(REACHABILITY_TIMEOUT_MS),
    ...(runConfig.token ? { headers: { Authorization: `Bearer ${runConfig.token}` } } : {}),
  });
}

/** Fail fast with an actionable message when the harness is not reachable. */
export async function assertHarnessReachable(
  runConfig: RunConfig = readRunConfig(),
): Promise<void> {
  try {
    const response = await harnessFetch(runConfig, '/api/v1/capabilities');
    if (!response.ok) {
      throw new Error(`harness responded ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot reach the TrueForge harness at ${runConfig.baseUrl} (${reason}).\n` +
        `Start it in another terminal with:  npx @truefoundry/trueforge\n` +
        `Then open ${runConfig.baseUrl} and add a model provider under Settings → Models.`,
      { cause: error },
    );
  }
}

/** Model FQNs the harness can serve. Best-effort: only used to improve an error message. */
export async function listConfiguredModels(
  runConfig: RunConfig = readRunConfig(),
): Promise<string[]> {
  try {
    const response = await harnessFetch(runConfig, '/api/v1/models');
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return [];
    return body.data
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry != null && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const name = record.name ?? record.id;
          if (typeof name === 'string') return name;
        }
        return undefined;
      })
      .filter((name): name is string => name !== undefined);
  } catch {
    return [];
  }
}
