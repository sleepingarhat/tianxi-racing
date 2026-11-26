import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BLANK_INPUTS,
  DISPATCH_URL,
  HOOK_HEADER,
  redactSecrets,
  secretMatches,
} from '../src/dispatch.ts';
import worker, { handleRequest, type Env } from '../src/index.ts';
import {
  ARM_HORIZON_MINUTES,
  CRON_JOB_ORG_CRON,
  FREE_ACCOUNT_CRON_CAP,
  GITHUB_SNAPSHOT_CRONS,
  HAPPY_VALLEY_NIGHT_WINDOW_HKT,
  SHA_TIN_DAY_WINDOW_HKT,
  addMinutes,
  clockInHalfOpenRange,
  expandUtcTimes,
  minutesBetween,
} from '../src/schedule.ts';

const here = dirname(fileURLToPath(import.meta.url));
const pagerRoot = resolve(here, '..');
const repoRoot = resolve(pagerRoot, '../..');

const TOKEN = 'test-dispatch-token';
const HOOK = 'test-hook-secret';

function env(overrides: Env = {}): Env {
  return { GITHUB_DISPATCH_TOKEN: TOKEN, PAGER_HOOK_SECRET: HOOK, ...overrides };
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function crons(toml: string): string[] {
  const matches = [...toml.matchAll(/crons\s*=\s*\[/g)];
  if (matches.length === 0) return [];
  assert.equal(matches.length, 1);
  const start = matches[0].index ?? 0;
  const end = toml.indexOf(']', start);
  assert.ok(end > start);
  return [...toml.slice(start, end).matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

function overlap(left: string[], right: string[]): string[] {
  const banned = new Set(right);
  return left.filter((value) => banned.has(value));
}

describe('schedule and account cron cap', () => {
  it('uses cron-job.org only, offset from the GitHub snapshot arms', () => {
    const pagerToml = read(resolve(pagerRoot, 'wrangler.toml'));
    const workflow = read(resolve(repoRoot, '.github/workflows/capy_official_snapshot.yml'));
    assert.deepEqual(crons(pagerToml), []);
    assert.equal(pagerToml.includes('[triggers]'), false);
    assert.equal(pagerToml.includes('crons'), false);

    const githubFromWorkflow = [...workflow.matchAll(/cron:\s*'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(githubFromWorkflow, [...GITHUB_SNAPSHOT_CRONS]);

    const hookTimes = expandUtcTimes(CRON_JOB_ORG_CRON);
    const githubTimes = GITHUB_SNAPSHOT_CRONS.flatMap((expr) => expandUtcTimes(expr));
    assert.deepEqual(hookTimes, ['03:50', '08:50', '09:50', '22:50']);
    assert.deepEqual(overlap(hookTimes, githubTimes), []);
  });

  it('covers the Sha Tin day window and the Happy Valley night window in HKT', () => {
    const morning = addMinutes('22:50', 8 * 60);
    assert.deepEqual(morning, { hhmm: '06:50', dayDelta: 1 });
    assert.equal(minutesBetween(morning.hhmm, SHA_TIN_DAY_WINDOW_HKT.lock), 265);
    assert.ok(minutesBetween(morning.hhmm, SHA_TIN_DAY_WINDOW_HKT.lock) <= ARM_HORIZON_MINUTES);
    assert.equal(clockInHalfOpenRange(SHA_TIN_DAY_WINDOW_HKT.lock, SHA_TIN_DAY_WINDOW_HKT.firstPost, '11:50'), true);

    const beforeValley = addMinutes('08:50', 8 * 60);
    const insideValley = addMinutes('09:50', 8 * 60);
    assert.deepEqual(beforeValley, { hhmm: '16:50', dayDelta: 0 });
    assert.deepEqual(insideValley, { hhmm: '17:50', dayDelta: 0 });
    assert.equal(minutesBetween(beforeValley.hhmm, HAPPY_VALLEY_NIGHT_WINDOW_HKT.lock), 20);
    assert.ok(minutesBetween(beforeValley.hhmm, HAPPY_VALLEY_NIGHT_WINDOW_HKT.lock) <= ARM_HORIZON_MINUTES);
    assert.equal(
      clockInHalfOpenRange(HAPPY_VALLEY_NIGHT_WINDOW_HKT.lock, HAPPY_VALLEY_NIGHT_WINDOW_HKT.firstPost, insideValley.hhmm),
      true,
    );
  });

  it('adds zero Cloudflare cron triggers on top of the six already declared by tianxi-backend', () => {
    const readerToml = read(resolve(repoRoot, 'backend/wrangler.toml'));
    const pagerToml = read(resolve(pagerRoot, 'wrangler.toml'));
    const reader = crons(readerToml);
    assert.deepEqual(reader, [
      '0 19 * * *',
      '0 22 * * *',
      '0 3 * * *',
      '0 4 * * *',
      '0 10 * * *',
      '*/5 * * * *',
    ]);
    assert.equal(crons(pagerToml).length, 0);
    assert.equal(reader.length, 6);
    assert.equal(FREE_ACCOUNT_CRON_CAP, 5);
    assert.ok(reader.length > FREE_ACCOUNT_CRON_CAP);
    assert.equal(reader.length + crons(pagerToml).length, 6);
  });

  it('keeps the pager off the reader deploy path and off paid Worker features', () => {
    const toml = read(resolve(pagerRoot, 'wrangler.toml'));
    const deploy = read(resolve(repoRoot, '.github/workflows/backend_deploy.yml'));
    const checks = read(resolve(repoRoot, '.github/workflows/official_snapshot_pager_checks.yml'));
    assert.match(toml, /name = "tianxi-official-snapshot-pager"/);
    assert.equal(toml.includes('usage_model'), false);
    assert.equal(toml.includes('cpu_ms'), false);
    assert.equal(toml.includes('[[routes]]'), false);
    assert.equal(toml.includes('d1_databases'), false);
    assert.equal(toml.includes('kv_namespaces'), false);
    assert.equal(toml.includes('r2_buckets'), false);
    assert.equal(toml.includes('durable_objects'), false);
    assert.equal(toml.includes('[[queues]]'), false);
    assert.equal(toml.includes('[triggers]'), false);
    assert.equal(toml.includes('crons'), false);
    assert.equal(/\bscheduled\s*\(/.test(read(resolve(pagerRoot, 'src/index.ts'))), false);
    assert.match(read(resolve(repoRoot, 'backend/wrangler.toml')), /account_id = "([^"]+)"/);
    const account = /account_id = "([^"]+)"/.exec(toml);
    const readerAccount = /account_id = "([^"]+)"/.exec(read(resolve(repoRoot, 'backend/wrangler.toml')));
    assert.equal(account?.[1], readerAccount?.[1]);
    assert.match(deploy, /paths: \['backend\/\*\*', '\.github\/workflows\/backend_deploy\.yml'\]/);
    assert.equal(deploy.includes('official-snapshot-pager'), false);
    assert.equal(checks.includes('wrangler deploy'), false);
    assert.equal(checks.includes('secrets.'), false);

    const source = ['src/index.ts', 'src/dispatch.ts', 'src/schedule.ts']
      .map((file) => read(resolve(pagerRoot, file)))
      .join('\n');
    assert.equal(/\b(?:setTimeout|setInterval|Atomics\.wait|scheduler\.wait)\b|\bsleep\s*\(/.test(source), false);
    assert.equal(source.includes('official_snapshots'), false);
  });
});

describe('workflow dispatch contract', () => {
  it('sends blank inputs for the workflow file on main', async () => {
    const workflow = read(resolve(repoRoot, '.github/workflows/capy_official_snapshot.yml'));
    assert.match(workflow, /workflow_dispatch:/);
    for (const key of Object.keys(BLANK_INPUTS) as Array<keyof typeof BLANK_INPUTS>) {
      assert.equal(BLANK_INPUTS[key], '');
      assert.match(workflow, new RegExp(`${key}:\\s*\\{[^\\n]*default:\\s*''`));
    }

    const seen: Array<{ url: string; init: RequestInit }> = [];
    const response = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env(), {
      fetch: async (input, init) => {
        seen.push({ url: String(input), init: init ?? {} });
        return new Response(null, { status: 204 });
      },
      log: () => undefined,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      dispatched: true,
      workflow: 'capy_official_snapshot.yml',
      ref: 'main',
      github_status: 204,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, DISPATCH_URL);
    assert.equal(seen[0].url.includes(TOKEN), false);
    assert.equal(seen[0].url.includes(HOOK), false);
    assert.equal(seen[0].url.includes('?'), false);
    const headers = new Headers(seen[0].init.headers);
    assert.equal(headers.get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(headers.get(HOOK_HEADER), null);
    assert.equal(headers.get('user-agent'), 'tianxi-official-snapshot-pager');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.redirect, 'manual');
    assert.deepEqual(JSON.parse(String(seen[0].init.body)), { ref: 'main', inputs: { date: '', venue: '', kind: '' } });
  });

  it('treats a redirect as a failed dispatch and does not request the Location', async () => {
    let calls = 0;
    const response = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env(), {
      fetch: async () => {
        calls += 1;
        return new Response('go', { status: 302, headers: { Location: `https://example.invalid/${TOKEN}` } });
      },
      log: (line) => {
        assert.equal(line.includes(TOKEN), false);
        assert.equal(line.includes('example.invalid'), false);
      },
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 502);
    const body = await response.text();
    assert.match(body, /"github_status":302/);
    assert.equal(body.includes(TOKEN), false);
    assert.equal(body.includes('example.invalid'), false);
  });

  it('accepts GitHub 200 and does not forward the caller token', async () => {
    let calls = 0;
    const response = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: {
        [HOOK_HEADER]: HOOK,
        Authorization: 'Bearer test-caller-token',
      },
    }), env(), {
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ workflow_run_id: 9, run_url: 'https://github.com/example/run/9' }), { status: 200 });
      },
      log: () => undefined,
    });
    assert.equal(calls, 1);
    const body = await response.json() as { ok: boolean; github_status: number; run_url?: string };
    assert.equal(body.ok, true);
    assert.equal(body.github_status, 200);
    assert.equal(body.run_url, undefined);
    assert.equal(JSON.stringify(body).includes('test-caller-token'), false);
  });

  it('logs a GitHub failure without the token or the hook secret', async () => {
    const lines: string[] = [];
    let calls = 0;
    const response = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env(), {
      fetch: async (_input, init) => {
        calls += 1;
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${TOKEN}`);
        assert.equal(new Headers(init?.headers).get(HOOK_HEADER), null);
        return new Response(`leaked ${TOKEN} and ${HOOK}`, { status: 401 });
      },
      log: (line) => lines.push(line),
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes(TOKEN), false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /source=http result=github_dispatch_failed github_status=401/);
    assert.equal(lines[0].includes(TOKEN), false);
    assert.equal(lines[0].includes(HOOK), false);
    assert.match(lines[0], /\[redacted\]/);
  });

  it('does not dispatch when the token is missing', async () => {
    let calls = 0;
    const lines: string[] = [];
    const response = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env({ GITHUB_DISPATCH_TOKEN: '' }), {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
      log: (line) => lines.push(line),
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
    assert.deepEqual(lines, ['[official-snapshot-pager] source=http result=dispatch_token_not_configured']);
  });
});

describe('HTTP hook', () => {
  it('GET / does not dispatch', async () => {
    let calls = 0;
    const response = await handleRequest(new Request('https://pager.example/'), env(), {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 204 });
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'tianxi-official-snapshot-pager' });
    assert.equal(calls, 0);
  });

  it('rejects a missing hook, a wrong hook, the wrong method, and any query string', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };
    const missing = await handleRequest(new Request('https://pager.example/dispatch', { method: 'POST' }), env(), { fetch: fetchImpl });
    const wrong = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { 'X-Pager-Secret': 'different-length-secret' },
    }), env(), { fetch: fetchImpl });
    const get = await handleRequest(new Request('https://pager.example/dispatch'), env(), { fetch: fetchImpl });
    const queried = await handleRequest(new Request(`https://pager.example/dispatch?${HOOK_HEADER}=${HOOK}`, {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env(), { fetch: fetchImpl, log: () => undefined });
    const unconfigured = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env({ PAGER_HOOK_SECRET: undefined }), { fetch: fetchImpl });

    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(get.status, 405);
    assert.equal(queried.status, 400);
    assert.equal(JSON.stringify(await queried.json()).includes(HOOK), false);
    assert.equal(unconfigured.status, 503);
    assert.equal(calls, 0);
  });

  it('returns GitHub status without the response body', async () => {
    const lines: string[] = [];
    const response = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env(), {
      fetch: async () => new Response(`denied ${TOKEN}`, { status: 403 }),
      log: (line) => lines.push(line),
    });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.equal(body.includes(TOKEN), false);
    assert.equal(body.includes('denied'), false);
    assert.match(body, /"github_status":403/);
    assert.equal(lines.join('\n').includes(TOKEN), false);
  });

  it('redacts a fetch exception and reports a network failure', async () => {
    const lines: string[] = [];
    const response = await handleRequest(new Request('https://pager.example/dispatch', {
      method: 'POST',
      headers: { [HOOK_HEADER]: HOOK },
    }), env(), {
      fetch: async () => {
        throw new Error(`connect ${TOKEN} ${HOOK}`);
      },
      log: (line) => lines.push(line),
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { ok: false, error: 'github_fetch_failed' });
    assert.equal(lines.join('\n').includes(TOKEN), false);
    assert.equal(lines.join('\n').includes(HOOK), false);
    assert.match(lines[0], /result=github_fetch_failed/);
  });

  it('wires fetch to the same dispatch and has no scheduled handler', async () => {
    assert.equal('scheduled' in worker, false);
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      assert.equal(String(input), DISPATCH_URL);
      assert.equal(init?.redirect, 'manual');
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const logged: string[] = [];
      const originalLog = console.log;
      console.log = (line?: unknown) => {
        logged.push(String(line));
      };
      try {
        const health = await worker.fetch?.(new Request('https://pager.example/'), env(), {} as never);
        assert.equal(health?.status, 200);
        assert.equal(calls, 0);
        const dispatched = await worker.fetch?.(new Request('https://pager.example/dispatch', {
          method: 'POST',
          headers: { [HOOK_HEADER]: HOOK },
        }), env(), {} as never);
        assert.equal(dispatched?.status, 200);
        assert.equal(calls, 1);
        assert.equal(logged.join('\n').includes(TOKEN), false);
        assert.equal(logged.join('\n').includes(HOOK), false);
      } finally {
        console.log = originalLog;
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('secret handling', () => {
  it('matches only the full hook secret', async () => {
    assert.equal(await secretMatches(HOOK, HOOK), true);
    assert.equal(await secretMatches('a', 'ab'), false);
    assert.equal(await secretMatches('', HOOK), false);
    assert.equal(await secretMatches(HOOK, ''), false);
    assert.equal(await secretMatches(HOOK, undefined), false);
  });

  it('redacts longer secrets before shorter ones', () => {
    assert.equal(redactSecrets(`token ${TOKEN} hook ${HOOK}`, [HOOK, TOKEN]), 'token [redacted] hook [redacted]');
    assert.equal(redactSecrets('nothing', ['']), 'nothing');
  });

  it('documents the secret names and leaves values out of the repo', () => {
    const readme = read(resolve(pagerRoot, 'README.md'));
    const repoText = [
      readme,
      read(resolve(pagerRoot, 'wrangler.toml')),
      read(resolve(pagerRoot, 'src/index.ts')),
      read(resolve(pagerRoot, 'src/dispatch.ts')),
    ].join('\n');
    assert.match(readme, /GITHUB_DISPATCH_TOKEN/);
    assert.match(readme, /PAGER_HOOK_SECRET/);
    assert.match(readme, /x-pager-secret/);
    assert.match(readme, /Actions/);
    assert.match(readme, /`repo`/);
    assert.match(readme, /zero Cloudflare cron triggers/);
    assert.equal(readme.includes('35 3,8,9,22'), false);
    assert.match(readme, new RegExp(CRON_JOB_ORG_CRON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const clock of ['03:50', '08:50', '09:50', '22:50', '06:50', '11:50', '16:50', '17:50']) {
      assert.equal(readme.includes(clock), true, clock);
    }
    assert.equal(/ghp_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/.test(repoText), false);
  });
});
