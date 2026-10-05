'use strict';

// 草稿一致性（两进程共用同一数据库）测试：
//   - readConsistentDraft 的重试 / 冲突行为（注入读取器，确定性）；
//   - 即时发布 / 建立预约在「读取与写入之间草稿被改」时返回 409 DRAFT_CONFLICT，
//     整次不生成版本或预约（模块补丁模拟并发交错，确定性）；
//   - 真实两进程共用同一数据库文件：子进程在读取与写入之间提交改动，
//     发布 / 预约必须报草稿冲突且不落库（文件信号同步，确定性）；
//   - 两进程持续并发下的压力不变量：冻结内容永远来自同一份草稿状态、
//     版本号连续无空洞、除 409 DRAFT_CONFLICT 外不出现其它错误。

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 每个测试文件独立内存库
const mem = new Database(':memory:');
const { SCHEMA, setDb, getDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app, scheduler } = require('../src/server');
const draftMod = require('../src/draft');
const { publishVersion, latestVersionNo } = require('../src/publish');
const { createSchedule } = require('../src/schedule');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  scheduler.stop();
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM publish_schedules;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

// 基础草稿：e1（1958-09-12）先于 e2（1959-05），返回 selection 等
async function setupDraft() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: '李宝山口述' });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: '王秀兰口述' });
  await makeRel(e1, e2, '二人口述一致');
  return { e1, e2, c1, c2, selection: [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }] };
}

function secondsFromNow(deltaSec) {
  return new Date(Date.now() + deltaSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// 打补丁：readConsistentDraft 返回真实一致状态后、调用方进入写入事务前，
// 直接改一次草稿（模拟另一进程在读取与写入之间提交改动），再返回已过期状态。
function patchReadThenMutate(mutate) {
  const real = draftMod.readConsistentDraft;
  draftMod.readConsistentDraft = (opts) => {
    const state = real(opts);
    mutate();
    return state;
  };
  return () => {
    draftMod.readConsistentDraft = real;
  };
}

// ---------- 单元：readConsistentDraft ----------

test('readConsistentDraft：返回与草稿表一致的内容与修订号', async () => {
  const { e1, e2 } = await setupDraft();
  const s = draftMod.readConsistentDraft();
  assert.strictEqual(s.revisionNo, draftMod.draftRevisionNo());
  assert.deepStrictEqual(s.events.map((e) => e.id), [e1, e2]);
  assert.strictEqual(s.claims.length, 2);
  assert.strictEqual(s.relations.length, 1);
});

test('readConsistentDraft：读取期间被改动会重试，稳定后返回一致状态', () => {
  let calls = 0;
  const stable = { revisionBefore: 7, revisionAfter: 7, events: [{ id: 1 }], claims: [], relations: [] };
  const s = draftMod.readConsistentDraft({
    readOnce: () => {
      calls++;
      // 前两次读取期间「另一进程」改动了草稿（前后修订号不一致）
      if (calls <= 2) return { revisionBefore: calls, revisionAfter: calls + 1, events: [], claims: [], relations: [] };
      return stable;
    },
  });
  assert.strictEqual(calls, 3);
  assert.strictEqual(s.revisionNo, 7);
  assert.deepStrictEqual(s.events, [{ id: 1 }]);
});

test('readConsistentDraft：持续不稳定时抛 409 DRAFT_CONFLICT，不重试无限次', () => {
  let calls = 0;
  assert.throws(
    () =>
      draftMod.readConsistentDraft({
        maxAttempts: 3,
        readOnce: () => {
          calls++;
          return { revisionBefore: calls, revisionAfter: calls + 100, events: [], claims: [], relations: [] };
        },
      }),
    (e) => {
      assert.strictEqual(e.status, 409);
      assert.strictEqual(e.code, 'DRAFT_CONFLICT');
      assert.match(e.message, /草稿冲突/);
      assert.strictEqual(e.currentRevisionNo, 103);
      return true;
    }
  );
  assert.strictEqual(calls, 3);
});

// ---------- HTTP：读取与写入之间草稿被改（模拟另一进程） ----------

test('即时发布：读取与写入之间草稿被改 → 409 DRAFT_CONFLICT，不生成版本；可重试成功', async () => {
  const { e1, selection } = await setupDraft();
  const first = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 0, editor: '甲' },
  });
  assert.strictEqual(first.status, 201);
  assert.strictEqual(first.json.versionNo, 1);

  const unpatch = patchReadThenMutate(() => {
    mem.prepare("UPDATE events SET title = title || '（另一进程改动）' WHERE id = ?").run(e1);
  });
  try {
    const r = await call('POST', '/api/editor/publish', {
      body: { selection, baseVersionNo: 1, editor: '乙' },
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.json));
    assert.strictEqual(r.json.code, 'DRAFT_CONFLICT');
    assert.match(r.json.message, /草稿冲突/);
    assert.strictEqual(typeof r.json.currentRevisionNo, 'number');
    assert.strictEqual(typeof r.json.baseRevisionNo, 'number');
  } finally {
    unpatch();
  }

  // 整次不生成版本：最新版仍是第 1 版
  const state = await call('GET', '/api/editor/state');
  assert.strictEqual(state.json.currentVersionNo, 1);

  // 冲突后基于最新草稿重试即可成功
  const retry = await call('POST', '/api/editor/publish', {
    body: { selection, baseVersionNo: 1, editor: '乙' },
  });
  assert.strictEqual(retry.status, 201);
  assert.strictEqual(retry.json.versionNo, 2);
});

test('建立预约：读取与写入之间草稿被改 → 409 DRAFT_CONFLICT，不建立预约；可重试成功', async () => {
  const { e1, selection } = await setupDraft();

  const unpatch = patchReadThenMutate(() => {
    mem.prepare("UPDATE events SET title = title || '（另一进程改动）' WHERE id = ?").run(e1);
  });
  try {
    const r = await call('POST', '/api/editor/schedules', {
      body: { selection, scheduledAt: secondsFromNow(3600), baseVersionNo: 0 },
    });
    assert.strictEqual(r.status, 409, JSON.stringify(r.json));
    assert.strictEqual(r.json.code, 'DRAFT_CONFLICT');
    assert.match(r.json.message, /草稿冲突/);
  } finally {
    unpatch();
  }

  // 整次不建立预约
  const list = await call('GET', '/api/editor/schedules');
  assert.strictEqual(list.json.schedules.length, 0);

  // 重试成功；预约记录的草稿修订号与冻结内容同属一份草稿状态
  const ok = await call('POST', '/api/editor/schedules', {
    body: { selection, scheduledAt: secondsFromNow(3600), baseVersionNo: 0 },
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  const state = await call('GET', '/api/editor/state');
  assert.strictEqual(ok.json.schedule.draftRevisionNo, state.json.draftRevisionNo);
  assert.strictEqual(ok.json.schedule.frozen.events.length, 2);
});

test('读取阶段持续不稳定：发布与预约都返回 409 DRAFT_CONFLICT 且不落库', async () => {
  const { selection } = await setupDraft();
  const real = draftMod.readConsistentDraft;
  draftMod.readConsistentDraft = () =>
    real({
      maxAttempts: 2,
      readOnce: () => ({ revisionBefore: 1, revisionAfter: 2, events: [], claims: [], relations: [] }),
    });
  try {
    const pub = await call('POST', '/api/editor/publish', {
      body: { selection, baseVersionNo: 0, editor: '甲' },
    });
    assert.strictEqual(pub.status, 409);
    assert.strictEqual(pub.json.code, 'DRAFT_CONFLICT');

    const sch = await call('POST', '/api/editor/schedules', {
      body: { selection, scheduledAt: secondsFromNow(3600), baseVersionNo: 0 },
    });
    assert.strictEqual(sch.status, 409);
    assert.strictEqual(sch.json.code, 'DRAFT_CONFLICT');
  } finally {
    draftMod.readConsistentDraft = real;
  }

  const state = await call('GET', '/api/editor/state');
  assert.strictEqual(state.json.currentVersionNo, 0);
  const list = await call('GET', '/api/editor/schedules');
  assert.strictEqual(list.json.schedules.length, 0);
});

// ---------- 真实两进程共用同一数据库文件 ----------

const REPO_ROOT = path.join(__dirname, '..');

// 子进程脚本：等待 go 信号文件出现，然后对草稿做一次提交改动，写 done 信号文件。
// 父进程在 readConsistentDraft 返回后、写入事务前放行子进程，
// 确定性地复现「读取与写入之间另一进程提交改动」的并发窗口。
const CHILD_MUTATE_ONCE = `
const fs = require('fs');
const Database = require('better-sqlite3');
const [dbFile, goFile, doneFile] = process.argv.slice(1);
const db = new Database(dbFile);
db.pragma('busy_timeout = 5000');
const deadline = Date.now() + 20000;
while (!fs.existsSync(goFile)) {
  if (Date.now() > deadline) { console.error('child: 等待 go 信号超时'); process.exit(2); }
}
db.prepare("UPDATE events SET title = title || '（另一进程改动）' WHERE id = (SELECT MIN(id) FROM events)").run();
fs.writeFileSync(doneFile, String(Date.now()));
db.close();
`;

// 子进程脚本：持续不断地整表改标题（每次提交一个统一标记），用于压力不变量测试。
// 分片提交（每片 20ms、间隔 5ms），避免与并行运行的其它测试文件争抢 CPU。
const CHILD_HAMMER = `
const Database = require('better-sqlite3');
const [dbFile, runMs] = process.argv.slice(1);
const db = new Database(dbFile);
db.pragma('busy_timeout = 5000');
const stop = Date.now() + Number(runMs);
const upd = db.prepare('UPDATE events SET title = ?');
let n = 0;
function burst() {
  const burstEnd = Date.now() + 20;
  while (Date.now() < burstEnd && Date.now() < stop) { n++; upd.run('R' + n); }
  if (Date.now() < stop) setTimeout(burst, 5);
  else { db.close(); console.log('child commits:', n); }
}
burst();
`;

function spawnChild(script, args) {
  const child = spawn(process.execPath, ['-e', script, ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`子进程退出码 ${code}：${stderr}`))));
  });
  return { child, exited };
}

// 在临时目录建文件库并切换为当前库；返回清理函数
function useFileDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chronicle-twoproc-'));
  const dbFile = path.join(dir, 'chronicle.db');
  const conn = new Database(dbFile);
  conn.pragma('busy_timeout = 5000');
  conn.exec(SCHEMA);
  setDb(conn);
  return {
    dir,
    dbFile,
    conn,
    cleanup() {
      setDb(mem);
      conn.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// 直接向文件库播种 n 个事件（每事件一条主张，无关系），返回 selection
function seedFileDraft(conn, n) {
  const insEvent = conn.prepare('INSERT INTO events (title, description) VALUES (?, \'\')');
  const insClaim = conn.prepare(
    `INSERT INTO claims (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
     VALUES (?, 'year', 1958, NULL, NULL, '1958 年', '1958-01-01', '1958-12-31', '出处', '')`
  );
  const selection = [];
  conn.transaction(() => {
    for (let i = 1; i <= n; i++) {
      const eid = insEvent.run('R0').lastInsertRowid;
      const cid = insClaim.run(eid).lastInsertRowid;
      selection.push({ eventId: Number(eid), claimId: Number(cid) });
    }
  })();
  return selection;
}

test('两进程共用数据库：另一进程在读取与写入之间提交改动 → 409 DRAFT_CONFLICT，整次不落库', async () => {
  const { dir, dbFile, cleanup } = useFileDb();
  try {
    const selection = seedFileDraft(getDb(), 3);

    // 每一轮：启动子进程（等信号），打补丁放行，执行操作，校验冲突且不落库
    const runRound = async (round, op) => {
      const goFile = path.join(dir, `go-${round}`);
      const doneFile = path.join(dir, `done-${round}`);
      const { exited } = spawnChild(CHILD_MUTATE_ONCE, [dbFile, goFile, doneFile]);
      const real = draftMod.readConsistentDraft;
      draftMod.readConsistentDraft = (opts) => {
        const state = real(opts);
        // 读取完成、写入事务未开始：放行子进程提交改动，并等它提交完毕
        fs.writeFileSync(goFile, 'go');
        const deadline = Date.now() + 20000;
        while (!fs.existsSync(doneFile)) {
          if (Date.now() > deadline) throw new Error('子进程未及时提交改动');
        }
        return state; // 返回已过期的一致状态
      };
      try {
        op();
        assert.fail('应抛出 409 DRAFT_CONFLICT');
      } catch (e) {
        assert.strictEqual(e.status, 409, JSON.stringify(e));
        assert.strictEqual(e.code, 'DRAFT_CONFLICT');
        assert.match(e.message, /草稿冲突/);
      } finally {
        draftMod.readConsistentDraft = real;
      }
      await exited;
    };

    // 即时发布：冲突且不生成版本
    await runRound(1, () => publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '甲', note: '' }));
    assert.strictEqual(latestVersionNo(), 0);
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS n FROM versions').get().n, 0);

    // 建立预约：冲突且不写预约行
    await runRound(2, () =>
      createSchedule({ selectionList: selection, scheduledAtRaw: secondsFromNow(3600), baseVersionNo: 0, editor: '甲', note: '' })
    );
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS n FROM publish_schedules').get().n, 0);

    // 子进程已停：同一操作随即成功（冲突不是永久状态）
    const pub = publishVersion({ selectionList: selection, baseVersionNo: 0, editor: '甲', note: '' });
    assert.strictEqual(pub.versionNo, 1);
  } finally {
    cleanup();
  }
});

test('两进程持续并发：发布/预约的冻结内容永远来自同一份草稿状态，版本号连续', async () => {
  const { dbFile, cleanup } = useFileDb();
  try {
    const selection = seedFileDraft(getDb(), 200);
    const { exited } = spawnChild(CHILD_HAMMER, [dbFile, '1600']);

    const counts = { published: 0, publishConflict: 0, scheduled: 0, scheduleConflict: 0 };
    let latest = 0;
    const stop = Date.now() + 1500;
    while (Date.now() < stop) {
      try {
        const r = publishVersion({ selectionList: selection, baseVersionNo: latest, editor: '压力', note: '' });
        assert.strictEqual(r.versionNo, latest + 1, '版本号必须连续（无半版空洞）');
        latest = r.versionNo;
        const titles = new Set(r.version.events.map((e) => e.title));
        assert.strictEqual(titles.size, 1, `冻结内容必须来自同一份草稿状态，实际混入了 ${titles.size} 种状态`);
        counts.published++;
      } catch (e) {
        assert.strictEqual(e.status, 409, `只允许 409 草稿冲突，实际：${JSON.stringify(e)}`);
        assert.strictEqual(e.code, 'DRAFT_CONFLICT');
        counts.publishConflict++;
      }
      try {
        const s = createSchedule({
          selectionList: selection,
          scheduledAtRaw: secondsFromNow(3600),
          baseVersionNo: latest,
          editor: '压力',
          note: '',
        });
        const titles = new Set(s.frozen.events.map((e) => e.title));
        assert.strictEqual(titles.size, 1, '预约冻结内容必须来自同一份草稿状态');
        counts.scheduled++;
      } catch (e) {
        assert.strictEqual(e.status, 409, `只允许 409 草稿冲突，实际：${JSON.stringify(e)}`);
        assert.strictEqual(e.code, 'DRAFT_CONFLICT');
        counts.scheduleConflict++;
      }
      // 让出事件循环，避免与并行测试文件争抢 CPU
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await exited;

    // 子进程停止后发布恢复成功，版本号继续连续
    const final = publishVersion({ selectionList: selection, baseVersionNo: latest, editor: '收尾', note: '' });
    assert.strictEqual(final.versionNo, latest + 1);
    console.log(
      `  两进程压力：发布成功 ${counts.published} 次 / 草稿冲突 ${counts.publishConflict} 次；` +
        `预约成功 ${counts.scheduled} 次 / 草稿冲突 ${counts.scheduleConflict} 次`
    );
  } finally {
    cleanup();
  }
});
