import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'event.db'))

// 并发写者排队等待而非立即报 SQLITE_BUSY（多进程/多连接同时审核报名时兜底）
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
CREATE TABLE IF NOT EXISTS sports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,        -- 球类/田径/水上/棋牌
  format TEXT NOT NULL,          -- roundrobin / group_knockout / knockout / track
  venue TEXT,
  quota INTEGER DEFAULT 8,       -- 参赛名额（队伍数 / 运动员数）
  finished INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT
);
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit_id INTEGER NOT NULL,
  sport_id INTEGER NOT NULL,
  status TEXT DEFAULT 'approved'   -- pending/approved/rejected/withdrawn/revoked
);
CREATE TABLE IF NOT EXISTS athletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit_id INTEGER NOT NULL,
  sport_id INTEGER NOT NULL,
  status TEXT DEFAULT 'approved'   -- pending/approved/rejected/withdrawn/revoked
);
CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sport TEXT,                    -- 专长项目（NULL = 综合执法）
  level TEXT DEFAULT '主裁',      -- 主裁 / 助理裁判 / 记录台
  status TEXT DEFAULT '就绪'
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL,
  stage TEXT,            -- 小组/循环/半决赛/决赛/季军
  group_name TEXT,
  team_a INTEGER,        -- 队伍id，可为 0 占位
  team_b INTEGER,
  venue_id INTEGER,
  order_no INTEGER,
  time_label TEXT,
  score_a INTEGER,
  score_b INTEGER,
  tb_a INTEGER,          -- 加时/点球决胜比分（淘汰赛常规时间平分时必填）
  tb_b INTEGER,
  winner INTEGER,        -- 胜方队伍id（唯一权威数据源；小组/循环平局为 NULL）
  status TEXT DEFAULT 'scheduled',   -- scheduled / finished / void
  note TEXT               -- 弃权(退报)/弃权(撤销资格)/成绩取消(退报)/成绩取消(撤销资格)
);
CREATE TABLE IF NOT EXISTS entries (
  -- 田径成绩（单项）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL,
  athlete_id INTEGER NOT NULL,
  mark REAL,
  rank INTEGER,
  unit_id INTEGER
);
CREATE TABLE IF NOT EXISTS standings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sport_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  play INTEGER DEFAULT 0,
  win INTEGER DEFAULT 0,
  draw INTEGER DEFAULT 0,
  lose INTEGER DEFAULT 0,
  gf INTEGER DEFAULT 0,
  ga INTEGER DEFAULT 0,
  points INTEGER DEFAULT 0,
  rank INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS medals (
  unit_id INTEGER PRIMARY KEY,
  gold INTEGER DEFAULT 0,
  silver INTEGER DEFAULT 0,
  bronze INTEGER DEFAULT 0
);
-- 参赛报名与资格审核（工作流 + 审计）
CREATE TABLE IF NOT EXISTS registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,            -- team / athlete
  unit_id INTEGER NOT NULL,
  sport_id INTEGER NOT NULL,
  team_id INTEGER,
  athlete_id INTEGER,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected/withdrawn/revoked
  quota_no INTEGER,              -- 审核通过时占用的名额序号
  submitted_at TEXT DEFAULT (datetime('now','localtime')),
  reviewed_at TEXT,
  reviewer TEXT,
  review_note TEXT
);
-- 裁判执法安排（场次 × 裁判；仅 assigned 状态参与冲突检测）
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  referee_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'chief',   -- chief(主裁) / assistant(助理裁判) / recorder(记录台)
  status TEXT NOT NULL DEFAULT 'assigned', -- assigned(在派) / released(已解除)
  created_at TEXT DEFAULT (datetime('now','localtime')),
  released_at TEXT
);
-- 同一场次同一名裁判只允许存在一条"在派"安排（解除后可重新排班）
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_active
  ON assignments(match_id, referee_id) WHERE status='assigned';
-- 排班/调班/赛程变更全量留痕
CREATE TABLE IF NOT EXISTS assignment_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,        -- assign/force_assign/auto_assign/release/reassign/swap/match_change/reschedule_rollback/schedule_added/schedule_rebuild/match_finish/void_release
  match_id INTEGER,
  referee_id INTEGER,
  detail TEXT,                 -- 人类可读快照（场次/裁判/变更前后）
  reason TEXT,
  operator TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_logs_match ON assignment_logs(match_id);

-- 赛事申诉复核：参赛单位提交异议，组委会受理/复核/回写改判
CREATE TABLE IF NOT EXISTS appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,       -- 申诉编号 SS-0001
  target_type TEXT NOT NULL,       -- match(球类比分) / track(田径成绩) / eligibility(参赛资格)
  target_id INTEGER,               -- matches.id / entries.id / registrations.id
  unit_id INTEGER NOT NULL,        -- 申诉单位
  sport_id INTEGER,
  reason TEXT NOT NULL,            -- 申诉理由
  contact TEXT,                    -- 联系人（选填）
  evidence TEXT,                   -- 佐证材料说明（选填）
  status TEXT NOT NULL DEFAULT 'pending',  -- pending(待受理)/reviewing(复核中)/upheld(改判)/rejected(驳回)/withdrawn(撤案)
  submitted_at TEXT DEFAULT (datetime('now','localtime')),
  accepted_at TEXT,
  reviewed_at TEXT,
  reviewer TEXT,
  review_note TEXT,                -- 复核意见
  resolution TEXT,                 -- score_corrected(比分回写) / track_corrected(成绩回写) / revoked(资格撤销)
  impact TEXT                      -- 改判影响汇总 JSON（改判场次/重赛递补/积分奖牌变动）
);
CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status);
-- 申诉全量审计：提交/受理/驳回/撤案/改判（含变更前后快照与影响）
CREATE TABLE IF NOT EXISTS appeal_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  appeal_id INTEGER NOT NULL,
  action TEXT NOT NULL,            -- submit/accept/reject/withdraw/uphold
  detail TEXT,                     -- 人类可读详情
  snapshot TEXT,                   -- 变更前后快照 JSON
  operator TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_appeal_logs ON appeal_logs(appeal_id);

-- 场地工作人员（证件发放对象之一：按岗位与服务场地获得动态权限）
CREATE TABLE IF NOT EXISTS venue_staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '志愿者',   -- 场地主管/医疗/安保/器材/媒体/志愿者
  venue_id INTEGER NOT NULL,
  phone TEXT,
  status TEXT DEFAULT '在岗'             -- 在岗/离岗
);
-- 赛事证件：运动员/队伍/裁判/场地工作人员人手一证；权限区按资格与赛程动态计算并留快照
CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,        -- T-0001 队伍 / A-0001 运动员 / R-0001 裁判 / S-0001 工作人员
  subject_type TEXT NOT NULL,       -- team / athlete / referee / staff
  subject_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  unit_id INTEGER,
  sport_id INTEGER,
  venue_id INTEGER,
  zones TEXT,                       -- 当前授权区域快照 JSON：competition/warmup/staff/media
  status TEXT NOT NULL DEFAULT 'active',   -- active(有效) / blocked(停用/暂扣)
  block_reason TEXT,
  block_manual INTEGER DEFAULT 0,   -- 1=组委会人工暂扣（资格恢复不会自动解停，需人工解除）
  issued_at TEXT DEFAULT (datetime('now','localtime')),
  last_checkin_at TEXT,
  checkin_count INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_badge_subject ON badges(subject_type, subject_id);
-- 入场核验流水：每次扫码一条（放行/拒绝/强制放行/重复核验），回写各业务域的唯一数据源
CREATE TABLE IF NOT EXISTS access_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  badge_id INTEGER,
  badge_code TEXT,
  subject_type TEXT,                -- team/athlete/referee/staff（无法识别证件时为空）
  subject_id INTEGER,
  subject_name TEXT,
  venue_id INTEGER,
  match_id INTEGER,
  sport_id INTEGER,
  gate TEXT,                        -- 核验口（运动员通道/裁判通道/工作人员通道…）
  result TEXT NOT NULL,             -- pass(放行) / deny(拒绝) / forced_pass(强制放行)
  is_duplicate INTEGER DEFAULT 0,   -- 同日同场重复扫码：放行但不重复回写计数
  role_snapshot TEXT,               -- 核验时角色（队伍/田径运动员/主裁/安保…）
  zones TEXT,                       -- 本次授权/申请区域 JSON
  reason TEXT,                      -- 拒绝/强制原因（人类可读）
  reason_code TEXT,                 -- BADGE_NOT_FOUND/BADGE_BLOCKED/INELIGIBLE/NO_FIXTURE/WRONG_VENUE/NOT_ASSIGNED/MATCH_NOT_PLAYABLE
  operator TEXT,
  checkin_date TEXT,                -- date('now','localtime')，用于同日幂等
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_checkins_match ON access_checkins(match_id);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON access_checkins(checkin_date);
CREATE INDEX IF NOT EXISTS idx_checkins_created ON access_checkins(created_at);
-- 证件与入场异常审计：发放/同步/暂扣/解除/拒绝入场/强制放行 全量留痕
CREATE TABLE IF NOT EXISTS access_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,             -- issue/sync/block/unblock/deny/force_pass
  badge_id INTEGER,
  badge_code TEXT,
  match_id INTEGER,
  venue_id INTEGER,
  detail TEXT,
  reason TEXT,
  severity TEXT DEFAULT 'info',     -- info / warn / danger
  operator TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON access_logs(created_at);

-- 赛事安全事件：医疗/安保/裁判/组委会协同上报、分级、处置、结案
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,        -- 事件编号 SI-0001
  category TEXT NOT NULL,           -- injury(伤病急救)/security(治安事件)/dispute(冲突纠纷)/facility(场地器材)/weather(天气突发)/other(其他)
  reporter_role TEXT NOT NULL,      -- medical(医疗)/security(安保)/referee(裁判)/organizer(组委会)
  reporter_name TEXT,
  venue_id INTEGER,
  match_id INTEGER,
  description TEXT NOT NULL,
  severity TEXT,                    -- major(重大)/general(较大)/minor(一般)，分级前为 NULL
  lead TEXT,                        -- 牵头处置方 medical/security/referee/organizer
  status TEXT NOT NULL DEFAULT 'pending',  -- pending(待分级)/handling(处置中)/resolved(待结案)/closed(已结案)
  dispatch_note TEXT,               -- 分级派单说明
  resolution_note TEXT,             -- 处置完成说明
  close_summary TEXT,               -- 结案总结
  reviewer TEXT,                    -- 结案/分级经办
  impact TEXT,                      -- 联动处置快照 JSON（暂扣证件 / 暂停·恢复·改期场次）
  reported_at TEXT DEFAULT (datetime('now','localtime')),
  triaged_at TEXT,
  resolved_at TEXT,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);
CREATE INDEX IF NOT EXISTS idx_incidents_match ON incidents(match_id);
-- 安全事件全量审计：上报/分级/进展/证件暂扣解除/场次暂停恢复改期/处置完成/重开/结案
CREATE TABLE IF NOT EXISTS incident_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  action TEXT NOT NULL,             -- submit/triage/progress/badge_block/badge_release/match_pause/match_resume/match_reschedule/resolve/reopen/close
  role TEXT,                        -- 当条记录的协同方角色
  detail TEXT,                      -- 人类可读详情
  badge_id INTEGER,
  match_id INTEGER,
  operator TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_incident_logs ON incident_logs(incident_id);
-- 事件与暂扣证件的关联（一张证件可被不同事件分别记录；解除时回写状态）
CREATE TABLE IF NOT EXISTS incident_badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  badge_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- active(暂扣中) / released(已解除)
  reason TEXT,
  released_reason TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  released_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incident_badges ON incident_badges(incident_id, badge_id);
`)

// —— 旧库迁移：补充字段（列已存在则忽略） ——
;[['tb_a', 'INTEGER'], ['tb_b', 'INTEGER'], ['winner', 'INTEGER']].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE matches ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
;[['quota', 'INTEGER DEFAULT 8']].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE sports ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
;[['status', "TEXT DEFAULT 'approved'"]].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE teams ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
  try { db.prepare(`ALTER TABLE athletes ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
try { db.prepare(`ALTER TABLE matches ADD COLUMN note TEXT`).run() } catch (e) { /* 列已存在 */ }
;[['level', "TEXT DEFAULT '主裁'"], ['sport', 'TEXT'], ['status', "TEXT DEFAULT '就绪'"]].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE referees ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
// 回填历史已完赛场次的胜方；小组/循环平局 winner 保持 NULL
db.prepare(`UPDATE matches SET winner = CASE WHEN score_a > score_b THEN team_a WHEN score_b > score_a THEN team_b ELSE NULL END WHERE status='finished' AND winner IS NULL`).run()

// —— 赛事证件与入场核验：回写字段（列已存在则忽略） ——
// 报名域：最近一次入场核验时间与结果（已核验/拒绝/强制放行）
;[['last_checkin_at', 'TEXT'], ['last_checkin_result', 'TEXT']].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE registrations ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
// 排班域：裁判该场签到核验时间
;[['checkin_at', 'TEXT']].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE assignments ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
// 比赛域：双方到场、执法到岗与异常拦截计数
;[
  ['checkin_a_at', 'TEXT'], ['checkin_b_at', 'TEXT'],
  ['checkin_crew', 'INTEGER DEFAULT 0'], ['checkin_crew_total', 'INTEGER DEFAULT 0'],
  ['admission_denied', 'INTEGER DEFAULT 0']
].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE matches ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})
// 安全事件联动：场次暂停（禁止入场/录比分，恢复或改期后放行），改期记录原档期与事件编号
;[
  ['is_paused', 'INTEGER DEFAULT 0'], ['pause_incident_id', 'INTEGER'],
  ['pause_reason', 'TEXT'], ['paused_at', 'TEXT'],
  ['resume_incident_id', 'INTEGER'], ['resumed_at', 'TEXT'],
  ['reschedule_incident_code', 'TEXT'], ['orig_time_label', 'TEXT'], ['orig_venue_id', 'INTEGER']
].forEach(([col, def]) => {
  try { db.prepare(`ALTER TABLE matches ADD COLUMN ${col} ${def}`).run() } catch (e) { /* 列已存在 */ }
})

export function run(sql, ...p) { return db.prepare(sql).run(...p) }
export function all(sql, ...p) { return db.prepare(sql).all(...p) }
export function get(sql, ...p) { return db.prepare(sql).get(...p) }

// 事务助手：BEGIN IMMEDIATE 在事务开启时即取写锁，把"名额检查 → 占位 → 级联写入"
// 这类读-改-写序列在并发下串行化，杜绝两个审核请求同时通过名额检查。
// 支持嵌套调用：内层直接并入外层事务，由最外层统一提交；任一环节抛错整体回滚。
let txDepth = 0
export function withTransaction(fn, onError = null) {
  if (txDepth > 0) return fn()
  db.exec('BEGIN IMMEDIATE')
  txDepth++
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 连接已回滚 */ }
    try { onError?.(e) } catch { /* 回滚后的审计失败不能覆盖原始错误 */ }
    throw e
  } finally {
    txDepth--
  }
}
