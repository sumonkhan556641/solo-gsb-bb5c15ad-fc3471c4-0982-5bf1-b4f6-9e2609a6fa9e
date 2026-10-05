'use strict';

// 从任一已发布版本预览并恢复草稿。
//
// 预览（buildRestorePreview）只读：列出目标版本的事件、被选时间主张、
// 「先于」关系，以及当前草稿中将被替换的内容。
//
// 确认（restoreDraftFromVersion）在一个事务内原子地：
//   1. 校验版本仍存在、最新版本号与预览时一致、草稿修订号与预览时一致；
//   2. 清空整个草稿区（按依赖顺序显式删除 relations / claims / events）；
//   3. 按版本快照重建事件、关系；每事件只复制当版被选的那一条主张；
//   4. 重置自增序号，使新草稿 id 从 1 开始；
//   5. 在 draft_restores 追加一行恢复登记（草稿代 +1），开启中的并行编辑会话
//      据此识别基线对象身份已被恢复更替。
// 历史版本快照（versions / version_events / version_relations）不动，
// 访客年表因此保持不变。

const { getDb } = require('./db');
const { parseClaimDate, claimInterval, formatClaimDate } = require('./dates');
const { getVersionDetail, latestVersionNo } = require('./publish');
// 草稿修订号读取统一由 draft.js 提供（发布 / 预约的一致性读取也用它），
// 这里再导出以保持既有引用（bundle / session / routes）不变。
const { draftRevisionNo } = require('./draft');

// 当前「草稿代」：已确认恢复的次数（draft_restores 最大行号）。
// 恢复会整体替换草稿并重排对象编号；并行编辑会话以此识别基线对象身份是否已更替。
function draftRestoreNo() {
  return getDb().prepare('SELECT COALESCE(MAX(id), 0) AS n FROM draft_restores').get().n;
}

function draftEventApi(row) {
  const claims = getDb()
    .prepare('SELECT * FROM claims WHERE event_id = ? ORDER BY id')
    .all(row.id)
    .map((c) => ({
      id: c.id,
      eventId: c.event_id,
      precision: c.precision,
      year: c.year,
      month: c.month,
      day: c.day,
      dateLabel: c.date_label,
      intervalStart: c.interval_start,
      intervalEnd: c.interval_end,
      source: c.source,
      note: c.note,
    }));
  return { id: row.id, title: row.title, description: row.description, claims };
}

// 当前草稿全貌（用于预览中展示「将被替换的内容」）。
function currentDraftSnapshot() {
  const db = getDb();
  const events = db.prepare('SELECT * FROM events ORDER BY id').all().map(draftEventApi);
  const relations = db
    .prepare('SELECT * FROM relations ORDER BY id')
    .all()
    .map((r) => ({
      id: r.id,
      earlierId: r.earlier_id,
      laterId: r.later_id,
      source: r.source,
      note: r.note,
    }));
  const eventCount = events.length;
  const claimCount = events.reduce((n, e) => n + e.claims.length, 0);
  return { events, relations, counts: { eventCount, claimCount, relationCount: relations.length } };
}

// 只读预览，不改任何数据。返回 null 表示版本不存在。
function buildRestorePreview(versionNo) {
  const version = getVersionDetail(versionNo);
  if (!version) return null;
  const current = currentDraftSnapshot();
  return {
    versionNo,
    draftRevisionNo: draftRevisionNo(),
    currentVersionNo: latestVersionNo(),
    version,
    currentDraft: current,
  };
}

// 由快照区间起点与精度还原 year/month/day，再用 dates 工具重算区间，
// 保证重建出的主张与现有录入路径完全一致。
function claimPartsFromSnapshot(ev) {
  const [y, m, d] = ev.intervalStart.split('-').map(Number);
  const input = {
    precision: ev.precision,
    year: y,
    month: ev.precision === 'year' ? undefined : m,
    day: ev.precision === 'day' ? d : undefined,
  };
  const parsed = parseClaimDate(input);
  const iv = claimInterval(parsed.precision, parsed.year, parsed.month, parsed.day);
  return {
    precision: parsed.precision,
    year: parsed.year,
    month: parsed.month,
    day: parsed.day,
    dateLabel: formatClaimDate(parsed.precision, parsed.year, parsed.month, parsed.day),
    intervalStart: iv.start,
    intervalEnd: iv.end,
  };
}

// 确认恢复。expectedRevision: 预览时草稿修订号；expectedLatestVersionNo: 预览时最新版本号。
// 抛 { status, ...body } 表示 HTTP 错误；成功返回新草稿状态与旧→新 id 映射。
function restoreDraftFromVersion({ versionNo, expectedRevision, expectedLatestVersionNo }) {
  const db = getDb();
  const version = getVersionDetail(versionNo);
  if (!version) {
    throw { status: 404, message: `版本 ${versionNo} 不存在，无法恢复` };
  }

  const tx = db.transaction(() => {
    // 事务内重新确认最新版本号与草稿修订号，避免并发下的静默覆盖
    const latest = latestVersionNo();
    if (Number(expectedLatestVersionNo) !== latest) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：你预览时最新是第 ${expectedLatestVersionNo} 版，现在已是第 ${latest} 版。请重新预览后再恢复。`,
        currentVersionNo: latest,
        expectedVersionNo: Number(expectedLatestVersionNo),
      };
    }
    const revision = draftRevisionNo();
    if (Number(expectedRevision) !== revision) {
      throw {
        status: 409,
        code: 'DRAFT_REVISION_CONFLICT',
        message: `草稿冲突：你预览恢复时草稿修订号为 ${expectedRevision}，现在已变为 ${revision}（期间草稿被修改过）。请重新预览后再恢复。`,
        currentRevisionNo: revision,
        expectedRevisionNo: Number(expectedRevision),
      };
    }

    const eventMap = []; // {oldId, newId, oldClaimId, newClaimId}
    const relationMap = [];

    // 清空整个草稿区；显式按依赖顺序删除（不依赖外键级联设置）
    db.prepare('DELETE FROM relations').run();
    db.prepare('DELETE FROM claims').run();
    db.prepare('DELETE FROM events').run();

    // 重置草稿表自增序号，新草稿 id 从 1 开始（不动 versions 区）
    db.prepare("UPDATE sqlite_sequence SET seq = 0 WHERE name IN ('events', 'claims', 'relations')").run();

    const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
    const insClaim = db.prepare(`
      INSERT INTO claims
        (event_id, precision, year, month, day, date_label, interval_start, interval_end, source, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 快照事件按 sort_order 排列；只恢复当版被选的一条主张
    for (const ev of version.events) {
      const evInfo = insEvent.run(ev.title, ev.description || '');
      const newEventId = evInfo.lastInsertRowid;
      const parts = claimPartsFromSnapshot(ev);
      const claimInfo = insClaim.run(
        newEventId,
        parts.precision,
        parts.year,
        parts.month,
        parts.day,
        parts.dateLabel,
        parts.intervalStart,
        parts.intervalEnd,
        ev.source || '',
        ev.claimNote || ''
      );
      eventMap.push({
        oldEventId: ev.eventId,
        newEventId,
        oldClaimId: ev.claimId,
        newClaimId: claimInfo.lastInsertRowid,
      });
    }

    const newEventIdByOld = new Map(eventMap.map((m) => [m.oldEventId, m.newEventId]));
    const insRel = db.prepare(
      'INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)'
    );
    for (const rel of version.relations) {
      const newEarlier = newEventIdByOld.get(rel.earlierEventId);
      const newLater = newEventIdByOld.get(rel.laterEventId);
      const info = insRel.run(newEarlier, newLater, rel.source || '', rel.note || '');
      relationMap.push({
        oldRelationId: rel.relationId,
        newRelationId: info.lastInsertRowid,
        oldEarlierEventId: rel.earlierEventId,
        newEarlierEventId: newEarlier,
        oldLaterEventId: rel.laterEventId,
        newLaterEventId: newLater,
      });
    }

    // 上面的 DELETE/INSERT 每一条都触发了修订号自增；恢复作为一次原子操作，
    // 只应算一次草稿变更，最终把修订号校正为预览时的值 + 1。
    db.prepare('UPDATE draft_meta SET revision = ? WHERE id = 1').run(Number(expectedRevision) + 1);

    // 登记本次恢复（只追加）：恢复重排了对象编号，开启中的并行编辑会话据此
    // 识别基线对象身份已更替，提交时整次拒绝而不是把改动合并到同编号的新对象上。
    db.prepare('INSERT INTO draft_restores (version_no) VALUES (?)').run(versionNo);

    return { eventMap, relationMap };
  });

  const { eventMap, relationMap } = tx();

  const draft = currentDraftSnapshot();
  // 恢复后每事件只有一条（当版被选）主张，供编辑台直接填好单选、继续校验发布
  const pendingSelection = eventMap.map((m) => ({
    eventId: m.newEventId,
    claimId: m.newClaimId,
  }));

  return {
    restoredFromVersionNo: versionNo,
    currentVersionNo: latestVersionNo(),
    revisionNo: draftRevisionNo(),
    idMap: { events: eventMap, relations: relationMap },
    pendingSelection,
    draft,
  };
}

module.exports = {
  buildRestorePreview,
  restoreDraftFromVersion,
  draftRevisionNo,
  draftRestoreNo,
};
