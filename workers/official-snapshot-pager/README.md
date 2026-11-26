# Official snapshot pager

`tianxi-official-snapshot-pager` is a separate Cloudflare Worker. `POST /dispatch` starts GitHub Actions workflow `capy_official_snapshot.yml` on branch `main` with blank `date`, `venue`, and `kind`. Blank inputs let `scripts/official_snapshot_arm.py` plan the meeting. This Worker declares zero Cloudflare cron triggers.

Ingest stays in that GitHub Action. The Action still waits until `lockAt` when a run starts early, and it still writes `kind=freeze` when a run starts inside the window. This Worker does the HTTP call and returns. It does not crawl HKJC, write `data/official_snapshots`, write D1, or sleep until `lockAt`.

`tianxi-backend` stays a reader. `backend_deploy.yml` publishes only `backend/**`. This directory has its own `wrangler.toml`, no `[[routes]]`, and no binding to `tianxi.racing`.

Production deploy and secret setup wait until this change is approved. This repository does not contain token values.

## External clock

Cron fields below are UTC. Hong Kong civil time is UTC+8 all year.

This Worker has no `[triggers]` block and no `crons` list. Workers Free allows **5 cron triggers per account**. `backend/wrangler.toml` for `tianxi-backend` already declares **6**:

| Expression | HKT | Job |
| --- | --- | --- |
| `0 19 * * *` | 03:00 | past-meeting hit-rate cache |
| `0 22 * * *` | 06:00 | race-day report |
| `0 3 * * *` | 11:00 | report refresh |
| `0 4 * * *` | 12:00 | report refresh |
| `0 10 * * *` | 18:00 | report refresh |
| `*/5 * * * *` | every 5 minutes | prediction lock tick |

A pager cron would not stay on the free plan. Those six reader crons stay in `tianxi-backend`. These pokes are not added there. This Worker sets no `usage_model`, no `limits.cpu_ms`, no Durable Objects, no Queues, and no custom routes. An HTTP request has no wall-time cap on the free plan; this handler returns after one GitHub call. Free-plan CPU time is **10 ms** per request, and the wait on `fetch` does not count as CPU time.

The free clock is [cron-job.org](https://cron-job.org) calling `POST /dispatch` on:

`50 3,8,9,22 * * *`

| UTC | HKT | Role |
| --- | --- | --- |
| 22:50 | 06:50 the same Hong Kong morning | Before a Sha Tin day lock. For 2026-11-29, 06:50 is 265 minutes before lockAt 11:15, inside the Action's 330-minute arm. The Action waits until `lockAt`. |
| 03:50 | 11:50 | Inside the Sha Tin example window 11:15–12:45 (2026-11-29, first post 12:45). |
| 08:50 | 16:50 | 20 minutes before a Happy Valley 17:10 lock. |
| 09:50 | 17:50 | Inside the Happy Valley example window 17:10–18:40. |

Minute 50 is offset from the workflow's own best-effort arms at 22:20, 03:20, 04:10, 08:10, and 09:20 UTC (06:20, 11:20, 12:10, 16:10, and 17:20 HKT).

The pokes run every day. On a day with no meeting inside the arm horizon, the Action plans `no_meeting` and exits. `workflow_dispatch` is not season-skipped, so an off-season day still gets these short runs. A race day still runs when `/api/season` is wrong.

## HTTP hook

`GET /` returns `{"ok":true,"service":"tianxi-official-snapshot-pager"}` and does not dispatch.

`POST /dispatch` dispatches. The shared secret travels in a header:

```
x-pager-secret: <PAGER_HOOK_SECRET>
```

The URL is the `workers.dev` host printed by the approved deploy, plus `/dispatch`. There is no custom domain in this config. Send no query string. A query string is rejected and does not dispatch, including when the header is also present. `GET /dispatch` does not dispatch.

Success is HTTP 200 and a body like:

```json
{"ok":true,"dispatched":true,"workflow":"capy_official_snapshot.yml","ref":"main","github_status":204}
```

`github_status` 204 is the pinned GitHub API (`2022-11-28`). `github_status` 200 is also treated as success. The Worker does not copy GitHub's response body. `401` means the header does not match. `503` with `hook_secret_not_configured` or `dispatch_token_not_configured` means that Worker secret is empty. `502` means GitHub or the network failed; `github_status` 401 or 403 means the PAT cannot dispatch this workflow.

## cron-job.org

cron-job.org is the free clock. It calls this Worker. It never receives the GitHub token, and the token is never placed in a cron-job.org URL, header, or body.

Create one job at <https://console.cron-job.org/jobs/create>:

| Field | Value |
| --- | --- |
| URL | `https://<worker-subdomain>.workers.dev/dispatch` |
| Timezone | UTC |
| Schedule | minute 50 of hours 3, 8, 9, and 22, which is `50 3,8,9,22 * * *` |
| Request method | POST |
| Request body | empty |
| Header name | `x-pager-secret` |
| Header value | the same string stored as Worker secret `PAGER_HOOK_SECRET` |

If the schedule UI is set to `Asia/Hong_Kong` instead of UTC, use 06:50, 11:50, 16:50, and 17:50. Those HKT times are the same instants.

| UTC | HKT | Role |
| --- | --- | --- |
| 22:50 | 06:50 | Before the Sha Tin 11:15 lock (265 minutes, inside the 330-minute arm) |
| 03:50 | 11:50 | Inside the Sha Tin 11:15–12:45 window |
| 08:50 | 16:50 | 20 minutes before the Happy Valley 17:10 lock |
| 09:50 | 17:50 | Inside the Happy Valley 17:10–18:40 window |

cron-job.org allows custom headers and POST, ignores a caller `User-Agent`, and stores response bodies for about two days. This Worker's JSON has no secret in it. The hook secret is visible to whoever can open that cron-job.org job. Its only power is to start this one workflow on `main` with blank inputs. The GitHub PAT stays in Cloudflare.

A cron-job.org test run, after the Worker is deployed and both secrets are set, starts a real Actions run. Do that only after approval.

## Secrets

Set both with the interactive wrangler prompt from `workers/official-snapshot-pager`, after approval. The prompt keeps the value off the command line.

```sh
npx wrangler@4.83.0 secret put GITHUB_DISPATCH_TOKEN
npx wrangler@4.83.0 secret put PAGER_HOOK_SECRET
```

Generate the hook secret on the operator machine, for example `openssl rand -hex 32`, then paste that same string into the wrangler prompt and into the cron-job.org header. Do not commit it, print it in a PR, or put it in a URL.

### `GITHUB_DISPATCH_TOKEN`

Worker secret only. GitHub token used as `Authorization: Bearer` on:

`POST /repos/sleepingarhat/tianxi-racing/actions/workflows/capy_official_snapshot.yml/dispatches`

Preferred: a fine-grained personal access token limited to repository `sleepingarhat/tianxi-racing`, with **Actions: Read and write**. That is the permission GitHub documents for this endpoint. Metadata read comes with every fine-grained token. Do not grant Contents write, Secrets, or Administration.

Classic personal access token: the **`repo`** scope, which is what GitHub's REST docs require for "Create a workflow dispatch event". Prefer the fine-grained token so the credential is this repository only.

When the token expires, dispatches fail with `github_status` 401 until `wrangler secret put GITHUB_DISPATCH_TOKEN` replaces it. Wrangler overwrites the previous value. The new value is not printed.

### `PAGER_HOOK_SECRET`

Worker secret, and the cron-job.org `x-pager-secret` header. It is compared by hashing both sides and XOR-ing the digests. An empty secret makes `POST /dispatch` return 503.

## Deploy after approval

From `workers/official-snapshot-pager`:

```sh
npx wrangler@4.83.0 deploy
npx wrangler@4.83.0 secret put GITHUB_DISPATCH_TOKEN
npx wrangler@4.83.0 secret put PAGER_HOOK_SECRET
```

Deploy first so the script exists, then put the secrets. Until the token secret exists, `POST /dispatch` returns `dispatch_token_not_configured` and does not call GitHub. Copy the `workers.dev` URL from the deploy output. Then:

```sh
curl -sS -X POST "$PAGER_URL/dispatch" -H "x-pager-secret: $PAGER_HOOK_SECRET"
```

Set `PAGER_URL` and `PAGER_HOOK_SECRET` in the operator shell only. A `"dispatched": true` body means GitHub accepted the dispatch, and the Actions tab should show `capy_official_snapshot.yml`. That run is the existing ingest workflow, including its wait when `lockAt` is still ahead.

`npm test` and `npm run typecheck` in this directory do not deploy and do not read secrets. `.github/workflows/official_snapshot_pager_checks.yml` runs those two commands on pull requests that touch this directory.

## Residual risk

This still cannot guarantee a freeze snapshot.

- cron-job.org warns that peak hours can delay a job, and it closes the connection after 30 seconds. A skipped job leaves no Cloudflare failure. This Worker returns after one GitHub call. GitHub's own `schedule` on the workflow remains a separate best-effort arm and is not a delivered clock.
- GitHub may queue the dispatched run. The workflow concurrency group is `capy-official-snapshot` with `cancel-in-progress: false`, so a second poke waits behind a run that is already sleeping until `lockAt`. The queued run still starts later. Snapshot writes stay append-only.
- A meeting whose lock is more than 330 minutes after every poke, and whose `[lockAt, firstPostAt)` contains none of the poke times, is outside this clock. `workflow_run` from racecard, race day, track conditions, and odds remains the other catch-up. Another UTC hour can be added on the cron-job.org job without a Cloudflare cron trigger.
- The 2026-11-25 Happy Valley miss stays `freeze_missed_window`. This pager does not backfill it.
- cron-job.org and the workflow's own schedule can both start Actions runs. That costs minutes. It does not overwrite an existing freeze.
- Free-plan CPU is 10 ms. This handler is one small JSON body and one `fetch`. If an invocation is killed for CPU, that poke is lost and a later poke in the same window is the retry.
