/**
 * POST GitHub workflow_dispatch for the official snapshot workflow.
 * Blank inputs let scripts/official_snapshot_arm.py plan the meeting.
 * The token is a Worker secret and is never written to a URL, a log line, or a response.
 */

export const DISPATCH_URL =
  'https://api.github.com/repos/sleepingarhat/tianxi-racing/actions/workflows/capy_official_snapshot.yml/dispatches';

export const BLANK_INPUTS = { date: '', venue: '', kind: '' } as const;

export const HOOK_HEADER = 'x-pager-secret';

const GITHUB_API_VERSION = '2022-11-28';
const USER_AGENT = 'tianxi-official-snapshot-pager';

export interface Env {
  GITHUB_DISPATCH_TOKEN?: string;
  PAGER_HOOK_SECRET?: string;
}

export type FetchLike = typeof fetch;
export type LogFn = (line: string) => void;

export interface DispatchOutcome {
  ok: boolean;
  githubStatus: number | null;
  error: 'github_dispatch_failed' | 'github_fetch_failed' | null;
  detail: string;
}

const enc = new TextEncoder();

/** Hash both sides to a fixed length, then XOR. An empty value never matches. */
export async function secretMatches(given: string | null | undefined, expected: string | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  const left = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(given)));
  const right = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(expected)));
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  const values = secrets.filter((value): value is string => typeof value === 'string' && value.length > 0);
  values.sort((a, b) => b.length - a.length);
  for (const secret of values) out = out.split(secret).join('[redacted]');
  return out;
}

export function configuredSecret(value: string | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

export async function dispatchWorkflow(
  token: string,
  fetchImpl: FetchLike,
  secrets: Array<string | undefined>,
): Promise<DispatchOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(DISPATCH_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({ ref: 'main', inputs: BLANK_INPUTS }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'fetch failed';
    return {
      ok: false,
      githubStatus: null,
      error: 'github_fetch_failed',
      detail: redactSecrets(message, secrets).replace(/\s+/g, ' ').slice(0, 180),
    };
  }

  if (response.status === 200 || response.status === 204) {
    await cancelBody(response);
    return { ok: true, githubStatus: response.status, error: null, detail: '' };
  }

  const snippet = redactSecrets(await readSnippet(response, 240), secrets).replace(/\s+/g, ' ').slice(0, 180);
  return { ok: false, githubStatus: response.status, error: 'github_dispatch_failed', detail: snippet };
}

async function readSnippet(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const take = value.byteLength > maxBytes - total ? value.subarray(0, maxBytes - total) : value;
      chunks.push(take);
      total += take.byteLength;
      if (take.byteLength < value.byteLength) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
