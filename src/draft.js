'use strict';

// 草稿区一致性读取与复核（供即时发布 / 建立预约共用）。
//
// 背景：两个服务进程可共用同一 SQLite 数据库文件（WAL 模式）。即时发布与
// 建立预约都要先读草稿（事件 / 主张 / 关系）、求解，之后才进入写入事务。
// 若读取分多条语句进行，另一进程可能在语句之间一次性改动事件与主张，
// 使求解与冻结基于「从未同时存在过的混合内容」；预约还可能把旧快照配上
// 写入事务内新读到的修订号（旧内容记成新修订号）。
//
// 本模块提供两道防线（草稿区任何增删改都由触发器推进 draft_meta.revision）：
//   1) readConsistentDraft：先读修订号，再读事件 / 主张 / 关系，最后再读修订号；
//      两次一致才认为拿到同一份草稿状态，否则重试，重试耗尽抛 409 DRAFT_CONFLICT；
//   2) assertDraftRevisionUnchanged：写入事务（BEGIN IMMEDIATE，持写锁）内复核
//      修订号仍等于读取时的值；不等即抛 409 DRAFT_CONFLICT，事务整体回滚。
// 由此，一次操作冻结的事件、所选主张、关系、求解日期与修订号必属同一份
// 真实存在过的草稿状态；无法取得一致状态时整次不生成版本或预约。

const { getDb } = require('./db');

function draftRevisionNo() {
  return getDb().prepare('SELECT revision FROM draft_meta WHERE id = 1').get().revision;
}

// 单次读取：修订号 → 事件 / 主张 / 关系 → 修订号。
// 前后修订号一致时，三张表的内容必属同一份草稿状态（修订号单调递增，
// 任何草稿增删改都会推进它；读取期间若另一进程提交了改动，后读到的修订号必变大）。
function readDraftOnce() {
  const db = getDb();
  const revisionBefore = draftRevisionNo();
  const events = db.prepare('SELECT id, title, description FROM events ORDER BY id').all();
  const claims = db.prepare('SELECT * FROM claims').all();
  const relations = db
    .prepare('SELECT id, earlier_id AS earlierId, later_id AS laterId, source, note FROM relations ORDER BY id')
    .all();
  const revisionAfter = draftRevisionNo();
  return { revisionBefore, revisionAfter, events, claims, relations };
}

const DEFAULT_READ_ATTEMPTS = 5;

// 读取同一份草稿状态（事件 / 主张 / 关系 + 其修订号）。
// 读取期间另一进程改动草稿会使前后修订号不一致：重试至多 maxAttempts 次；
// 仍不稳定则抛 409 DRAFT_CONFLICT（调用方整次不落库）。
// readOnce 可注入（测试用），默认读真实草稿。
function readConsistentDraft({ maxAttempts = DEFAULT_READ_ATTEMPTS, readOnce = readDraftOnce } = {}) {
  for (let attempt = 1; ; attempt++) {
    const s = readOnce();
    if (s.revisionBefore === s.revisionAfter) {
      return { revisionNo: s.revisionAfter, events: s.events, claims: s.claims, relations: s.relations };
    }
    if (attempt >= maxAttempts) {
      throw {
        status: 409,
        code: 'DRAFT_CONFLICT',
        message:
          `草稿冲突：读取草稿期间内容被其它编辑改动（连续 ${maxAttempts} 次读取都未得到一致状态）。` +
          '本次未生成任何版本或预约，请重新查看最新草稿后再试。',
        currentRevisionNo: s.revisionAfter,
      };
    }
  }
}

// 写入事务内复核：自读取一致快照以来草稿未被改动（修订号未变）。
// 须在 BEGIN IMMEDIATE 事务内调用（持写锁，复核与后续写入之间无人能改草稿）。
// 变化即抛 409 DRAFT_CONFLICT；调用方事务整体回滚，不生成版本或预约。
function assertDraftRevisionUnchanged(expectedRevisionNo, actionLabel) {
  const current = draftRevisionNo();
  if (current !== expectedRevisionNo) {
    throw {
      status: 409,
      code: 'DRAFT_CONFLICT',
      message:
        `草稿冲突：${actionLabel}期间草稿被其它编辑改动（修订号 ${expectedRevisionNo} → ${current}）。` +
        '本次未生成任何版本或预约，请重新查看最新草稿后再试。',
      baseRevisionNo: expectedRevisionNo,
      currentRevisionNo: current,
    };
  }
}

module.exports = {
  draftRevisionNo,
  readDraftOnce,
  readConsistentDraft,
  assertDraftRevisionUnchanged,
  DEFAULT_READ_ATTEMPTS,
};
