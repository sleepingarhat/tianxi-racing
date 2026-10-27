#!/usr/bin/env tsx
/**
 * 頭對頭 API 合約：冇 secret → 401；type／id 驗證。
 * 用 Hono app + stub Env（無真 D1）；只驗閘同 400。
 */
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { clearMemoryCache } from '../src/lib/edge-cache';
import { labRoutes } from '../src/routes/lab';

async function main(): Promise<void> {
  const app = new Hono();
  app.route('/api/lab', labRoutes);

  async function hit(path: string, headers: Record<string, string> = {}, env: Record<string, unknown> = {}) {
    const req = new Request(`http://localhost${path}`, { headers });
    return app.fetch(req, { DB: null, SITE_READER_TOKEN: undefined, ...env } as any);
  }

  {
    const res = await hit('/api/lab/h2h?type=horse&a=horse_A&b=horse_B');
    assert.equal(res.status, 401, 'no secret → 401');
    const j = (await res.json()) as any;
    assert.equal(j.error, 'unauthorized');
  }

  {
    const res = await hit('/api/lab/search?type=jockey&q=潘');
    assert.equal(res.status, 401, 'search no secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=horse&a=horse_A&b=horse_B',
      { 'X-Tianxi-Site-Token': 'wrong' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 401, 'wrong secret → 401');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=owner&a=horse_A&b=horse_B',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad type → 400');
    const j = (await res.json()) as { error?: string };
    assert.equal(j.error, 'type 只接受 horse／jockey／trainer');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=trainer&a=horse_A&b=horse_B',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'trainer type rejects horse ids');
    const j = (await res.json()) as { error?: string };
    assert.equal(j.error, '對象 id 格式唔啱');
  }

  {
    const res = await hit(
      '/api/lab/search?type=owner&q=蔡',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'search bad type → 400');
    const j = (await res.json()) as { error?: string };
    assert.equal(j.error, 'type 只接受 horse／jockey／trainer');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=horse&a=J062&b=horse_B',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'bad id → 400');
  }

  {
    const res = await hit(
      '/api/lab/h2h?type=horse&a=horse_A&b=horse_A',
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret' },
    );
    assert.equal(res.status, 400, 'same a=b → 400');
  }

  const emptyDb = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return null;
            },
          };
        },
      };
    },
  };

  {
    const a = encodeURIComponent('jockey_潘頓');
    const b = encodeURIComponent('jockey_郭能');
    const res = await hit(
      `/api/lab/h2h?type=jockey&a=${a}&b=${b}`,
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret', DB: emptyDb },
    );
    assert.equal(res.status, 404, 'chinese jockey id passes format check');
    const j = (await res.json()) as { error?: string };
    assert.equal(j.error, '找不到對象');
  }

  {
    const a = encodeURIComponent("jockey_潘頓'");
    const b = encodeURIComponent('jockey_郭能');
    const res = await hit(
      `/api/lab/h2h?type=jockey&a=${a}&b=${b}`,
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret', DB: emptyDb },
    );
    assert.equal(res.status, 400, 'unsafe jockey id → 400');
    const j = (await res.json()) as { error?: string };
    assert.equal(j.error, '對象 id 格式唔啱');
  }

  {
    const a = encodeURIComponent('trainer_方嘉柏');
    const b = encodeURIComponent('trainer_蔡約翰');
    const res = await hit(
      `/api/lab/h2h?type=trainer&a=${a}&b=${b}`,
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret', DB: emptyDb },
    );
    assert.equal(res.status, 404, 'chinese trainer id passes format check');
    const j = (await res.json()) as { error?: string };
    assert.equal(j.error, '找不到對象');
  }

  {
    const a = encodeURIComponent('trainer_方 嘉柏');
    const b = encodeURIComponent('trainer_蔡約翰');
    const res = await hit(
      `/api/lab/h2h?type=trainer&a=${a}&b=${b}`,
      { 'X-Tianxi-Site-Token': 'correct-secret' },
      { SITE_READER_TOKEN: 'correct-secret', DB: emptyDb },
    );
    assert.equal(res.status, 400, 'unsafe trainer id → 400');
  }

  type SqlRow = Record<string, unknown>;
  function trainerDb(opts: {
    trainers: Record<string, SqlRow | null>;
    elo: Record<string, SqlRow[]> | 'missing';
    results: Record<string, SqlRow[]>;
  }) {
    return {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            const id = String(args[0] ?? '');
            return {
              async first() {
                if (/FROM trainers/i.test(sql)) return opts.trainers[id] ?? null;
                throw new Error(`unexpected first: ${sql}`);
              },
              async all() {
                if (/trainer_elo_snapshots/i.test(sql)) {
                  if (opts.elo === 'missing') {
                    throw new Error('D1_ERROR: no such table: trainer_elo_snapshots: SQLITE_ERROR');
                  }
                  return { results: opts.elo[id] ?? [] };
                }
                if (/race_results/i.test(sql)) return { results: opts.results[id] ?? [] };
                throw new Error(`unexpected all: ${sql}`);
              },
            };
          },
        };
      },
    };
  }

  const headers = { 'X-Tianxi-Site-Token': 'correct-secret' };
  const secretEnv = { SITE_READER_TOKEN: 'correct-secret' };

  {
    clearMemoryCache();
    const aId = 'trainer_方嘉柏';
    const bId = 'trainer_蔡約翰';
    const db = trainerDb({
      trainers: {
        [aId]: { id: aId, name_ch: '方嘉柏', name_en: 'C Fownes', is_active: 1 },
        [bId]: { id: bId, name_ch: '蔡約翰', name_en: 'A S Cruz', is_active: 1 },
      },
      elo: {
        [aId]: [
          { date: '2026-01-01', rating: 1520 },
          { date: '2026-02-01', rating: 1530 },
        ],
        [bId]: [{ date: '2026-01-01', rating: 1490 }],
      },
      results: {
        [aId]: [
          {
            entity_id: aId,
            race_id: 'race_1',
            date: '2026-01-01',
            venue: 'ST',
            race_number: 3,
            distance: 1200,
            going: '好地',
            track: '草地',
            draw: 2,
            position: 1,
            running_position: '1-1-1',
            total_runners: 12,
            last400: 22.4,
          },
          {
            entity_id: aId,
            race_id: 'race_2',
            date: '2026-02-01',
            venue: 'HV',
            race_number: 1,
            distance: 1650,
            going: '好地',
            track: '草地',
            draw: 5,
            position: 4,
            running_position: '4-4-4',
            total_runners: 12,
            last400: 23.1,
          },
        ],
        [bId]: [
          {
            entity_id: bId,
            race_id: 'race_1',
            date: '2026-01-01',
            venue: 'ST',
            race_number: 3,
            distance: 1200,
            going: '好地',
            track: '草地',
            draw: 8,
            position: 2,
            running_position: '3-2-2',
            total_runners: 12,
            last400: 22.8,
          },
        ],
      },
    });
    const res = await hit(
      `/api/lab/h2h?type=trainer&a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`,
      headers,
      { ...secretEnv, DB: db },
    );
    assert.equal(res.status, 200, 'trainer h2h happy path');
    const j = (await res.json()) as any;
    assert.equal(j.type, 'trainer');
    assert.equal(j.entities.a.id, aId);
    assert.equal(j.entities.a.nameCh, '方嘉柏');
    assert.equal(j.entities.a.code, null);
    assert.equal(j.entities.a.status, 'active');
    assert.equal(j.entities.b.nameEn, 'A S Cruz');
    assert.equal(j.elo.a.length, 2);
    assert.equal(j.elo.a[0].rating, 1520);
    assert.equal(j.elo.b.length, 1);
    assert.equal(j.conditions.find((c: any) => c.key === 'overall').a.starts, 2);
    assert.equal(j.conditions.find((c: any) => c.key === 'overall').b.starts, 1);
    assert.equal(j.meetings.length, 1);
    assert.equal(j.meetings[0].raceId, 'race_1');
    assert.equal(j.meetings[0].ahead, 'a');
    assert.equal(j.meta.rowCounts.a, 2);
    assert.equal(j.meta.rowCounts.b, 1);
  }

  {
    clearMemoryCache();
    const aId = 'trainer_姚本輝';
    const bId = 'trainer_呂健威';
    const db = trainerDb({
      trainers: {
        [aId]: { id: aId, name_ch: '姚本輝', name_en: 'P Yiu', is_active: 0 },
        [bId]: { id: bId, name_ch: '呂健威', name_en: 'D Cruz', is_active: 1 },
      },
      elo: 'missing',
      results: { [aId]: [], [bId]: [] },
    });
    const res = await hit(
      `/api/lab/h2h?type=trainer&a=${encodeURIComponent(aId)}&b=${encodeURIComponent(bId)}`,
      headers,
      { ...secretEnv, DB: db },
    );
    assert.equal(res.status, 200, 'missing trainer elo table still 200');
    const j = (await res.json()) as any;
    assert.deepEqual(j.elo.a, []);
    assert.deepEqual(j.elo.b, []);
    assert.equal(j.entities.a.status, 'inactive');
    assert.equal(j.conditions.find((c: any) => c.key === 'overall').a.starts, 0);
  }

  {
    const db = {
      prepare(sql: string) {
        assert.match(sql, /FROM trainers/i);
        assert.match(sql, /name_ch/);
        assert.match(sql, /name_en/);
        return {
          bind(...args: unknown[]) {
            assert.ok(args.every((a) => String(a).includes('蔡')));
            return {
              async all() {
                return {
                  results: [
                    { id: 'trainer_蔡約翰', name_ch: '蔡約翰', name_en: 'A S Cruz', is_active: 1 },
                    { id: 'trainer_蔡英偉', name_ch: null, name_en: 'Other', is_active: 0 },
                  ],
                };
              },
            };
          },
        };
      },
    };
    const res = await hit(
      `/api/lab/search?type=trainer&q=${encodeURIComponent('蔡')}`,
      headers,
      { ...secretEnv, DB: db },
    );
    assert.equal(res.status, 200, 'trainer search');
    const j = (await res.json()) as any;
    assert.equal(j.type, 'trainer');
    assert.equal(j.items.length, 2);
    assert.deepEqual(j.items[0], {
      id: 'trainer_蔡約翰',
      nameCh: '蔡約翰',
      nameEn: 'A S Cruz',
      code: '蔡約翰',
      status: 'active',
    });
    assert.equal(j.items[1].code, '蔡英偉');
    assert.equal(j.items[1].status, 'inactive');
    assert.equal(j.items[1].nameCh, null);
  }

  console.log('test-lab-h2h-auth: all passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
