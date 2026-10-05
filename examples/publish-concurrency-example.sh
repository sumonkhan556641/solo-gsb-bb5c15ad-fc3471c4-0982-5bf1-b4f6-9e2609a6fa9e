#!/usr/bin/env bash
# 两进程共用同一数据库时，即时发布 / 建立预约的草稿一致性端到端示例。
#
# 场景：主服务（BASE，已按 README 启动）之外，本脚本用同一数据库文件再启动
# 第二个服务进程（SECOND_PORT），两个进程共用一份 SQLite 数据库（WAL）。
#
# 流程：建草稿 → 两进程同时即时发布（同一 baseVersionNo）
#       → 恰一个 201，另一个 409 VERSION_CONFLICT（既有语义不变）
#       → 第二进程持续改草稿，主进程循环发布 / 建立预约：
#         要么 201（冻结内容来自同一份草稿状态），要么 409 DRAFT_CONFLICT
#         （读取与写入之间草稿被另一进程改动，整次不生成版本或预约）
#       → 停止改动后发布立即成功；版本号连续无空洞（不留半版）
#       → 短预约到期自动发布（到期语义不变）。
#
# 依赖：curl 与 node。
# 用法：
#   BASE=http://localhost:3000 TOKEN=editor DB_PATH=./data/chronicle.db \
#     bash examples/publish-concurrency-example.sh
# DB_PATH 必须与主服务使用的数据库文件相同（默认 ./data/chronicle.db）。
# 若已自行启动第二进程，可用 SECOND_BASE=http://localhost:3100 跳过脚本拉起。
# 总耗时约 20 秒。可重复运行（标题带时间戳）。
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
TOKEN="${TOKEN:-editor}"
DB_PATH="${DB_PATH:-./data/chronicle.db}"
SECOND_PORT="${SECOND_PORT:-3100}"
SECOND_BASE="${SECOND_BASE:-http://127.0.0.1:${SECOND_PORT}}"
TS="$(date +%s)"

h_json=(-H 'Content-Type: application/json')
h_ed=(-H "X-Editor-Token: ${TOKEN}")

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
jfield() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); process.stdout.write(String(eval(process.argv[1])))' "$1"; }
post() { curl -s -X POST "${h_json[@]}" "${h_ed[@]}" "$@"; }
get_ed() { curl -s "${h_ed[@]}" "$@"; }
get_pub() { curl -s "$@"; }
latest_no() { get_pub "$BASE/api/public/versions" | jfield 'd.currentVersionNo'; }
utc_in() { node -e 'console.log(new Date(Date.now()+Number(process.argv[1])*1000).toISOString().replace(/\.\d{3}Z$/,"Z"))' -- "$1"; }
# 用法：post_code <url> <json> → 输出 "HTTP状态码 响应体"
post_code() {
  curl -s -w $'\n%{http_code}' -X POST "${h_json[@]}" "${h_ed[@]}" -d "$2" "$1" \
    | node -e 'const s=require("fs").readFileSync(0,"utf8");const i=s.lastIndexOf("\n");
process.stdout.write(s.slice(i+1)+" "+s.slice(0,i));'
}

WORK="$(mktemp -d)"
SECOND_PID=""
MUTATOR_PID=""
cleanup() {
  [ -n "$MUTATOR_PID" ] && kill "$MUTATOR_PID" 2>/dev/null || true
  [ -n "$SECOND_PID" ] && kill "$SECOND_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say "0) 启动共用同一数据库的第二个服务进程（$SECOND_BASE）"
# SECOND_BASE 已在响应（用户自行启动的第二进程）则跳过拉起；否则用同一 DB_PATH 拉起
if ! get_pub "$SECOND_BASE/api/public/chronicle" >/dev/null 2>&1; then
  PORT="$SECOND_PORT" HOST=127.0.0.1 DB_PATH="$DB_PATH" EDITOR_TOKEN="$TOKEN" \
    node src/server.js >"$WORK/second.log" 2>&1 &
  SECOND_PID=$!
fi
for i in $(seq 1 50); do
  get_pub "$SECOND_BASE/api/public/chronicle" >/dev/null 2>&1 && break
  sleep 0.2
done
get_pub "$SECOND_BASE/api/public/chronicle" >/dev/null 2>&1 \
  && echo "OK：第二进程已就緒（与主服务共用 $DB_PATH）" || { echo "FAIL：第二进程未启动"; exit 1; }

say "1) 建草稿：150 个事件（每事件一条主张）+ 2 个演示事件与一条「先于」关系"
# 批量部分走「采访整理包导入」（预览 → 确认，一个事务落库）
node -e '
const events=[];
for (let i=1;i<=150;i++) events.push({key:"e"+i,title:"背景事件 "+i+" '"$TS"'",
  claims:[{precision:"year",year:1958,source:"批量出处 '"$TS"'"}]});
console.log(JSON.stringify({batchId:"concurrency-'"$TS"'",events}));' > "$WORK/bundle.json"
PREVIEW=$(post "$BASE/api/editor/import-preview" --data-binary @"$WORK/bundle.json")
node -e 'const p=JSON.parse(process.argv[1]);const b=require("fs").readFileSync(process.argv[2],"utf8");
process.stdout.write(JSON.stringify({bundle:JSON.parse(b),fingerprint:p.fingerprint,draftRevisionNo:p.draftRevisionNo}))' \
  "$PREVIEW" "$WORK/bundle.json" > "$WORK/confirm.json"
post "$BASE/api/editor/import" --data-binary @"$WORK/confirm.json" > "$WORK/imported.json"
# 演示事件（含关系，供求解约束）
E1=$(post "$BASE/api/editor/events" -d '{"title":"并发演示动员会 '"$TS"'"}' | jfield 'd.event.id')
E2=$(post "$BASE/api/editor/events" -d '{"title":"并发演示通水会 '"$TS"'"}' | jfield 'd.event.id')
C1=$(post "$BASE/api/editor/events/$E1/claims" \
  -d '{"precision":"day","year":1958,"month":9,"day":12,"source":"李宝山口述 '"$TS"'"}' | jfield 'd.claim.id')
C2=$(post "$BASE/api/editor/events/$E2/claims" \
  -d '{"precision":"month","year":1959,"month":5,"source":"王秀兰口述 '"$TS"'"}' | jfield 'd.claim.id')
post "$BASE/api/editor/relations" -d '{"earlierId":'"$E1"',"laterId":'"$E2"',"source":"二人口述一致 '"$TS"'"}' >/dev/null
# selection = 导入的 150 条 + 演示 2 条
SEL=$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
const sel=d.idMap.events.map(e=>({eventId:e.eventId,claimId:e.claimIds[0]}));
sel.push({eventId:'"$E1"',claimId:'"$C1"'},{eventId:'"$E2"',claimId:'"$C2"'});
process.stdout.write(JSON.stringify(sel))' "$WORK/imported.json")
echo "草稿就绪：152 个事件，selection 已组装"

say "2) 两个进程同时即时发布（同一 baseVersionNo）→ 恰一个 201，另一个 409 VERSION_CONFLICT"
V0="$(latest_no)"
post_code "$BASE/api/editor/publish" \
  '{"selection":'"$SEL"',"baseVersionNo":'"$V0"',"editor":"进程甲","note":"并发首发"}' > "$WORK/pubA" &
PA=$!
post_code "$SECOND_BASE/api/editor/publish" \
  '{"selection":'"$SEL"',"baseVersionNo":'"$V0"',"editor":"进程乙","note":"并发首发"}' > "$WORK/pubB" &
PB=$!
wait "$PA" "$PB"
CODE_A=$(cut -d' ' -f1 "$WORK/pubA"); CODE_B=$(cut -d' ' -f1 "$WORK/pubB")
echo "主进程发布 → $CODE_A；第二进程发布 → $CODE_B"
{ [ "$CODE_A" = 201 ] && [ "$CODE_B" = 409 ]; } || { [ "$CODE_A" = 409 ] && [ "$CODE_B" = 201 ]; } \
  && echo "OK：恰一个 201，另一个 409" || { echo "FAIL：期望 {201,409}，实际 $CODE_A/$CODE_B"; exit 1; }
BODY_409=$([ "$CODE_A" = 409 ] && cat "$WORK/pubA" || cat "$WORK/pubB")
echo "$BODY_409" | grep -q '"code":"VERSION_CONFLICT"' \
  && echo "OK：后到者为 VERSION_CONFLICT（既有语义不变）" || { echo "FAIL：409 不是 VERSION_CONFLICT：$BODY_409"; exit 1; }

say "3) 第二进程持续改草稿，两进程交替发布：201（一致冻结）或 409 DRAFT_CONFLICT（不落库）"
touch "$WORK/mutating"
(
  i=0
  while [ -f "$WORK/mutating" ]; do
    i=$((i+1))
    curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" \
      -d '{"title":"另一进程改动 '"$TS"'-'"$i"'","description":""}' \
      "$SECOND_BASE/api/editor/events/$E1" >/dev/null
  done
) &
MUTATOR_PID=$!

PUBLISHED=0; CONFLICTS=0
for i in $(seq 1 60); do
  V="$(latest_no)"
  # 交替打向两个进程，验证两个进程都安全
  if [ $((i % 2)) -eq 0 ]; then URL="$BASE/api/editor/publish"; else URL="$SECOND_BASE/api/editor/publish"; fi
  OUT=$(post_code "$URL" '{"selection":'"$SEL"',"baseVersionNo":'"$V"',"editor":"并发演示","note":"第 '"$i"' 次尝试"}')
  CODE=$(echo "$OUT" | cut -d' ' -f1)
  BODY=$(echo "$OUT" | cut -d' ' -f2-)
  if [ "$CODE" = 201 ]; then
    PUBLISHED=$((PUBLISHED+1))
  elif [ "$CODE" = 409 ]; then
    echo "$BODY" | grep -q '"code":"DRAFT_CONFLICT"' \
      || { echo "FAIL：发布 409 应为 DRAFT_CONFLICT，实际：$BODY"; exit 1; }
    CONFLICTS=$((CONFLICTS+1))
  else
    echo "FAIL：发布出现意外状态 $CODE：$BODY"; exit 1
  fi
done
rm -f "$WORK/mutating"; wait "$MUTATOR_PID" 2>/dev/null || true; MUTATOR_PID=""
echo "发布尝试 60 次：201 成功 $PUBLISHED 次，409 DRAFT_CONFLICT $CONFLICTS 次"
[ "$CONFLICTS" -ge 1 ] \
  && echo "OK：另一进程在读取与写入之间改草稿时，发布返回 409 DRAFT_CONFLICT（整次不生成版本）" \
  || { echo "FAIL：未观察到 DRAFT_CONFLICT（并发窗口应被捕获）"; exit 1; }

say "4) 停止改动后发布立即成功；版本号连续无空洞（冲突不留半版）"
V="$(latest_no)"
CODE=$(post_code "$BASE/api/editor/publish" \
  '{"selection":'"$SEL"',"baseVersionNo":'"$V"',"editor":"并发演示","note":"改动停止后的发布"}' | cut -d' ' -f1)
[ "$CODE" = 201 ] && echo "OK：冲突不是永久状态，重试即成功" || { echo "FAIL：期望 201，实际 $CODE"; exit 1; }
get_ed "$BASE/api/editor/versions" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const nos=d.versions.map(v=>v.versionNo).sort((a,b)=>a-b);
for(let i=0;i<nos.length;i++) if(nos[i]!==i+1){console.error("FAIL：版本号有空洞",nos);process.exit(1);}
console.log(`OK：${nos.length} 个版本编号连续（1..${nos.length}），冲突回滚不留半版`);'

say "5) 并发下建立预约：201（冻结一致内容）或 409 DRAFT_CONFLICT（不写预约行）"
touch "$WORK/mutating"
(
  i=0
  while [ -f "$WORK/mutating" ]; do
    i=$((i+1))
    curl -s -X PUT "${h_json[@]}" "${h_ed[@]}" \
      -d '{"title":"预约演示改动 '"$TS"'-'"$i"'","description":""}' \
      "$SECOND_BASE/api/editor/events/$E1" >/dev/null
  done
) &
MUTATOR_PID=$!

S_BEFORE=$(get_ed "$BASE/api/editor/schedules" | jfield 'd.schedules.length')
S_OK=0; S_CONFLICT=0
for i in $(seq 1 40); do
  V="$(latest_no)"
  # 预约打向主进程，与第二进程的改动跨进程竞争
  OUT=$(post_code "$BASE/api/editor/schedules" \
    '{"selection":'"$SEL"',"scheduledAt":"'"$(utc_in 7200)"'","baseVersionNo":'"$V"',"editor":"并发演示"}')
  CODE=$(echo "$OUT" | cut -d' ' -f1)
  BODY=$(echo "$OUT" | cut -d' ' -f2-)
  if [ "$CODE" = 201 ]; then
    S_OK=$((S_OK+1))
  elif [ "$CODE" = 409 ]; then
    echo "$BODY" | grep -q '"code":"DRAFT_CONFLICT"' \
      || { echo "FAIL：预约 409 应为 DRAFT_CONFLICT，实际：$BODY"; exit 1; }
    S_CONFLICT=$((S_CONFLICT+1))
  else
    echo "FAIL：预约出现意外状态 $CODE：$BODY"; exit 1
  fi
done
rm -f "$WORK/mutating"; wait "$MUTATOR_PID" 2>/dev/null || true; MUTATOR_PID=""
S_AFTER=$(get_ed "$BASE/api/editor/schedules" | jfield 'd.schedules.length')
echo "预约尝试 40 次：201 建立 $S_OK 条，409 DRAFT_CONFLICT $S_CONFLICT 条"
[ "$S_CONFLICT" -ge 1 ] \
  && echo "OK：读取与写入之间草稿被改时，预约返回 409 DRAFT_CONFLICT" \
  || { echo "FAIL：未观察到预约的 DRAFT_CONFLICT"; exit 1; }
[ "$((S_AFTER - S_BEFORE))" = "$S_OK" ] \
  && echo "OK：预约数只增不减且等于成功次数（冲突不写预约行，冻结修订号与内容同属一份草稿状态）" \
  || { echo "FAIL：预约行数 $S_BEFORE → $S_AFTER 与成功次数 $S_OK 不符"; exit 1; }

say "6) 短预约到期自动发布（到期语义不变）；清理演示预约"
V="$(latest_no)"
S_DUE=$(post "$BASE/api/editor/schedules" \
  -d '{"selection":'"$SEL"',"scheduledAt":"'"$(utc_in 3)"'","baseVersionNo":'"$V"',"editor":"并发演示","note":"到期演示"}' \
  | jfield 'd.schedule.scheduleNo')
sleep 5
get_ed "$BASE/api/editor/schedules/$S_DUE" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
const s=d.schedule;
console.log(`预约 #${s.scheduleNo} 状态=${s.status} resultVersionNo=${s.resultVersionNo}`);
if(s.status!=="published") process.exit(1);'
# 清理：取消第 5 步建立的远期预约
get_ed "$BASE/api/editor/schedules" | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));
for(const s of d.schedules.filter(x=>x.status==="pending")) console.log(s.scheduleNo);' \
  | while read -r NO; do curl -s -X DELETE "${h_ed[@]}" "$BASE/api/editor/schedules/$NO" >/dev/null; done
echo "OK：到期预约已自动发布，远期演示预约已取消"

say "全部断言通过 ✅"
echo "要点：两个服务进程共用同一数据库时，即时发布与建立预约全程使用同一份草稿状态；"
echo "另一进程在读取与写入之间改动草稿 → 409 DRAFT_CONFLICT，整次不生成版本或预约，重试即可。"
