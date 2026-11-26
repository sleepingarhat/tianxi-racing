/**
 * Free-plan pager for capy_official_snapshot.yml.
 *
 * Cron and POST /dispatch both start the existing GitHub Action with blank
 * inputs. Ingest, the wait until lockAt, and snapshot writes stay in that
 * Action. This Worker returns as soon as GitHub accepts or rejects the
 * dispatch. It has no crawl, no D1 binding, and no sleep.
 */

import type { ExportedHandler, ScheduledController } from '@cloudflare/workers-types';
import {
  HOOK_HEADER,
  configuredSecret,
  dispatchWorkflow,
  redactSecrets,
  secretMatches,
  type Env,
  type FetchLike,
  type LogFn,
} from './dispatch';

export type { Env };

export interface Deps {
  fetch?: FetchLike;
  log?: LogFn;
}

const defaultLog: LogFn = (line) => {
  console.log(line);
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/' && request.method === 'GET') {
    return json({ ok: true, service: 'tianxi-official-snapshot-pager' });
  }
  if (url.pathname !== '/dispatch') return json({ ok: false, error: 'not_found' }, 404);
  if (url.search) return json({ ok: false, error: 'query_string_not_allowed' }, 400);
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const hook = configuredSecret(env.PAGER_HOOK_SECRET);
  if (!hook) return json({ ok: false, error: 'hook_secret_not_configured' }, 503);
  const given = request.headers.get(HOOK_HEADER);
  if (!(await secretMatches(given, hook))) {
    writeLog(deps.log ?? defaultLog, '[official-snapshot-pager] source=http result=unauthorized', env);
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  return finishDispatch(env, deps, 'http');
}

export async function handleScheduled(env: Env, deps: Deps = {}): Promise<void> {
  await finishDispatch(env, deps, 'cron');
}

async function finishDispatch(env: Env, deps: Deps, source: 'http' | 'cron'): Promise<Response> {
  const log = deps.log ?? defaultLog;
  const token = configuredSecret(env.GITHUB_DISPATCH_TOKEN);
  if (!token) {
    writeLog(log, `[official-snapshot-pager] source=${source} result=dispatch_token_not_configured`, env);
    return json({ ok: false, error: 'dispatch_token_not_configured' }, 503);
  }

  const outcome = await dispatchWorkflow(token, deps.fetch ?? fetch, [env.GITHUB_DISPATCH_TOKEN, env.PAGER_HOOK_SECRET]);
  const status = outcome.githubStatus == null ? '' : ` github_status=${outcome.githubStatus}`;
  const detail = outcome.detail ? ` detail=${outcome.detail}` : '';
  const result = outcome.ok ? 'dispatched' : outcome.error;
  writeLog(log, `[official-snapshot-pager] source=${source} result=${result}${status}${detail}`, env);

  if (outcome.ok) {
    return json({
      ok: true,
      dispatched: true,
      workflow: 'capy_official_snapshot.yml',
      ref: 'main',
      github_status: outcome.githubStatus,
    });
  }
  if (outcome.error === 'github_fetch_failed') return json({ ok: false, error: 'github_fetch_failed' }, 502);
  return json({ ok: false, error: 'github_dispatch_failed', github_status: outcome.githubStatus }, 502);
}

function writeLog(log: LogFn, line: string, env: Env): void {
  log(redactSecrets(line, [env.GITHUB_DISPATCH_TOKEN, env.PAGER_HOOK_SECRET]));
}

const worker: ExportedHandler<Env> = {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
  scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    return handleScheduled(env);
  },
};

export default worker;
