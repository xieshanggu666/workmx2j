import express from 'express'
import { db, run, all, get, withTransaction } from './db.js'

const app = express()
app.use(express.json())
const PORT = 4170

/* ================= 裁判排班：常量与工具 ================= */
const ROLE_NAME = { chief: '主裁', assistant: '助理裁判', recorder: '记录台' }
const ROLES = Object.keys(ROLE_NAME)
// 角色资质：裁判等级只能向下兼容（主裁可兼助理/记录台，反之不可）
const ROLE_RANK = { chief: 3, assistant: 2, recorder: 1 }
const LEVEL_RANK = { '主裁': 3, '助理裁判': 2, '记录台': 1 }
// 整场执法名单配置（田径无裁判组）：各球类项目 1 主裁 + 若干助理 + 1 记录台
function crewSpec(sport) {
  if (!sport || sport.format === 'track') return { chief: 0, assistant: 0, recorder: 0 }
  return { chief: 1, assistant: sport.format === 'group_knockout' ? 2 : 1, recorder: 1 }
}
function crewSpecOfMatch(m) { return crewSpec(get('SELECT * FROM sports WHERE id=?', m.sport_id)) }
// 某待赛场次已在派的执法名单
function crewRowsOf(matchId) {
  return all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, matchId)
}
// 某待赛场次各角色缺口（按项目配置）
function crewMissing(m, crew = null) {
  const need = crewSpecOfMatch(m)
  const rows = crew || crewRowsOf(m.id)
  const have = { chief: 0, assistant: 0, recorder: 0 }
  rows.forEach(a => { if (have[a.role] != null) have[a.role]++ })
  const missing = {}
  ROLES.forEach(role => { const d = need[role] - have[role]; if (d > 0) missing[role] = d })
  return missing
}
function crewShortText(missing) {
  return ROLES.filter(r => missing[r]).map(r => `${ROLE_NAME[r]}×${missing[r]}`).join('、')
}
// 裁判等级是否能担任某执法角色（等级未登记视为可担任，不阻断）
function refLevelOk(referee, role) {
  if (!referee || !referee.level) return true
  return (LEVEL_RANK[referee.level] ?? 3) >= ROLE_RANK[role]
}

function addLog(action, matchId, refereeId, detail, reason, operator) {
  run(`INSERT INTO assignment_logs (action,match_id,referee_id,detail,reason,operator)
       VALUES (?,?,?,?,?,?)`, action, matchId ?? null, refereeId ?? null, detail ?? null, reason ?? null, operator || '组委会')
}
function matchTitle(m) {
  if (!m) return '场次#' + m
  const sp = get('SELECT name FROM sports WHERE id=?', m.sport_id)?.name || ''
  const ta = m.team_a ? get('SELECT name FROM teams WHERE id=?', m.team_a)?.name : '待定'
  const tb = m.team_b ? get('SELECT name FROM teams WHERE id=?', m.team_b)?.name : '待定'
  return `${sp}·${m.stage}${m.group_name ? m.group_name : ''} ${ta || '待定'} VS ${tb || '待定'}（${m.time_label || '时间待定'}）`
}
// 裁判在指定时段的全部"在派"待赛场次（排除 excludeMatchId 自身；assistant/recorder 同样算占用）
function refBusyMatches(refereeId, timeLabel, excludeMatchId) {
  if (!timeLabel) return []
  const rows = all(`SELECT a.id aid, a.role, m.* FROM assignments a JOIN matches m ON m.id=a.match_id
                    WHERE a.referee_id=? AND a.status='assigned' AND m.status='scheduled' AND m.time_label=?`, refereeId, timeLabel)
  return rows.filter(r => r.id !== excludeMatchId)
}
// 某场地在同一时段的其它有效场次（默认同时校验已完赛归档与待赛场次，避免改期占用已发生档期）
function venueClashMatches(venueId, timeLabel, excludeMatchId, statuses = ['scheduled', 'finished']) {
  if (!venueId || !timeLabel) return []
  const placeholders = statuses.map(() => '?').join(',')
  return all(`SELECT * FROM matches WHERE venue_id=? AND time_label=? AND status IN (${placeholders}) AND id<>?`,
    venueId, timeLabel, ...statuses, excludeMatchId ?? 0)
}
// 场地名 → id（种子与动态编排均按名称解析，避免自增 id 漂移）
function vid(name) { return get('SELECT id FROM venues WHERE name=?', name)?.id ?? null }
// 裁判专长与项目是否匹配（未登记专长视为综合执法，可派所有项目）
function refSportOk(referee, sportId) {
  if (!referee || !referee.sport) return true
  const sp = get('SELECT name, category FROM sports WHERE id=?', sportId)
  return referee.sport === sp?.name || referee.sport === sp?.category
}
// 为一场待赛挑选某角色的合适裁判：
// 专长精确匹配优先 → 等级匹配（避免高等级裁判被过度占用）→ 待赛负荷低 → 无时间冲突
function pickRefForRole(m, role, crew = null) {
  if (!m.time_label) return null
  const spo = get('SELECT * FROM sports WHERE id=?', m.sport_id)
  const inCrew = new Set((crew || crewRowsOf(m.id)).map(a => a.referee_id))
  const loadOf = rid => get(`SELECT COUNT(*) c FROM assignments a JOIN matches mm ON mm.id=a.match_id
    WHERE a.referee_id=? AND a.status='assigned' AND mm.status='scheduled'`, rid)?.c ?? 0
  const cands = all(`SELECT * FROM referees WHERE status IN ('就绪','在岗') ORDER BY id`)
    .filter(r => refSportOk(r, m.sport_id))
    .filter(r => refLevelOk(r, role))
    .filter(r => refBusyMatches(r.id, m.time_label, m.id).length === 0)
    .filter(r => !inCrew.has(r.id))
    .map(r => ({
      r,
      // 精确专长 > 同类别 > 综合执法 > 跨专长
      sportPri: r.sport == null ? 2 : (r.sport === spo.name ? 0 : r.sport === spo.category ? 1 : 3),
      levelPri: (LEVEL_RANK[r.level] ?? 3) === ROLE_RANK[role] ? 0 : 1,
      load: loadOf(r.id)
    }))
    .sort((a, b) => a.sportPri - b.sportPri || a.levelPri - b.levelPri || a.load - b.load || a.r.id - b.r.id)
  return cands[0]?.r || null
}

/* ================= 排班 / 调班 / 解除 ================= */
// 分配裁判到场次。返回 assignment；冲突或专长不符时默认拒绝，force=true 强制安排并留痕
function assignReferee(matchId, refereeId, role = 'chief', operator = '组委会', reason = '', force = false) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status !== 'scheduled') throw new Error('仅待赛场次可安排裁判（完赛/取消场次执法记录已归档）')
  if (!m.team_a || !m.team_b) throw new Error('该场次对阵尚未确定，编排后才能安排裁判')
  const ref = get('SELECT * FROM referees WHERE id=?', refereeId)
  if (!ref) throw new Error('裁判不存在')
  if (ref.status && ref.status !== '就绪' && ref.status !== '在岗') throw new Error(`裁判当前状态为「${ref.status}」，暂不可排班`)
  if (!ROLES.includes(role)) throw new Error('执法角色无效')
  const dup = get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, matchId, refereeId)
  if (dup) throw new Error('该裁判已在本场次执法名单中')

  const busy = refBusyMatches(refereeId, m.time_label, matchId)
  const sportOk = refSportOk(ref, m.sport_id)
  const levelOk = refLevelOk(ref, role)
  if (!force && busy.length) {
    const err = new Error(`时间冲突：${ref.name} 在 ${m.time_label} 已被安排执法 ${busy.length} 场`)
    err.code = 'CONFLICT'
    err.conflicts = { referee: busy.map(b => ({ match_id: b.id, title: matchTitle(b) })) }
    throw err
  }
  if (!force && !sportOk) {
    const err = new Error(`专长不符：${ref.name} 的专长为「${ref.sport}」，本场为「${get('SELECT name FROM sports WHERE id=?', m.sport_id).name}」`)
    err.code = 'SKILL_MISMATCH'
    throw err
  }
  if (!force && !levelOk) {
    const err = new Error(`角色资质不符：${ref.name} 等级为「${ref.level}」，不能担任${ROLE_NAME[role]}`)
    err.code = 'ROLE_MISMATCH'
    throw err
  }
  const r = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, matchId, refereeId, role)
  const aid = Number(r.lastInsertRowid)
  const forcedNotes = []
  if (busy.length) forcedNotes.push(`强制覆盖时间冲突 ${busy.length} 场`)
  if (!sportOk) forcedNotes.push('跨专长安排')
  if (!levelOk) forcedNotes.push(`跨等级安排（${ref.level}担任${ROLE_NAME[role]}）`)
  addLog(busy.length || !sportOk || !levelOk ? 'force_assign' : 'assign', matchId, refereeId,
    `${matchTitle(m)} → ${ref.name} 担任${ROLE_NAME[role]}${forcedNotes.length ? '（' + forcedNotes.join('，') + '）' : ''}`, reason, operator)
  return { id: aid, forced: !!(busy.length || !sportOk || !levelOk) }
}

function releaseAssignment(assignmentId, operator = '组委会', reason = '') {
  const a = get('SELECT * FROM assignments WHERE id=?', assignmentId)
  if (!a) throw new Error('执法安排不存在')
  if (a.status !== 'assigned') throw new Error('该安排已解除，无需重复操作')
  const m = get('SELECT * FROM matches WHERE id=?', a.match_id)
  if (m && m.status !== 'scheduled') throw new Error('仅待赛场次可解除执法安排')
  const ref = get('SELECT name FROM referees WHERE id=?', a.referee_id)
  run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime'), checkin_at=NULL WHERE id=?`, assignmentId)
  addLog('release', a.match_id, a.referee_id, `${matchTitle(m)}：${ref?.name || '裁判'} 解除${ROLE_NAME[a.role] || '执法'}安排`, reason, operator)
  refreshMatchCrewCheckin(a.match_id)
  return { ok: true }
}

// 临时调班：target_id 为空=为 aid 改派裁判 new_referee_id；target_id 有值=两场裁判对调
function reassignAssignment(assignmentId, { target_id, new_referee_id, reason, operator } = {}) {
  const a = get('SELECT * FROM assignments WHERE id=?', assignmentId)
  if (!a) throw new Error('执法安排不存在')
  if (a.status !== 'assigned') throw new Error('该安排已解除，不能调班')
  const m = get('SELECT * FROM matches WHERE id=?', a.match_id)
  if (!m || m.status !== 'scheduled') throw new Error('仅待赛场次支持临时调班')
  if (!reason || !String(reason).trim()) throw new Error('调班必须填写原因并留痕')
  const op = operator || '组委会'

  if (target_id) {
    const b = get('SELECT * FROM assignments WHERE id=?', Number(target_id))
    if (!b || b.status !== 'assigned') throw new Error('对调目标安排不存在或已解除')
    if (b.id === a.id) throw new Error('不能与自身对调')
    if (b.role !== a.role) throw new Error('对调仅支持相同执法角色（主裁与主裁、助理与助理、记录台与记录台）')
    const mb = get('SELECT * FROM matches WHERE id=?', b.match_id)
    if (!mb || mb.status !== 'scheduled') throw new Error('对调场次不是待赛状态')
    // 专长校验：两名裁判对调后均需能执法目标场次
    const refA0 = get('SELECT * FROM referees WHERE id=?', a.referee_id)
    const refB0 = get('SELECT * FROM referees WHERE id=?', b.referee_id)
    if (!refSportOk(refA0, mb.sport_id)) {
      const err = new Error(`专长不符：${refA0.name} 的专长为「${refA0.sport}」，不能调至 ${get('SELECT name FROM sports WHERE id=?', mb.sport_id).name} 场次`)
      err.code = 'SKILL_MISMATCH'; throw err
    }
    if (!refSportOk(refB0, m.sport_id)) {
      const err = new Error(`专长不符：${refB0.name} 的专长为「${refB0.sport}」，不能调至 ${get('SELECT name FROM sports WHERE id=?', m.sport_id).name} 场次`)
      err.code = 'SKILL_MISMATCH'; throw err
    }
    // 角色资质校验：对调后两名裁判均需能担任目标场次的同角色
    if (!refLevelOk(refA0, b.role)) {
      const err = new Error(`角色资质不符：${refA0.name} 等级为「${refA0.level}」，不能担任${ROLE_NAME[b.role]}`)
      err.code = 'ROLE_MISMATCH'; throw err
    }
    if (!refLevelOk(refB0, a.role)) {
      const err = new Error(`角色资质不符：${refB0.name} 等级为「${refB0.level}」，不能担任${ROLE_NAME[a.role]}`)
      err.code = 'ROLE_MISMATCH'; throw err
    }
    // 调班后冲突预检
    const busyA = refBusyMatches(a.referee_id, mb.time_label, m.id)
    if (busyA.length) {
      const err = new Error(`调班冲突：对调后该裁判在 ${mb.time_label} 仍有其它执法`)
      err.code = 'CONFLICT'
      err.conflicts = { referee: busyA.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
      throw err
    }
    const busyB = refBusyMatches(b.referee_id, m.time_label, mb.id)
    if (busyB.length) {
      const err = new Error(`调班冲突：对调后该裁判在 ${m.time_label} 仍有其它执法`)
      err.code = 'CONFLICT'
      err.conflicts = { referee: busyB.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
      throw err
    }
    const r1 = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, mb.id, a.referee_id, a.role)
    const r2 = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, m.id, b.referee_id, b.role)
    run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime'), checkin_at=NULL WHERE id IN (?,?)`, a.id, b.id)
    refreshMatchCrewCheckin(m.id); refreshMatchCrewCheckin(mb.id)
    const refA = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    const refB = get('SELECT name FROM referees WHERE id=?', b.referee_id)
    const detail = `${matchTitle(m)}：${refA.name} ⇄ ${refB.name}（${matchTitle(mb)}）对调`
    addLog('swap', m.id, b.referee_id, detail, reason, op)
    addLog('swap', mb.id, a.referee_id, detail, reason, op)
    return { ok: true, swapped: true, new_a: Number(r2.lastInsertRowid), new_b: Number(r1.lastInsertRowid) }
  }

  const newId = Number(new_referee_id)
  if (!Number.isInteger(newId)) throw new Error('请选择改派裁判')
  const newRef = get('SELECT * FROM referees WHERE id=?', newId)
  if (!newRef) throw new Error('裁判不存在')
  if (newId === a.referee_id) throw new Error('新裁判与原裁判相同')
  if (!refSportOk(newRef, m.sport_id)) {
    const err = new Error(`专长不符：${newRef.name} 的专长为「${newRef.sport}」，本场为「${get('SELECT name FROM sports WHERE id=?', m.sport_id).name}」`)
    err.code = 'SKILL_MISMATCH'; throw err
  }
  if (!refLevelOk(newRef, a.role)) {
    const err = new Error(`角色资质不符：${newRef.name} 等级为「${newRef.level}」，不能担任${ROLE_NAME[a.role]}`)
    err.code = 'ROLE_MISMATCH'; throw err
  }
  const busy = refBusyMatches(newId, m.time_label, m.id)
  if (busy.length) {
    const err = new Error(`时间冲突：${newRef.name} 在 ${m.time_label} 已被安排执法 ${busy.length} 场`)
    err.code = 'CONFLICT'
    err.conflicts = { referee: busy.map(x => ({ match_id: x.id, title: matchTitle(x) })) }
    throw err
  }
  const dup = get(`SELECT id FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, m.id, newId)
  if (dup) throw new Error('该裁判已在本场次执法名单中')
  const r = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, m.id, newId, a.role)
  run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime'), checkin_at=NULL WHERE id=?`, a.id)
  refreshMatchCrewCheckin(m.id)
  const oldRef = get('SELECT name FROM referees WHERE id=?', a.referee_id)
  addLog('reassign', m.id, newId, `${matchTitle(m)}：${ROLE_NAME[a.role]}由 ${oldRef.name} 改为 ${newRef.name}`, reason, op)
  return { ok: true, swapped: false, new_a: Number(r.lastInsertRowid) }
}

// 整场协同智能排班核心：按项目执法配置（主裁/助理/记录台）逐场补齐缺口
// 统一处理专长匹配、等级资质、同时段冲突与待赛负荷均衡；matchIds 限定处理范围（=全部待赛缺口场次）
function autoFillCrews(operator, matchIds = null, reasonText = '智能排班') {
  let need = all(`SELECT m.* FROM matches m WHERE m.status='scheduled'
                  AND m.team_a IS NOT NULL AND m.team_b IS NOT NULL`)
  if (matchIds) {
    const set = new Set(matchIds)
    need = need.filter(m => set.has(m.id))
  }
  // 先时段后场次，保证同一时段内全局负荷均衡
  need.sort((a, b) => (a.time_label || '').localeCompare(b.time_label || '') || a.id - b.id)
  const filled = [], skipped = [], crewCache = new Map()
  for (const m of need) {
    if (crewCache.has(m.id)) continue
    let crew = crewRowsOf(m.id)
    if (!m.time_label) {
      const missing = crewMissing(m, crew)
      if (Object.keys(missing).length) skipped.push({ match_id: m.id, title: matchTitle(m), reason: '未排定开赛时间', missing: crewShortText(missing) })
      crewCache.set(m.id, crew); continue
    }
    const spo = get('SELECT * FROM sports WHERE id=?', m.sport_id)
    if (spo.format === 'track') { crewCache.set(m.id, crew); continue }
    for (;;) {
      const missing = crewMissing(m, crew)
      const roles = ROLES.filter(role => missing[role])
      if (!roles.length) break
      // 一场内依次补 主裁 → 助理裁判 → 记录台
      const role = roles[0]
      const pick = pickRefForRole(m, role, crew)
      if (!pick) {
        skipped.push({ match_id: m.id, title: matchTitle(m), role, reason: `该时段无可用（专长/资质匹配且无冲突）的${ROLE_NAME[role]}`, missing: crewShortText(missing) })
        break
      }
      run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?, 'assigned')`, m.id, pick.id, role)
      crew.push({ id: -1, match_id: m.id, referee_id: pick.id, role, status: 'assigned' })
      addLog('auto_assign', m.id, pick.id, `${matchTitle(m)} → ${pick.name} 自动排班为${ROLE_NAME[role]}`, reasonText, operator)
      filled.push({ match_id: m.id, title: matchTitle(m), referee: pick.name, role })
    }
    crewCache.set(m.id, crew)
  }
  return { assigned: filled, skipped }
}

// 智能排班：为全部待赛场次补齐整场执法名单（主裁 + 助理裁判 + 记录台）
function autoAssign(operator = '组委会') {
  return autoFillCrews(operator)
}

// 赛程改期/换场：
// - 待赛场：先在事务内落变更，再做场地/裁判冲突检测；默认自动改派受影响裁判并补齐缺口，
//   任一无法解决且未强制确认的冲突都会整体回滚（场次、排班、留痕均不留下中间态）
// - 已完赛：仅更正历史赛程元数据，执法记录作为档案不重排；场地历史冲突可强制更正并留痕
function updateMatchSchedule(matchId, { time_label, venue_id, operator, reason, force, auto_rearrange, allow_paused = false }) {
  const m = get('SELECT * FROM matches WHERE id=?', matchId)
  if (!m) throw new Error('场次不存在')
  if (m.status === 'void') throw new Error('已取消场次不能调整赛程')
  if (!['scheduled', 'finished'].includes(m.status)) throw new Error('当前场次状态不支持调整赛程')
  // 安全事件暂停的场次不得走普通改期（避免绕过处置留痕），需由事件处置"改期"入口联动恢复
  if (m.is_paused && !allow_paused) {
    const code = m.pause_incident_id ? get('SELECT code FROM incidents WHERE id=?', m.pause_incident_id)?.code : null
    throw new Error(`该场次已被安全事件${code ? '（' + code + '）' : ''}暂停，请在安全事件处置中恢复或改期`)
  }

  const newTime = time_label == null ? m.time_label : String(time_label).trim()
  let newVenue = venue_id === undefined ? m.venue_id : (venue_id == null || venue_id === '' ? null : Number(venue_id))
  if (newVenue && !get('SELECT id FROM venues WHERE id=?', newVenue)) throw new Error('场地不存在')
  if (newTime === (m.time_label || '') && Number(newVenue || null) === Number(m.venue_id || null)) {
    return { ok: true, unchanged: true }
  }
  if (m.status === 'finished' && !String(reason || '').trim()) {
    throw new Error('更正已完赛场次的历史赛程必须填写原因')
  }

  const op = operator || '组委会'
  const changeReason = reason || (force ? '强制赛程调整（存在冲突）' : '赛程调整')
  const oldVenue = m.venue_id ? get('SELECT name FROM venues WHERE id=?', m.venue_id)?.name : '未指定'
  const newVenueName = newVenue ? get('SELECT name FROM venues WHERE id=?', newVenue)?.name : '未指定'
  const autoRearrange = auto_rearrange !== false && m.status === 'scheduled'
  let changed = false

  const result = withTransaction(() => {
    run(`UPDATE matches SET time_label=?, venue_id=? WHERE id=?`, newTime, newVenue || null, matchId)
    changed = true
    const changedMatch = get('SELECT * FROM matches WHERE id=?', matchId)

    const venueRows = newVenue ? venueClashMatches(newVenue, newTime, matchId) : []
    if (venueRows.length && !force) {
      const err = new Error('赛程变更将引发场地撞场，已自动回滚；可调整时间/场地，或强制生效')
      err.code = 'CONFLICT'
      err.conflicts = { venue: venueRows.map(c => ({ match_id: c.id, status: c.status, title: matchTitle(c) })), referee: [] }
      throw err
    }

    if (m.status === 'finished') {
      // 已完赛执法记录已归档，不因历史时间/场地更正而改派；只保留更正留痕与场地提示。
      addLog('match_change', matchId, null,
        `${matchTitle(m)}：历史赛程更正，时间 ${m.time_label || '未指定'} → ${newTime || '未指定'}；场地 ${oldVenue} → ${newVenueName}（执法归档保持不变）`,
        changeReason, op)
      return {
        ok: true,
        unchanged: false,
        status: 'finished',
        warnings: venueRows.length ? { venue: venueRows.map(c => ({ match_id: c.id, status: c.status, title: matchTitle(c) })) } : null
      }
    }

    const collectRefConflicts = () => {
      const rows = []
      all(`SELECT a.*, r.name rname FROM assignments a JOIN referees r ON r.id=a.referee_id
           WHERE a.match_id=? AND a.status='assigned'`, matchId).forEach(a => {
        refBusyMatches(a.referee_id, newTime, matchId).forEach(b => {
          rows.push({
            assignment_id: a.id, referee_id: a.referee_id, referee: a.rname, role: a.role,
            role_name: ROLE_NAME[a.role], match_id: b.id, status: b.status, title: matchTitle(b)
          })
        })
      })
      return rows
    }

    let refereeConflicts = collectRefConflicts()
    const rearranged = []
    if (refereeConflicts.length && autoRearrange) {
      // 同一安排可能撞多场，按安排去重后逐席自动改派；任一席无合格候选则整体回滚。
      const byAssignment = new Map()
      refereeConflicts.forEach(c => {
        if (!byAssignment.has(c.assignment_id)) {
          byAssignment.set(c.assignment_id, get('SELECT * FROM assignments WHERE id=?', c.assignment_id))
        }
      })
      for (const oldAssignment of byAssignment.values()) {
        const candidate = pickRefForRole(changedMatch, oldAssignment.role)
        if (!candidate) {
          // 强制模式允许保留无法替换的冲突安排；普通模式必须整单回滚。
          if (!force) {
            const err = new Error(`改期后 ${ROLE_NAME[oldAssignment.role]}存在时间冲突，且暂无合格空闲裁判可自动重排，已回滚`)
            err.code = 'CONFLICT'
            err.conflicts = {
              venue: venueRows.map(c => ({ match_id: c.id, status: c.status, title: matchTitle(c) })),
              referee: collectRefConflicts(),
              auto_rearrange: true
            }
            throw err
          }
          continue
        }
        const oldRef = get('SELECT name FROM referees WHERE id=?', oldAssignment.referee_id)
        const r = run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`,
          matchId, candidate.id, oldAssignment.role)
        run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime') WHERE id=?`, oldAssignment.id)
        addLog('reassign', matchId, candidate.id,
          `${matchTitle(changedMatch)}：改期自动重排，${ROLE_NAME[oldAssignment.role]}由 ${oldRef.name} 改为 ${candidate.name}`,
          `${changeReason}；改期冲突自动改派`, op)
        rearranged.push({
          old_assignment_id: oldAssignment.id, new_assignment_id: Number(r.lastInsertRowid),
          old_referee_id: oldAssignment.referee_id, referee_id: candidate.id,
          referee: candidate.name, role: oldAssignment.role
        })
      }
      refereeConflicts = collectRefConflicts()
    }

    if ((venueRows.length || refereeConflicts.length) && !force) {
      const err = new Error('赛程变更将引发场地撞场或裁判时间冲突，已自动回滚；可先调班、关闭自动重排后重试，或强制生效')
      err.code = 'CONFLICT'
      err.conflicts = {
        venue: venueRows.map(c => ({ match_id: c.id, status: c.status, title: matchTitle(c) })),
        referee: refereeConflicts,
        auto_rearrange: autoRearrange
      }
      throw err
    }

    // 成功改期后，仅对这一场补齐改期前就缺少/重排后产生的执法席位；无候选只返回缺口，不阻断改期。
    const fillResult = autoRearrange ? autoFillCrews(op, [matchId], '改期后自动补齐执法席位') : { assigned: [], skipped: [] }
    const forcedVenue = venueRows.length
    const forcedRefs = refereeConflicts.length
    const detail = `${matchTitle(m)}：时间 ${m.time_label || '未指定'} → ${newTime || '未指定'}；场地 ${oldVenue} → ${newVenueName}` +
      `${rearranged.length ? `；自动重排 ${rearranged.length} 个执法席位` : ''}` +
      `${fillResult.assigned.length ? `；自动补齐 ${fillResult.assigned.length} 个席位` : ''}` +
      ((forcedVenue || forcedRefs) ? `；强制保留场地冲突 ${forcedVenue} 起、裁判冲突 ${forcedRefs} 起` : '')
    addLog('match_change', matchId, null, detail, changeReason, op)

    return {
      ok: true,
      unchanged: false,
      status: 'scheduled',
      rearranged,
      auto_filled: fillResult.assigned,
      crew_skipped: fillResult.skipped,
      unresolved: {
        venue: venueRows.map(c => ({ match_id: c.id, status: c.status, title: matchTitle(c) })),
        referee: refereeConflicts
      }
    }
  }, (e) => {
    // withTransaction 已回滚赛程/排班；再补记一条“尝试失败”的审计日志，便于追溯被拦截的改期请求。
    if (changed && e.code === 'CONFLICT') {
      const vc = e.conflicts?.venue?.length || 0
      const rc = e.conflicts?.referee?.length || 0
      addLog('reschedule_rollback', matchId, null,
        `${matchTitle(m)}：尝试改期至 ${newTime || '未指定'} / ${newVenueName}，因 ${vc ? `场地冲突 ${vc} 起` : ''}${vc && rc ? '、' : ''}${rc ? `裁判冲突 ${rc} 起` : ''}已回滚`,
        changeReason, op)
    }
  })
  return result
}

// 联动：场次完赛 → 执法安排归档
function lockAssignmentsOnFinish(m, operator = '系统') {
  const as = all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, m.id)
  as.forEach(a => {
    const r = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    addLog('match_finish', m.id, a.referee_id, `${matchTitle(m)} 完赛，${r?.name || '裁判'} 的${ROLE_NAME[a.role]}安排归档`, null, operator)
  })
}
// 联动：场次取消（成绩取消）→ 解除全部在派安排
function releaseAssignmentsOfMatch(m, why, operator = '系统', action = 'void_release') {
  const as = all(`SELECT * FROM assignments WHERE match_id=? AND status='assigned'`, m.id)
  as.forEach(a => {
    run(`UPDATE assignments SET status='released', released_at=datetime('now','localtime'), checkin_at=NULL WHERE id=?`, a.id)
    const r = get('SELECT name FROM referees WHERE id=?', a.referee_id)
    addLog(action, m.id, a.referee_id, `${matchTitle(m)}：${r?.name || '裁判'} 的${ROLE_NAME[a.role]}安排随场次调整解除（${why}）`, why, operator)
  })
}

// 执法席位覆盖率：兼容已完赛归档与待赛排班。void 场次不纳入报表分母。
function emptyCoverageBucket() {
  return {
    match_total: 0,
    match_covered: 0,
    slots_need: 0,
    slots_filled: 0,
    slots_pct: 100,
    roles: Object.fromEntries(ROLES.map(role => [role, { need: 0, filled: 0, pct: 100 }]))
  }
}
function crewCoverageStats(matches) {
  const ballSportIds = new Set(all(`SELECT id FROM sports WHERE format<>'track'`).map(s => s.id))
  const eligible = matches
    .filter(m => ['scheduled', 'finished'].includes(m.status) && m.team_a != null && m.team_b != null && ballSportIds.has(m.sport_id))
  const build = rows => {
    const bucket = emptyCoverageBucket()
    const gaps = []
    rows.forEach(m => {
      const need = crewSpecOfMatch(m)
      const crew = crewRowsOf(m.id)
      let totalNeed = 0, totalFilled = 0
      ROLES.forEach(role => {
        const filled = Math.min(need[role], crew.filter(a => a.role === role).length)
        totalNeed += need[role]
        totalFilled += filled
        bucket.roles[role].need += need[role]
        bucket.roles[role].filled += filled
      })
      bucket.match_total += 1
      if (totalFilled >= totalNeed) bucket.match_covered += 1
      else gaps.push({ match_id: m.id, status: m.status, title: matchTitle(m), missing: crewMissing(m, crew), missing_count: totalNeed - totalFilled })
      bucket.slots_need += totalNeed
      bucket.slots_filled += totalFilled
    })
    bucket.slots_pct = bucket.slots_need ? Math.round(bucket.slots_filled / bucket.slots_need * 100) : 100
    ROLES.forEach(role => {
      const r = bucket.roles[role]
      r.pct = r.need ? Math.round(r.filled / r.need * 100) : 100
    })
    return { ...bucket, gaps }
  }
  const overall = build(eligible)
  const scheduled = build(eligible.filter(m => m.status === 'scheduled'))
  const finished = build(eligible.filter(m => m.status === 'finished'))
  return { ...scheduled, scheduled, finished, overall, gaps: scheduled.gaps }
}

/* ================= 种子数据 ================= */
function seed() {
  if (get('SELECT COUNT(*) c FROM sports').c > 0) return

  // 单位
  const units = [['雷霆学院', '#ff7a2f'], ['飞鹰学院', '#2f9bff'], ['雄狮学院', '#2ecc71'], ['星河学院', '#9b59b6']]
  const unitId = {}
  units.forEach((u, i) => { run('INSERT INTO units (name,color) VALUES (?,?)', u[0], u[1]); unitId[u[0]] = i + 1 })

  // 场地
  const venues = ['中心篮球馆', '五人足球场', '羽毛球馆', '田径场', '备用2号场']
  venues.forEach(v => run('INSERT INTO venues (name,type) VALUES (?,?)', v, 'arena'))

  // 裁判（专长 / 等级）——覆盖主裁、助理裁判、记录台三角色与各球类专长
  const refRows = [
    ['王裁判', '篮球', '主裁'], ['李裁判', '篮球', '助理裁判'], ['褚裁判', '篮球', '助理裁判'], ['钱裁判', '篮球', '记录台'],
    ['张裁判', '五人制足球', '主裁'], ['赵裁判', '五人制足球', '助理裁判'], ['周裁判', '五人制足球', '助理裁判'], ['吴裁判', '五人制足球', '记录台'],
    ['陈裁判', '羽毛球', '主裁'], ['郑裁判', '羽毛球', '助理裁判'],
    ['孙裁判', null, '主裁'], ['冯裁判', null, '记录台']   // 综合执法
  ]
  const refId = {}
  refRows.forEach(([n, sp, lv]) => { const r = run('INSERT INTO referees (name,sport,level,status) VALUES (?,?,?,?)', n, sp, lv, '就绪'); refId[n] = Number(r.lastInsertRowid) })

  // 项目
  const sp = (name, cat, fmt, venue) => { const r = run('INSERT INTO sports (name,category,format,venue) VALUES (?,?,?,?)', name, cat, fmt, venue); return Number(r.lastInsertRowid) }
  const spBasket = sp('篮球', '球类', 'roundrobin', '中心篮球馆')
  const spFoot = sp('五人制足球', '球类', 'group_knockout', '五人足球场')
  const spBad = sp('羽毛球', '球类', 'knockout', '羽毛球馆')
  const sp100 = sp('田径 · 100米', '田径', 'track', '田径场')

  // 队伍
  const mk = (name, unit) => { const r = run('INSERT INTO teams (name,unit_id,sport_id) VALUES (?,?,?)', name, unitId[unit], 0); return Number(r.lastInsertRowid) }
  // 篮球 4 队
  const B = ['雷霆学院', '飞鹰学院', '雄狮学院', '星河学院'].map(u => mk(u === '雷霆学院' ? '雷霆队' : u === '飞鹰学院' ? '飞鹰队' : u === '雄狮学院' ? '雄狮队' : '星河队', u))
  B.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spBasket, id))
  // 足球 6 队
  const F = [
    ['雷霆队', '雷霆学院'], ['飞鹰队', '飞鹰学院'], ['雄狮队', '雄狮学院'],
    ['星河队', '星河学院'], ['闪电队', '雷霆学院'], ['烈焰队', '雄狮学院']
  ].map(([n, u]) => mk(n, u))
  F.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spFoot, id))
  // 羽毛球 4 队（同名队伍）
  const G = ['雷霆队', '飞鹰队', '雄狮队', '星河队'].map((n, i) => mk(n, units[i][0]))
  G.forEach(id => run('UPDATE teams SET sport_id=? WHERE id=?', spBad, id))
  // 田径 8 名运动员
  const runners = [['林一', '雷霆学院'], ['周楠', '飞鹰学院'], ['陈晨', '雄狮学院'], ['顾言', '星河学院'], ['徐凯', '雷霆学院'], ['韩雪', '飞鹰学院'], ['陆鸣', '雄狮学院'], ['宋词', '星河学院']]
  const slotsA = ['09:00', '09:40', '10:40']
  const slotsB = ['09:20', '10:00', '11:00']
  runners.forEach(([n, u]) => { run('INSERT INTO athletes (name,unit_id,sport_id) VALUES (?,?,?)', n, unitId[u], sp100) })

  // 循环赛助手
  const pairs = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }

  const venueById = vid('中心篮球馆')

  // —— 篮球：4队 单循环 6 场
  let ono = 0
  pairs(B).forEach(([a, b]) => {
    ono++
    run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBasket, '循环', a, b, venueById, ono, ['09:00', '09:20', '09:40', '10:00', '10:20', '10:40'][(ono - 1) % 6], 'scheduled')
  })

  // —— 足球：分 AB 两组（A: 雷霆/雄狮/闪电  B: 飞鹰/星河/烈焰），组内循环 6 场；两组时段错开避免同场撞档 ——
  const grpA = [F[0], F[2], F[4]]
  const grpB = [F[1], F[3], F[5]]
  const footIds = { A: [], B: [] }
  ono = 0
  pairs(grpA).forEach(([a, b]) => { ono++; const r = run('INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?,?)', spFoot, '小组', 'A组', a, b, vid('五人足球场'), ono, slotsA[(ono - 1) % 3], 'scheduled'); footIds.A.push(Number(r.lastInsertRowid)) })
  pairs(grpB).forEach(([a, b]) => { ono++; const r = run('INSERT INTO matches (sport_id,stage,group_name,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?,?)', spFoot, '小组', 'B组', a, b, vid('五人足球场'), ono, slotsB[(ono - 1) % 3], 'scheduled'); footIds.B.push(Number(r.lastInsertRowid)) })

  // —— 羽毛球：半决赛 2 场（固定对位），决赛/季军由编排按钮产生 ——
  const badSemi1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBad, '半决赛', G[0], G[1], vid('羽毛球馆'), 1, '09:30', 'scheduled')
  const badSemi2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', spBad, '半决赛', G[2], G[3], vid('羽毛球馆'), 2, '10:00', 'scheduled')
  const badIds = [Number(badSemi1.lastInsertRowid), Number(badSemi2.lastInsertRowid)]

  rebuildStandings()

  // —— 预录部分成绩（演示看板有内容）——
  const sc = (sport, a, b, sa, sb) => { const m = get('SELECT id FROM matches WHERE sport_id=? AND team_a=? AND team_b=? AND status=\'scheduled\'', sport, a, b); if (m) finishMatch(m.id, sa, sb) }
  // 篮球全录 → 决出冠军
  sc(spBasket, B[0], B[1], 78, 70); sc(spBasket, B[2], B[3], 65, 71)
  sc(spBasket, B[0], B[2], 82, 60); sc(spBasket, B[1], B[3], 69, 74)
  sc(spBasket, B[0], B[3], 58, 66); sc(spBasket, B[1], B[2], 88, 77)
  // 足球小组录 4 场，留每组末轮 2 场未赛（演示排班/调班）
  sc(spFoot, grpA[0], grpA[1], 3, 1); sc(spFoot, grpA[1], grpA[2], 2, 2)
  sc(spFoot, grpB[0], grpB[1], 1, 3); sc(spFoot, grpB[1], grpB[2], 2, 1)
  // 羽毛球两场半决赛都录 → 可编排决赛
  sc(spBad, G[0], G[1], 21, 16); sc(spBad, G[2], G[3], 18, 21)
  // 田径成绩
  const marks = [10.62, 10.88, 11.05, 11.21, 11.35, 11.42, 11.58, 11.79]
  all('SELECT id,name FROM athletes').forEach((ath, i) => run('INSERT INTO entries (sport_id,athlete_id,mark,rank,unit_id) VALUES (?,?,?,?,?)', sp100, ath.id, marks[i], i + 1, get('SELECT unit_id FROM athletes WHERE id=?', ath.id).unit_id))

  // —— 历史执法安排（已完赛场次：静默回填整场名单，作为工作量统计口径）——
  const seedHist = (mid, rid, role = 'chief') => run(`INSERT INTO assignments (match_id,referee_id,role,status) VALUES (?,?,?,'assigned')`, mid, rid, role)
  // 篮球：主裁王，助理李/褚轮值，记录台钱
  const basketDone = all(`SELECT id FROM matches WHERE sport_id=? AND status='finished' ORDER BY id`, spBasket).map(x => x.id)
  basketDone.forEach((x, i) => {
    seedHist(x, refId['王裁判'])
    seedHist(x, i % 2 ? refId['褚裁判'] : refId['李裁判'], 'assistant')
    seedHist(x, refId['钱裁判'], 'recorder')
  })
  // 足球：主裁张，助理赵/周轮值，记录台吴
  const footDone = all(`SELECT id FROM matches WHERE sport_id=? AND status='finished' ORDER BY id`, spFoot).map(x => x.id)
  footDone.forEach((x, i) => {
    seedHist(x, refId['张裁判'])
    seedHist(x, i % 2 ? refId['周裁判'] : refId['赵裁判'], 'assistant')
    seedHist(x, refId['吴裁判'], 'recorder')
  })
  // 羽毛球半决赛：主裁陈，助理郑，记录台冯（综合执法）
  badIds.forEach(x => { seedHist(x, refId['陈裁判']); seedHist(x, refId['郑裁判'], 'assistant'); seedHist(x, refId['冯裁判'], 'recorder') })

  // —— 为已有队伍/运动员补建「已通过」报名记录（完整审计轨迹）——
  all('SELECT id, name, unit_id, sport_id FROM teams').forEach(t => {
    if (!get('SELECT id FROM registrations WHERE team_id=?', t.id)) {
      run(`INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status,reviewer,reviewed_at)
           VALUES ('team',?,?,?,?,'approved','组委会',datetime('now','localtime'))`, t.unit_id, t.sport_id, t.id, t.name)
    }
  })
  all('SELECT id, name, unit_id, sport_id FROM athletes').forEach(a => {
    if (!get('SELECT id FROM registrations WHERE athlete_id=?', a.id)) {
      run(`INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status,reviewer,reviewed_at)
           VALUES ('athlete',?,?,?,?,'approved','组委会',datetime('now','localtime'))`, a.unit_id, a.sport_id, a.id, a.name)
    }
  })

  // —— 演示：新增待审核报名（队伍/运动员），由组委会审核资格与名额 ——
  const addPendingTeam = (name, unit, sport) => {
    const r = run('INSERT INTO teams (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId[unit], sport, 'pending')
    const tid = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status) VALUES (?,?,?,?,?,?)', 'team', unitId[unit], sport, tid, name, 'pending')
  }
  const addPendingAthlete = (name, unit, sport) => {
    const r = run('INSERT INTO athletes (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId[unit], sport, 'pending')
    const aid = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status) VALUES (?,?,?,?,?,?)', 'athlete', unitId[unit], sport, aid, name, 'pending')
  }
  addPendingTeam('雷霆三队', '雷霆学院', spBasket)
  addPendingTeam('飞鹰二队', '飞鹰学院', spFoot)
  addPendingAthlete('许诺', '星河学院', sp100)

  // —— 淘汰赛按真实赛果动态生成（与赛程编排页同一入口）；生成时自动整场协同排班 ——
  generateKO(spBad)
  // 季军战解除主裁安排（助理/记录台保留），演示"主裁缺口待排班"覆盖率
  const thirdM = get(`SELECT * FROM matches WHERE sport_id=? AND stage='季军'`, spBad)
  if (thirdM) {
    const thirdChief = get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, thirdM.id)
    if (thirdChief) releaseAssignment(thirdChief.id, '组委会', '季军战裁判长待定，主裁暂时留空待排班')
  }

  // —— 待赛小组末轮：主裁初排 + 一次对调演示；助理/记录台留给"一键智能排班"现场补齐 ——
  const mA3 = get(`SELECT id FROM matches WHERE sport_id=? AND group_name='A组' AND status='scheduled'`, spFoot).id
  const mB3 = get(`SELECT id FROM matches WHERE sport_id=? AND group_name='B组' AND status='scheduled'`, spFoot).id
  const aAss = assignReferee(mA3, refId['孙裁判'], 'chief', '组委会', '末轮初排')
  assignReferee(mB3, refId['张裁判'], 'chief', '组委会', '末轮初排')
  reassignAssignment(aAss.id, { target_id: get(`SELECT id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, mB3).id, reason: '孙裁判临时请假，末轮主裁对调', operator: '裁判长' })

  recomputeMedals()

  // —— 演示：赛事申诉复核（覆盖三种对象 + 三种状态，全量留痕）——
  // 1) 待受理：飞鹰学院对篮球首场比分申诉（该场 78:70 雷霆胜，飞鹰称计时有误）
  const appealMatch = get(`SELECT m.id FROM matches m
    JOIN teams ta ON ta.id=m.team_a JOIN teams tb ON tb.id=m.team_b
    WHERE m.sport_id=? AND m.stage='循环' AND m.score_a=78 AND m.score_b=70
      AND ta.name='雷霆队' AND tb.name='飞鹰队'`, spBasket)
  const flyUnit = unitId['飞鹰学院']
  if (appealMatch) {
    submitAppeal({
      target_type: 'match', target_id: appealMatch.id, unit_id: flyUnit,
      reason: '末节最后 2.4 秒进攻被误判超时，请求回看录像复核比分', contact: '飞鹰领队',
      evidence: '看台录像 2 段、技术台记录表照片'
    })
  }
  // 2) 复核中：飞鹰学院对田径 100 米周楠（10.88s 亚军）成绩申诉
  const appealEntry = get(`SELECT e.id FROM entries e JOIN athletes a ON a.id=e.athlete_id WHERE a.name='周楠' AND e.sport_id=?`, sp100)
  if (appealEntry) {
    const r = submitAppeal({
      target_type: 'track', target_id: appealEntry.id, unit_id: flyUnit,
      reason: '起跑反应计时疑似偏差，申请复核计时设备记录', contact: '田径教练'
    })
    acceptAppeal(r.id, '仲裁委员会')
  }
  // 3) 已驳回：星河学院对篮球冠军雷霆队的参赛资格申诉
  const champReg = get(`SELECT id FROM registrations WHERE sport_id=? AND kind='team' AND name='雷霆队' ORDER BY id LIMIT 1`, spBasket)
  if (champReg) {
    const r = submitAppeal({
      target_type: 'eligibility', target_id: champReg.id, unit_id: unitId['星河学院'],
      reason: '质疑雷霆队 7 号球员学籍归属，请复核报名资格'
    })
    acceptAppeal(r.id, '仲裁委员会')
    closeAppeal(r.id, 'reject', '经核查学籍证明与报名材料一致，资格有效，申诉驳回', '仲裁委员会')
  }

  // —— 场地工作人员（证件发放对象；按岗位与服务场地获得动态授权区域）——
  const staffRows = [
    ['刘主管', '场地主管', '中心篮球馆', '13800000001'],
    ['赵医生', '医疗', '五人足球场', '13800000002'],
    ['钱安保', '安保', '田径场', '13800000003'],
    ['孙器材', '器材', '羽毛球馆', '13800000004'],
    ['周记者', '媒体', '羽毛球馆', '13800000005'],
    ['吴志愿', '志愿者', '备用2号场', '13800000006']
  ]
  const staffId = {}
  staffRows.forEach(([n, role, vname, phone]) => {
    const r = run('INSERT INTO venue_staff (name,role,venue_id,phone,status) VALUES (?,?,?,?,?)', n, role, vid(vname), phone, '在岗')
    staffId[n] = Number(r.lastInsertRowid)
  })

  // —— 发放全部赛事证件并按资格/赛程同步授权区域 ——
  syncAllBadges('系统', false)
  const badgeCode = (type, subjectId) => get('SELECT code FROM badges WHERE subject_type=? AND subject_id=?', type, subjectId)?.code

  // —— 演示入场核验：以足球小组末轮 A 组（雷霆 VS 闪电）为主场景 ——
  const gateMatch = get(`SELECT m.* FROM matches m WHERE m.sport_id=? AND m.group_name='A组' AND m.status='scheduled'`, spFoot)
  if (gateMatch) {
    const footVenue = gateMatch.venue_id
    // 主队到场（按赛程放行：资格有效 + 对阵双方 + 场地一致）
    verifyAccess({ code: badgeCode('team', gateMatch.team_a), venueId: footVenue, matchId: gateMatch.id, operator: '东门检票员' })
    // 主裁到岗（末轮对调后该场主裁为张裁判）
    const chief = get(`SELECT referee_id FROM assignments WHERE match_id=? AND role='chief' AND status='assigned'`, gateMatch.id)
    if (chief) verifyAccess({ code: badgeCode('referee', chief.referee_id), venueId: footVenue, matchId: gateMatch.id, operator: '裁判通道' })
    // 场地医疗到岗
    verifyAccess({ code: badgeCode('staff', staffId['赵医生']), venueId: footVenue, matchId: gateMatch.id, operator: '工作人员通道' })
    // 异常：非对阵队伍（雄狮队在 B 组）扫 A 组末轮 → 拒绝入场并计入该场异常
    verifyAccess({ code: badgeCode('team', F[2]), venueId: footVenue, matchId: gateMatch.id, operator: '东门检票员' })
    // 异常后强制放行：客队（闪电队）跟队大巴延误，先在错误的篮球馆口被拦（场地不符），值班主任在同一核验口批准强制放行并留痕
    verifyAccess({ code: badgeCode('team', gateMatch.team_b), venueId: vid('中心篮球馆'), matchId: gateMatch.id, operator: '东门检票员' })
    verifyAccess({ code: badgeCode('team', gateMatch.team_b), venueId: vid('中心篮球馆'), matchId: gateMatch.id, force: true, reason: '球员跟队大巴延误，值班主任核验参赛名单后批准先行入场，赛后补办场地手续', operator: '值主任' })
  }
  // 田径场：运动员核验入场（无对阵赛程，按项目资格 + 场地放行）
  const runner = get(`SELECT id FROM athletes WHERE name='林一'`)
  if (runner) verifyAccess({ code: badgeCode('athlete', runner.id), venueId: vid('田径场'), operator: '检录处' })
  // 异常：媒体记者（仅媒体区）在运动员通道扫比赛区 → 场地不符拒绝
  verifyAccess({ code: badgeCode('staff', staffId['周记者']), venueId: vid('五人足球场'), operator: '运动员通道' })

  // —— 赛事安全事件处置（医疗/安保/裁判/组委会四方协同，覆盖上报/分级/处置/结案全状态 + 三联动）——
  // SI-1：一般·伤病急救（已结案，无联动）——田径场热身区运动员擦伤
  const inc1 = reportIncident({
    category: 'injury', reporter_role: 'medical', reporter_name: '赵医生',
    venue_id: vid('田径场'), description: '田径热身区一名运动员热身时绊倒，右膝擦伤，医疗点已做清创包扎。'
  })
  triageIncident(inc1.id, { severity: 'minor', lead: 'medical', dispatch_note: '一般伤情，医疗点处置观察，安保维护周边秩序', operator: '组委会值班' })
  progressIncident(inc1.id, { role: 'security', note: '已在热身区设置临时围挡，引导其他运动员绕行', operator: '钱安保' })
  progressIncident(inc1.id, { role: 'medical', note: '伤者包扎后行动正常，无不适，可继续观赛，不影响比赛安排', operator: '赵医生' })
  resolveIncident(inc1.id, { note: '伤者处理完毕，现场秩序恢复，无需升级处置', operator: '赵医生' })
  closeIncident(inc1.id, { summary: '一般擦伤，医疗处置及时，无后续影响', operator: '组委会值班' })

  // SI-2：重大·治安事件（处置中，联动暂扣证件 + 一次关联并批量暂停足球 A/B 组末轮 2 场）——观众席冲突，客队随队人员持无效带队证件
  const gateMatchB = get(`SELECT m.* FROM matches m WHERE m.sport_id=? AND m.group_name='B组' AND m.status='scheduled'`, spFoot)
  const gateMatchesLeft = [gateMatchB, gateMatch].filter(Boolean)   // 五人足球场今日末轮小组赛（B 组 + A 组）
  const inc2 = reportIncident({
    category: 'security', reporter_role: 'security', reporter_name: '钱安保',
    venue_id: gateMatchB ? gateMatchB.venue_id : vid('五人足球场'),
    match_ids: gateMatchesLeft.map(m => m.id),
    description: '五人足球场西看台两队球迷发生口角推搡，一名无有效带队证件的随队人员试图冲击隔离栏，已当场控制。'
  })
  triageIncident(inc2.id, { severity: 'major', lead: 'security', dispatch_note: '重大治安事件：安保牵头隔离冲突双方，裁判组暂停待赛场次，医疗待命', operator: '组委会主任' })
  progressIncident(inc2.id, { role: 'referee', note: '裁判组已收到暂停通知，末轮小组赛开赛准备暂停，各队留在热身区等候', operator: '张裁判' })
  progressIncident(inc2.id, { role: 'medical', note: '医疗点两名医护携急救包抵达西看台，暂无人员受伤', operator: '赵医生' })
  // 暂扣一张证件演示联动：取一张有效队伍证件作为"违纪随队人员持证人"（仅演示暂扣链路）
  const demoBlockBadge = gateMatchB ? get(`SELECT * FROM badges WHERE subject_type='team' AND subject_id=?`, gateMatchB.team_b) : null
  if (demoBlockBadge) {
    incidentBlockBadge(inc2.id, { badge_id: demoBlockBadge.id, reason: '持证人卷入看台冲突并冲击隔离栏，调查期间暂扣入场证件', role: 'security', operator: '钱安保' })
  }
  // 一起事件关联多场比赛：批量暂停五人足球场今日全部末轮小组赛（入场核验/裁判签到/成绩录入同步锁定）
  if (gateMatchesLeft.length) incidentPauseMatch(inc2.id, { match_ids: gateMatchesLeft.map(m => m.id), reason: '西看台治安冲突未平息，五人足球场末轮小组赛全部暂停，暂停入场核验', role: 'security', operator: '组委会主任' })

  // SI-3：较大·场地器材（已结案，联动暂停→改期羽毛球季军战）——备用场地地胶起翘
  const thirdBad = get(`SELECT * FROM matches WHERE sport_id=? AND stage='季军' AND status='scheduled'`, spBad)
  if (thirdBad) {
    const inc3 = reportIncident({
      category: 'facility', reporter_role: 'referee', reporter_name: '陈裁判',
      venue_id: thirdBad.venue_id, match_id: thirdBad.id,
      description: '备用2号场比赛区边线附近地胶接缝起翘约 40cm，存在崴脚风险，季军战不宜按原计划在该场地开赛。'
    })
    triageIncident(inc3.id, { severity: 'general', lead: 'organizer', dispatch_note: '较大场地隐患：器材组评估抢修时长，裁判组暂停季军战，协调改期羽毛球主馆', operator: '组委会值班' })
    progressIncident(inc3.id, { role: 'organizer', note: '器材组反馈：重新粘接需 2 小时以上，当日时段无法保证安全；羽毛球主馆 16:00 决赛后 16:30 档期可用，建议改回主馆', operator: '孙器材' })
    incidentPauseMatch(inc3.id, { reason: '备用2号场地胶起翘，季军战暂停待改期', role: 'referee', operator: '陈裁判' })
    // 改期：原 15:30 备用2号场 → 16:30 羽毛球馆（半决赛已完赛、决赛 16:00 后档期空闲；自动重排/补齐执法）
    incidentRescheduleMatch(inc3.id, {
      time_label: '16:30', venue_id: vid('羽毛球馆'), reason: '备用2号场地胶抢修，季军战改回羽毛球主馆（决赛后档期）',
      role: 'organizer', operator: '组委会值班'
    })
    progressIncident(inc3.id, { role: 'security', note: '羽毛球主馆隔离区与看台引导已确认可用', operator: '钱安保' })
    resolveIncident(inc3.id, { note: '季军战改期 16:30 羽毛球馆，执法名单随改期重排确认，备用场地封闭抢修', operator: '组委会值班' })
    closeIncident(inc3.id, { summary: '较大场地隐患处置闭环：暂停→改期回主馆→人员引导到位，无人员受伤', operator: '组委会值班' })
  }

  // SI-4：待分级·医疗（等组委会分级）——篮球馆一名观众报称头晕
  reportIncident({
    category: 'injury', reporter_role: 'medical', reporter_name: '刘主管',
    venue_id: vid('中心篮球馆'),
    description: '中心篮球馆看台区一名观众主诉头晕恶心，疑似中暑，已转移至通风处休息测量血压，等待分级响应。'
  })
}
/* ================= 赛事证件与入场核验 ================= */
// 证件类型 / 授权区域 / 场地工作人员岗位
const SUBJECT_NAME = { team: '队伍', athlete: '田径运动员', referee: '裁判', staff: '场地工作人员' }
const ZONE_NAME = { competition: '比赛区', warmup: '热身区', staff: '工作区', media: '媒体区' }
const BADGE_PREFIX = { team: 'T', athlete: 'A', referee: 'R', staff: 'S' }
// 场地工作人员岗位 → 授权区域（按岗位动态授予，不泛化放行）
const STAFF_ZONES = {
  '场地主管': ['competition', 'staff'],
  '医疗': ['competition', 'staff'],
  '安保': ['competition', 'staff'],
  '器材': ['warmup', 'staff'],
  '志愿者': ['staff'],
  '媒体': ['media']
}
const GATE_BY_TYPE = { team: '运动员通道', athlete: '运动员通道', referee: '裁判通道', staff: '工作人员通道' }

function addAccessLog(action, badgeId, code, detail, reason, operator, severity = 'info', matchId = null, venueId = null) {
  run(`INSERT INTO access_logs (action,badge_id,badge_code,match_id,venue_id,detail,reason,severity,operator)
       VALUES (?,?,?,?,?,?,?,?,?)`, action, badgeId ?? null, code ?? null, matchId ?? null, venueId ?? null,
    detail ?? null, reason ?? null, severity, operator || '系统')
}
function nextBadgeCode(type) {
  const n = get('SELECT COUNT(*) c FROM badges WHERE subject_type=?', type)?.c + 1
  return `${BADGE_PREFIX[type]}-${String(n).padStart(4, '0')}`
}
function baseZonesOf(subjectType) {
  if (subjectType === 'team' || subjectType === 'athlete') return ['competition', 'warmup']
  if (subjectType === 'referee') return ['competition', 'staff']
  return []
}
// 证件主体的实时资格（资格状态 + 服务/执法关系）
function subjectState(type, id) {
  if (type === 'team') {
    const t = get('SELECT * FROM teams WHERE id=?', id)
    return t ? { exists: true, status: t.status, unit_id: t.unit_id, sport_id: t.sport_id, name: t.name } : { exists: false }
  }
  if (type === 'athlete') {
    const a = get('SELECT * FROM athletes WHERE id=?', id)
    return a ? { exists: true, status: a.status, unit_id: a.unit_id, sport_id: a.sport_id, name: a.name } : { exists: false }
  }
  if (type === 'referee') {
    const r = get('SELECT * FROM referees WHERE id=?', id)
    return r ? { exists: true, status: ['就绪', '在岗'].includes(r.status) ? 'approved' : 'blocked', name: r.name, raw_status: r.status } : { exists: false }
  }
  const s = get('SELECT * FROM venue_staff WHERE id=?', id)
  return s ? { exists: true, status: s.status === '在岗' ? 'approved' : 'blocked', name: s.name, venue_id: s.venue_id, role: s.role, raw_status: s.status } : { exists: false }
}
function zonesForBadge(type, state) {
  if (type === 'staff') return STAFF_ZONES[state.role] || ['staff']
  return baseZonesOf(type)
}
// 同步单张证件：按实时资格发放/停用，刷新授权区域快照；人工暂扣证件不自动恢复
function syncBadge(type, id, operator = '系统', logIt = false) {
  const state = subjectState(type, id)
  let badge = get('SELECT * FROM badges WHERE subject_type=? AND subject_id=?', type, id)
  if (!state.exists) {
    if (badge && badge.status !== 'blocked') {
      run(`UPDATE badges SET status='blocked', block_reason='主体已删除', zones='[]' WHERE id=?`, badge.id)
      if (logIt) addAccessLog('sync', badge.id, badge.code, `证件 ${badge.code} 随主体注销停用`, '主体已删除', operator, 'warn')
    }
    return badge || null
  }
  const eligible = state.status === 'approved'
  const zones = eligible ? zonesForBadge(type, state) : []
  if (!badge) {
    const code = nextBadgeCode(type)
    const blockReason = eligible ? null : '资格尚未生效（待审核/未通过/已失效）'
    const r = run(`INSERT INTO badges (code,subject_type,subject_id,name,unit_id,sport_id,venue_id,zones,status,block_reason)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`,
      code, type, id, state.name, state.unit_id ?? null, state.sport_id ?? null, state.venue_id ?? null,
      JSON.stringify(zones), eligible ? 'active' : 'blocked', blockReason)
    badge = get('SELECT * FROM badges WHERE id=?', Number(r.lastInsertRowid))
    if (logIt) addAccessLog('issue', badge.id, code, `发放证件 ${code}（${SUBJECT_NAME[type]}「${state.name}」，授权：${zones.map(z => ZONE_NAME[z]).join('、') || '暂无'}）`, null, operator, 'info')
  } else {
    const wasBlocked = badge.status === 'blocked'
    const newStatus = badge.block_manual ? badge.status : (eligible ? 'active' : 'blocked')
    const reason = eligible ? null : '资格未通过或已失效'
    run(`UPDATE badges SET name=?, unit_id=?, sport_id=?, venue_id=?, zones=?, status=?, block_reason=? WHERE id=?`,
      state.name, state.unit_id ?? null, state.sport_id ?? null, state.venue_id ?? null, JSON.stringify(zones), newStatus, badge.block_manual ? badge.block_reason : reason, badge.id)
    if (logIt && wasBlocked && newStatus === 'active') {
      addAccessLog('sync', badge.id, badge.code, `证件 ${badge.code} 资格恢复，自动恢复有效（授权：${zones.map(z => ZONE_NAME[z]).join('、')}）`, null, operator, 'info')
    }
    badge = get('SELECT * FROM badges WHERE id=?', badge.id)
  }
  return badge
}
// 全量同步证件（幂等）：为全部应持证对象建证/刷新，资格失效自动停用；健康库上无操作
function syncAllBadges(operator = '系统', logIt = false) {
  const groups = [
    ['team', all('SELECT id FROM teams').map(r => r.id)],
    ['athlete', all('SELECT id FROM athletes').map(r => r.id)],
    ['referee', all('SELECT id FROM referees').map(r => r.id)],
    ['staff', all('SELECT id FROM venue_staff').map(r => r.id)]
  ]
  const validKeys = new Set()
  groups.forEach(([type, ids]) => ids.forEach(id => { syncBadge(type, id, operator, logIt); validKeys.add(`${type}:${id}`) }))
  // 清理主体已不存在的残留证件
  all('SELECT id, code, subject_type, subject_id FROM badges').forEach(b => {
    if (!validKeys.has(`${b.subject_type}:${b.subject_id}`)) {
      run(`UPDATE badges SET status='blocked', block_reason='主体已删除', zones='[]' WHERE id=?`, b.id)
    }
  })
}
// 人工暂扣 / 解除暂扣（解除时重新按资格同步）；incidentCode 非空时为安全事件联动，审计详情标注事件编号
function setBadgeBlocked(badgeId, blocked, reason, operator, incidentCode = null) {
  return withTransaction(() => {
    const b = get('SELECT * FROM badges WHERE id=?', badgeId)
    if (!b) throw new Error('证件不存在')
    if (blocked) {
      if (b.status === 'blocked' && b.block_manual) return { ok: true, idempotent: true }
      run(`UPDATE badges SET status='blocked', block_manual=1, block_reason=? WHERE id=?`, reason || '组委会暂扣', badgeId)
      addAccessLog('block', b.id, b.code,
        `证件 ${b.code} 被人工暂扣（${b.name}）${incidentCode ? `，联动安全事件 ${incidentCode}` : ''}`,
        reason, operator, 'danger')
    } else {
      if (b.status === 'active' && !b.block_manual) return { ok: true, idempotent: true }
      run(`UPDATE badges SET block_manual=0, block_reason=NULL WHERE id=?`, badgeId)
      syncBadge(b.subject_type, b.subject_id, operator, false)
      const fresh = get('SELECT * FROM badges WHERE id=?', badgeId)
      addAccessLog('unblock', b.id, b.code, `证件 ${b.code} 解除暂扣，按当前资格判定为${fresh.status === 'active' ? '有效' : '停用'}`, reason || null, operator, 'info')
    }
    return { ok: true }
  })
}
// 该队伍当前赛程的待赛/进行中比赛（资格与赛程共同决定动态入场权限）
function upcomingMatchOfTeam(teamId) {
  return get(`SELECT * FROM matches WHERE (team_a=? OR team_b=?) AND status='scheduled'
              ORDER BY time_label, id LIMIT 1`, teamId, teamId) || null
}
// 该裁判当前时段的在派待赛场次
function assignedMatchOfReferee(refereeId, timeLabel) {
  if (!timeLabel) return null
  const rows = all(`SELECT m.*, a.role FROM assignments a JOIN matches m ON m.id=a.match_id
                    WHERE a.referee_id=? AND a.status='assigned' AND m.status='scheduled' AND m.time_label=?`, refereeId, timeLabel)
  return rows[0] || null
}
// 回写：把本次放行结果同步到报名 / 排班 / 比赛 三个业务域（核验流水是唯一写入方）
function writeBackCheckin({ badge, type, subjectId, match, result, now, gate, timeLabel }) {
  const resultText = result === 'forced_pass' ? '强制放行' : '已核验'
  if (type === 'team' || type === 'athlete') {
    const col = type === 'team' ? 'team_id' : 'athlete_id'
    const reg = get(`SELECT id FROM registrations WHERE ${col}=? ORDER BY id DESC LIMIT 1`, subjectId)
    if (reg) run(`UPDATE registrations SET last_checkin_at=?, last_checkin_result=? WHERE id=?`, now, resultText, reg.id)
  }
  if (type === 'referee' && timeLabel) {
    const a = get(`SELECT a.id FROM assignments a JOIN matches m ON m.id=a.match_id
                   WHERE a.referee_id=? AND a.status='assigned' AND m.status='scheduled' AND m.time_label=?
                   ORDER BY m.id LIMIT 1`, subjectId, timeLabel)
    if (a) run(`UPDATE assignments SET checkin_at=? WHERE id=?`, now, a.id)
  }
  if (match) {
    if (type === 'team') {
      const col = match.team_a === subjectId ? 'checkin_a_at' : match.team_b === subjectId ? 'checkin_b_at' : null
      if (col) run(`UPDATE matches SET ${col}=? WHERE id=?`, now, match.id)
    }
    if (type === 'referee') {
      run(`UPDATE matches SET checkin_crew = (SELECT COUNT(*) FROM assignments WHERE match_id=? AND status='assigned' AND checkin_at IS NOT NULL),
                           checkin_crew_total = (SELECT COUNT(*) FROM assignments WHERE match_id=? AND status='assigned')
               WHERE id=?`, match.id, match.id, match.id)
    }
  }
  run(`UPDATE badges SET last_checkin_at=?, checkin_count=checkin_count+1 WHERE id=?`, now, badge.id)
}
// 核心：入场核验。按 资格 + 赛程 实时判定动态权限；放行结果原子回写三域，拒绝写入异常审计。
// 幂等：同证件 + 同场次 + 同日已有放行记录时，直接返回首次核验结果，不重复回写。
function verifyAccess({ code, venueId, matchId, gate, force, operator, timeLabel, reason }) {
  code = String(code || '').trim().toUpperCase()
  if (!code) throw new Error('请输入证件编号')
  const op = operator || '检票员'
  const now = get("SELECT datetime('now','localtime') t")?.t
  const today = get("SELECT date('now','localtime') d")?.d
  venueId = venueId ? Number(venueId) : null
  matchId = matchId ? Number(matchId) : null
  const badge = get('SELECT * FROM badges WHERE code=?', code)

  // 无法识别证件：仅登记异常流水，不存在回写目标
  if (!badge) {
    const r = run(`INSERT INTO access_checkins (badge_code,venue_id,match_id,gate,result,is_duplicate,reason,reason_code,operator,checkin_date)
                   VALUES (?,?,?,?,'deny',0,?,?,?,?)`,
      code, venueId, matchId, gate || null, '证件不存在或已注销', 'BADGE_NOT_FOUND', op, today)
    addAccessLog('deny', null, code, `${gate || '核验口'} 拒绝入场：证件 ${code} 无法识别`, '证件不存在或已注销', op, 'danger', matchId, venueId)
    return { ok: true, pass: false, result: 'deny', reason: '证件不存在或已注销', reason_code: 'BADGE_NOT_FOUND', checkin_id: Number(r.lastInsertRowid) }
  }
  const type = badge.subject_type, subjectId = badge.subject_id
  const state = subjectState(type, subjectId)
  let match = matchId ? get('SELECT * FROM matches WHERE id=?', matchId) : null
  if (matchId && !match) throw new Error('核验场次不存在')
  if (match) timeLabel = match.time_label
  const zones = safeParseJson(badge.zones) || []
  let decision = null   // { code, message, eligibleMatch, roleText }

  if (badge.status === 'blocked' || !state.exists || state.status !== 'approved') {
    const why = !state.exists ? '证件主体已不存在'
      : badge.block_manual ? (badge.block_reason || '证件被组委会暂扣')
      : state.status === 'pending' ? '资格尚在审核中'
      : state.status === 'rejected' ? '资格审核未通过'
      : state.status === 'withdrawn' ? '已退报，资格终止'
      : state.status === 'revoked' ? '资格已被撤销'
      : (state.raw_status === '离岗' ? '场地工作人员已离岗' : '当前不在岗')
    decision = { code: 'BADGE_BLOCKED', message: why }
  } else if (type === 'team') {
    // 队伍：资格有效 + 该场确为其赛程（对阵双方）+ 场地一致 + 场次可入场
    if (!match) {
      const up = upcomingMatchOfTeam(subjectId)
      if (up) match = up
    }
    if (!match) {
      decision = { code: 'NO_FIXTURE', message: '当前没有该队伍的待赛场次（按赛程入场）' }
    } else if (match.is_paused) {
      decision = { code: 'MATCH_PAUSED', message: `该场次已被安全事件${match.pause_incident_id ? '（' + (get('SELECT code FROM incidents WHERE id=?', match.pause_incident_id)?.code || '') + '）' : ''}暂停，恢复或改期后方可入场`, eligibleMatch: match }
    } else if (match.status !== 'scheduled') {
      decision = { code: 'MATCH_NOT_PLAYABLE', message: `该场次当前为${match.status === 'finished' ? '已完赛' : '已取消'}状态，不能入场`, eligibleMatch: match }
    } else if (match.team_a !== subjectId && match.team_b !== subjectId) {
      decision = { code: 'NO_FIXTURE', message: '该队伍不是本场对阵双方，无本场入场资格', eligibleMatch: match }
    } else if (venueId && match.venue_id && venueId !== match.venue_id) {
      decision = { code: 'WRONG_VENUE', message: `本场比赛在「${get('SELECT name FROM venues WHERE id=?', match.venue_id)?.name}」进行，当前核验场地不符`, eligibleMatch: match }
    }
  } else if (type === 'athlete') {
    // 田径单项运动员：项目资格有效 + 核验场地为该项目场地（无对阵赛程）
    const spo = state.sport_id ? get('SELECT * FROM sports WHERE id=?', state.sport_id) : null
    const expectedVenue = spo ? vid(spo.venue) : null
    if (match && match.sport_id !== state.sport_id) {
      decision = { code: 'NO_FIXTURE', message: '该运动员报名项目与本场比赛无关' }
    } else if (match && match.is_paused) {
      decision = { code: 'MATCH_PAUSED', message: '该场次因安全事件暂停，恢复或改期后方可入场' }
    } else if (venueId && expectedVenue && venueId !== expectedVenue) {
      decision = { code: 'WRONG_VENUE', message: `该运动员项目在「${spo.venue}」进行，当前核验场地不符` }
    }
  } else if (type === 'referee') {
    // 裁判：按排班核验——当前时段须在该场（或同时段某场）执法名单中
    let assigned = null
    if (match) {
      assigned = get(`SELECT * FROM assignments WHERE match_id=? AND referee_id=? AND status='assigned'`, match.id, subjectId)
      if (!assigned && timeLabel) assigned = get(`SELECT a.*, m.id match_id FROM assignments a JOIN matches m ON m.id=a.match_id
                                                   WHERE a.referee_id=? AND a.status='assigned' AND m.status='scheduled' AND m.time_label=?
                                                   ORDER BY m.id LIMIT 1`, subjectId, timeLabel)
    } else if (timeLabel) {
      const m0 = assignedMatchOfReferee(subjectId, timeLabel)
      if (m0) { assigned = { role: m0.role }; match = m0 }
    }
    if (!assigned) {
      decision = { code: 'NOT_ASSIGNED', message: timeLabel ? `该裁判在 ${timeLabel} 时段没有在派执法任务（按排班入场）` : '该裁判当前没有在派执法任务，请选择核验场次或时段' }
    } else if (match.is_paused) {
      decision = { code: 'MATCH_PAUSED', message: '执法场次因安全事件暂停，恢复或改期后方可入场' }
    } else if (venueId && match.venue_id && venueId !== match.venue_id) {
      decision = { code: 'WRONG_VENUE', message: `该裁判执法场次在「${get('SELECT name FROM venues WHERE id=?', match.venue_id)?.name}」，当前核验场地不符` }
    } else if (match.status !== 'scheduled') {
      decision = { code: 'MATCH_NOT_PLAYABLE', message: '执法场次不是待赛状态' }
    } else {
      decision = { roleText: ROLE_NAME[assigned.role] || '执法' }
    }
  } else if (type === 'staff') {
    // 场地工作人员：按服务场地与岗位授权入场，不依赖赛程
    if (venueId && state.venue_id && venueId !== state.venue_id) {
      decision = { code: 'WRONG_VENUE', message: `该工作人员服务场地为「${get('SELECT name FROM venues WHERE id=?', state.venue_id)?.name}」` }
    }
  }

  // 同日同场幂等：已放行过则返回首次结果（重复扫码不重复计数/回写）
  const dup = match?.id
    ? get(`SELECT * FROM access_checkins WHERE badge_id=? AND match_id=? AND checkin_date=?
           AND result IN ('pass','forced_pass') AND is_duplicate=0 ORDER BY id DESC LIMIT 1`, badge.id, match.id, today)
    : get(`SELECT * FROM access_checkins WHERE badge_id=? AND match_id IS NULL AND checkin_date=?
           AND result IN ('pass','forced_pass') AND is_duplicate=0 ORDER BY id DESC LIMIT 1`, badge.id, today)

  const makeRecord = (result, isDuplicate, reasonText, reasonCode, roleText, zonesNow) => run(
    `INSERT INTO access_checkins (badge_id,badge_code,subject_type,subject_id,subject_name,venue_id,match_id,sport_id,gate,result,is_duplicate,role_snapshot,zones,reason,reason_code,operator,checkin_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    badge.id, badge.code, type, subjectId, badge.name, venueId, match?.id ?? null,
    match?.sport_id ?? state.sport_id ?? badge.sport_id ?? null,
    gate || GATE_BY_TYPE[type] || '核验口', result, isDuplicate ? 1 : 0, roleText || null,
    JSON.stringify(zonesNow || zones), reasonText || null, reasonCode || null, op, today)

  // 拒绝（或强制放行）处理
  if (decision && decision.code) {
    if (dup) {
      makeRecord(dup.result, true, `重复核验（首次已于 ${dup.created_at} 放行）`, 'DUPLICATE', dup.role_snapshot, zones)
      return {
        ok: true, pass: true, result: dup.result, duplicate: true,
        message: `重复核验，该证已于 ${dup.created_at} 在本口放行`,
        badge: { code: badge.code, name: badge.name, subject_type: type }, match: match ? matchTitle(match) : null
      }
    }
    if (force) {
      if (!String(reason || '').trim()) throw new Error('强制放行必须填写原因并留痕')
      const rr = makeRecord('forced_pass', false, `强制放行：${decision.message}；原因：${reason}`, decision.code, decision.roleText, zones)
      writeBackCheckin({ badge, type, subjectId, match, result: 'forced_pass', now, gate, timeLabel })
      if (match) run(`UPDATE matches SET admission_denied=admission_denied+1 WHERE id=?`, match.id)
      addAccessLog('force_pass', badge.id, badge.code,
        `${gate || GATE_BY_TYPE[type]} 强制放行 ${badge.name}（${SUBJECT_NAME[type]}）入场${match ? '：' + matchTitle(match) : ''}；拦截原因：${decision.message}`,
        String(reason).trim(), op, 'warn', match?.id ?? null, venueId)
      return {
        ok: true, pass: true, result: 'forced_pass', checkin_id: Number(rr.lastInsertRowid),
        message: `已强制放行：${decision.message}（已留痕并计入异常审计）`,
        badge: { code: badge.code, name: badge.name, subject_type: type, zones }, match: match ? matchTitle(match) : null
      }
    }
    const rr = makeRecord('deny', false, decision.message, decision.code, decision.roleText, zones)
    if (match) run(`UPDATE matches SET admission_denied=admission_denied+1 WHERE id=?`, match.id)
    addAccessLog('deny', badge.id, badge.code,
      `${gate || GATE_BY_TYPE[type]} 拒绝 ${badge.name}（${SUBJECT_NAME[type]}）入场${match ? '：' + matchTitle(match) : ''}：${decision.message}`,
      decision.message, op, 'danger', match?.id ?? null, venueId)
    return {
      ok: true, pass: false, result: 'deny', reason: decision.message, reason_code: decision.code,
      checkin_id: Number(rr.lastInsertRowid),
      badge: { code: badge.code, name: badge.name, subject_type: type }, match: match ? matchTitle(match) : null
    }
  }

  // 正常放行（含重复核验）
  const roleText = decision?.roleText || (type === 'staff' ? state.role : SUBJECT_NAME[type])
  if (dup) {
    makeRecord('pass', true, `重复核验（首次已于 ${dup.created_at} 放行）`, 'DUPLICATE', roleText, zones)
    return {
      ok: true, pass: true, result: 'pass', duplicate: true,
      message: `✅ 重复核验，该证已于 ${dup.created_at} 在本口放行`,
      badge: { code: badge.code, name: badge.name, subject_type: type, zones }, match: match ? matchTitle(match) : null
    }
  }
  const rr = makeRecord('pass', false, null, null, roleText, zones)
  writeBackCheckin({ badge, type, subjectId, match, result: 'pass', now, gate, timeLabel })
  addAccessLog('pass', badge.id, badge.code,
    `${gate || GATE_BY_TYPE[type]} 放行 ${badge.name}（${roleText}）进入${zones.map(z => ZONE_NAME[z]).join('、')}${match ? '：' + matchTitle(match) : ''}`,
    null, op, 'info', match?.id ?? null, venueId)
  return {
    ok: true, pass: true, result: 'pass', checkin_id: Number(rr.lastInsertRowid),
    role: roleText, zones, zones_text: zones.map(z => ZONE_NAME[z]).join('、'),
    badge: { code: badge.code, name: badge.name, subject_type: type },
    match: match ? matchTitle(match) : null,
    message: `✅ 核验通过：${badge.name}（${roleText}）可进入 ${zones.map(z => ZONE_NAME[z]).join('、')}`
  }
}

// 场次入场核验汇总：双方到场 + 执法到岗 + 异常拦截
function matchAdmissionRows(matches) {
  return matches.filter(m => m.team_a != null && m.team_b != null && m.status !== 'void').map(m => {
    const crewRows = all(`SELECT a.*, r.name rname FROM assignments a JOIN referees r ON r.id=a.referee_id
                          WHERE a.match_id=? AND a.status='assigned' ORDER BY a.role, a.id`, m.id)
    return {
      match_id: m.id,
      title: matchTitle(m),
      status: m.status,
      time_label: m.time_label,
      venue: m.venue_id ? get('SELECT name FROM venues WHERE id=?', m.venue_id)?.name : null,
      team_a: { id: m.team_a, name: get('SELECT name FROM teams WHERE id=?', m.team_a)?.name, checked_in: !!m.checkin_a_at, at: m.checkin_a_at },
      team_b: { id: m.team_b, name: m.team_b ? get('SELECT name FROM teams WHERE id=?', m.team_b)?.name : null, checked_in: !!m.checkin_b_at, at: m.checkin_b_at },
      crew: crewRows.map(a => ({ id: a.id, name: a.rname, role: a.role, role_name: ROLE_NAME[a.role], checked_in: !!a.checkin_at, at: a.checkin_at })),
      crew_checked: crewRows.filter(a => a.checkin_at).length,
      crew_total: crewRows.length,
      denied: m.admission_denied || 0,
      is_paused: !!m.is_paused,
      pause_reason: m.pause_reason || null,
      pause_incident_code: m.pause_incident_id ? get('SELECT code FROM incidents WHERE id=?', m.pause_incident_id)?.code || null : null
    }
  })
}
/* ================= 积分与奖牌 ================= */
function rebuildStandings(sportId) {
  const sports = sportId ? [sportId] : all('SELECT * FROM sports').map(s => s.id)
  sports.forEach(sid => {
    all('SELECT id FROM standings WHERE sport_id=?', sid).forEach(r => run('DELETE FROM standings WHERE id=?', r.id))
    // 仅已通过资格审核的队伍纳入积分榜
    const teams = all(`SELECT id FROM teams WHERE sport_id=? AND status='approved'`, sid).map(t => t.id)
    teams.forEach(t => run('INSERT INTO standings (sport_id,team_id) VALUES (?,?)', sid, t))
    const spo0 = get('SELECT format FROM sports WHERE id=?', sid)
    const done = all(`SELECT * FROM matches WHERE sport_id=? AND status='finished'`, sid)
      .filter(m => spo0.format === 'roundrobin' ? m.stage === '循环' : m.stage === '小组')
    done.forEach(m => {
      const rowA = get('SELECT * FROM standings WHERE sport_id=? AND team_id=?', sid, m.team_a)
      const rowB = get('SELECT * FROM standings WHERE sport_id=? AND team_id=?', sid, m.team_b)
      if (!rowA || !rowB) return
      const sa = m.score_a, sb = m.score_b
      rowA.play += 1; rowB.play += 1
      rowA.gf += sa; rowA.ga += sb; rowB.gf += sb; rowB.ga += sa
      if (sa > sb) { rowA.win++; rowB.lose++; rowA.points += 3 }
      else if (sa < sb) { rowB.win++; rowA.lose++; rowB.points += 3 }
      else { rowA.draw++; rowB.draw++; rowA.points += 1; rowB.points += 1 }
      run('UPDATE standings SET play=?,win=?,draw=?,lose=?,gf=?,ga=?,points=? WHERE id=?',
        rowA.play, rowA.win, rowA.draw, rowA.lose, rowA.gf, rowA.ga, rowA.points, rowA.id)
      run('UPDATE standings SET play=?,win=?,draw=?,lose=?,gf=?,ga=?,points=? WHERE id=?',
        rowB.play, rowB.win, rowB.draw, rowB.lose, rowB.gf, rowB.ga, rowB.points, rowB.id)
    })
    // 排名
    const rows = all('SELECT * FROM standings WHERE sport_id=?', sid).sort((x, y) => y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga) || x.id - y.id)
    rows.forEach((r, i) => run('UPDATE standings SET rank=? WHERE id=?', i + 1, r.id))
  })
}
function unitOfTeam(teamId) {
  const t = teamId == null ? null : get('SELECT unit_id FROM teams WHERE id=?', teamId)
  return t ? t.unit_id : null
}
function recomputeMedals() {
  all('SELECT unit_id FROM medals').forEach(r => run('DELETE FROM medals WHERE unit_id=?', r.unit_id))
  const add = (uid, medal) => { if (!uid) return; const row = get('SELECT * FROM medals WHERE unit_id=?', uid); const k = medal === 'gold' ? 'gold' : medal === 'silver' ? 'silver' : 'bronze'; if (row) run(`UPDATE medals SET ${k}=${k}+1 WHERE unit_id=?`, uid); else run(`INSERT INTO medals (unit_id,${k}) VALUES (?,1)`, uid) }
  const sports = all('SELECT * FROM sports')
  sports.forEach(spo => {
    if (spo.format === 'track') {
      // 仅已录入有效成绩且仍具备资格的运动员参与前 3 名结算
      const tops = all(`SELECT e.* FROM entries e
                        JOIN athletes a ON a.id=e.athlete_id AND a.status='approved'
                        WHERE e.sport_id=? AND e.mark IS NOT NULL
                        ORDER BY e.mark ASC LIMIT 3`, spo.id)
      add(tops[0]?.unit_id, 'gold'); add(tops[1]?.unit_id, 'silver'); add(tops[2]?.unit_id, 'bronze')
    } else if (spo.format === 'roundrobin') {
      const champ = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=1', spo.id)
      const second = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=2', spo.id)
      const third = get('SELECT s.*, t.unit_id FROM standings s JOIN teams t ON t.id=s.team_id WHERE s.sport_id=? AND s.rank=3', spo.id)
      if (all('SELECT * FROM standings WHERE sport_id=?', spo.id).some(r => r.play > 0)) { add(champ?.unit_id, 'gold'); add(second?.unit_id, 'silver'); add(third?.unit_id, 'bronze') }
    } else {
      const fin = get(`SELECT * FROM matches WHERE sport_id=? AND status='finished' AND stage='决赛' ORDER BY id`, spo.id)
      const thirdM = get(`SELECT * FROM matches WHERE sport_id=? AND status='finished' AND stage='季军' ORDER BY id`, spo.id)
      const pendingThird = get(`SELECT id FROM matches WHERE sport_id=? AND status='scheduled' AND stage='季军'`, spo.id)
      const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, spo.id)
      const gold = fin && isActiveTeam(fin.winner) ? fin.winner : null
      let silver = null, bronze = null

      if (gold != null) {
        add(unitOfTeam(gold), 'gold')
        const finOpponent = gold === fin.team_a ? fin.team_b : fin.team_a
        if (isActiveTeam(finOpponent)) silver = finOpponent

        // 决赛负者失去资格时：若季军战已赛，季军战胜/负者依次递补银/铜牌；
        // 若季军战待赛，先不结算银/铜；若不存在季军战，再按半决赛名次递补
        if (silver == null && !pendingThird) {
          if (thirdM && isActiveTeam(thirdM.winner)) {
            silver = thirdM.winner
            const thirdLoser = thirdM.winner === thirdM.team_a ? thirdM.team_b : thirdM.team_a
            if (isActiveTeam(thirdLoser)) bronze = thirdLoser
          }
          if (silver == null) {
            const disqualifiedFinalist = gold === fin.team_a ? fin.team_b : fin.team_a
            const dqSemi = semis.find(m => [m.team_a, m.team_b].includes(disqualifiedFinalist))
            silver = canonicalSemiFinalist(dqSemi)
            if (silver === gold || !isActiveTeam(silver)) silver = null
          }
          if (bronze == null) {
            const goldSemi = semis.find(m => [m.team_a, m.team_b].includes(gold))
            bronze = canonicalSemiLoser(goldSemi)
            if (bronze === silver) bronze = null
          }
        } else if (bronze == null && isActiveTeam(thirdM?.winner)) {
          bronze = thirdM.winner
        }
      } else if (thirdM && isActiveTeam(thirdM.winner)) {
        bronze = thirdM.winner
      }
      if (silver != null) add(unitOfTeam(silver), 'silver')
      if (bronze != null) add(unitOfTeam(bronze), 'bronze')
    }
  })
}
/* ================= 编排下一轮（KO） ================= */
const STAGE_ORDER = { '小组': 1, '循环': 1, '半决赛': 2, '决赛': 3, '季军': 3 }
const KO_STAGES = ['半决赛', '决赛', '季军']   // 淘汰赛阶段：不允许平分收场
const loserOf = m => (m.winner === m.team_a ? m.team_b : m.team_a)
function finishMatch(id, sa, sb, tbA = null, tbB = null) {
  // 单事务：比分落库 + 积分榜重建 + 奖牌重算 + 执法归档，任一失败整体回滚，杜绝半结算
  return withTransaction(() => {
    const m = get('SELECT * FROM matches WHERE id=?', id)
    if (m.status !== 'scheduled') throw new Error('该场次已完赛或取消，不能重复录入比分')
    if (m.is_paused) {
      const code = m.pause_incident_id ? get('SELECT code FROM incidents WHERE id=?', m.pause_incident_id)?.code : null
      throw new Error(`该场次因安全事件${code ? '（' + code + '）' : ''}暂停中，需在安全事件处置中恢复或改期后才能录入比分`)
    }
    if (m.team_a == null || m.team_b == null) throw new Error('该场次存在轮空，无需录入比分')
    if (!isActiveTeam(m.team_a) || !isActiveTeam(m.team_b)) throw new Error('对阵中存在失去资格队伍，需先完成淘汰赛级联调整')
    let winner = null, ta = null, tb = null
    if (sa > sb) winner = m.team_a
    else if (sb > sa) winner = m.team_b
    else if (KO_STAGES.includes(m.stage)) {
      // 淘汰赛常规时间平分：必须录入加时/点球决胜比分，且决胜不能再次持平
      ta = tbA === null || tbA === undefined || tbA === '' ? null : Number(tbA)
      tb = tbB === null || tbB === undefined || tbB === '' ? null : Number(tbB)
      if (!Number.isInteger(ta) || !Number.isInteger(tb) || ta < 0 || tb < 0) {
        throw new Error('淘汰赛常规时间平分，需录入加时/点球决胜比分')
      }
      if (ta === tb) throw new Error('决胜比分不能再次持平')
      winner = ta > tb ? m.team_a : m.team_b
    }
    // 小组/循环允许平局（winner 为 NULL）；决胜比分不计入进失球
    run(`UPDATE matches SET score_a=?, score_b=?, tb_a=?, tb_b=?, winner=?, status='finished' WHERE id=?`, sa, sb, ta, tb, winner, id)
    rebuildStandings(m.sport_id)
    recomputeMedals()
    // 联动比赛状态：执法安排随完赛归档留痕
    lockAssignmentsOnFinish({ ...m, status: 'finished' }, '系统')
  })
}

// 新增场次后：按整场执法配置自动补齐主裁/助理/记录台（失败不阻断编排，供排班页处理）
function autoCrewForNewMatches(matchIds, operator = '系统') {
  return autoFillCrews(operator, matchIds, '赛程新增联动')
}

/* ================= 淘汰赛退赛/撤销资格的级联处理 ================= */
const ACTIVE_TEAM_STATUS = new Set(['approved'])
const isActiveTeam = teamId => teamId != null && ACTIVE_TEAM_STATUS.has(get('SELECT status FROM teams WHERE id=?', teamId)?.status)

// 未赛场次按弃权判对手 3:0；执法安排随完赛归档
function finishWalkover(m, winnerId, note, operator = '系统') {
  if (m.status === 'finished' && m.winner === winnerId && isActiveTeam(winnerId)) {
    run(`UPDATE matches SET score_a=?, score_b=?, tb_a=NULL, tb_b=NULL, winner=?, note=? WHERE id=?`,
      m.team_a === winnerId ? 3 : 0, m.team_b === winnerId ? 3 : 0, winnerId, note, m.id)
    return false
  }
  const wasFinished = m.status === 'finished'
  const winnerSide = m.team_a === winnerId ? 'a' : m.team_b === winnerId ? 'b' : null
  const scoreA = winnerSide === 'a' ? 3 : 0
  const scoreB = winnerSide === 'b' ? 3 : 0
  run(`UPDATE matches SET status='finished', score_a=?, score_b=?, tb_a=NULL, tb_b=NULL, winner=?, note=? WHERE id=?`,
    scoreA, scoreB, winnerId, note, m.id)
  if (wasFinished) {
    addLog('match_change', m.id, null, `${matchTitle({ ...m, status: 'finished', winner: winnerId })} 因资格变动改判为有效队伍 3:0 胜`, note, operator)
  } else {
    lockAssignmentsOnFinish({ ...m, status: 'finished', winner: winnerId }, operator)
  }
  return !wasFinished
}

// 已赛场次取消成绩；仍在派/计入历史的执法安排同步解除
function voidMatch(m, note, operator = '系统') {
  run(`UPDATE matches SET status='void', score_a=NULL, score_b=NULL, tb_a=NULL, tb_b=NULL, winner=NULL, note=?,
      checkin_a_at=NULL, checkin_b_at=NULL, checkin_crew=0, checkin_crew_total=0, admission_denied=0 WHERE id=?`, note, m.id)
  releaseAssignmentsOfMatch({ ...m, status: 'void' }, note, operator)
}

// 重算场次执法到岗计数（调班/解除后保持与在派名单一致）
function refreshMatchCrewCheckin(matchId) {
  if (matchId == null) return
  run(`UPDATE matches SET checkin_crew = (SELECT COUNT(*) FROM assignments WHERE match_id=? AND status='assigned' AND checkin_at IS NOT NULL),
                       checkin_crew_total = (SELECT COUNT(*) FROM assignments WHERE match_id=? AND status='assigned')
               WHERE id=?`, matchId, matchId, matchId)
}

// 已生成的后续轮次需要改赛或重赛：释放原执法安排，回到待赛并替换对阵队伍
function resetScheduledMatch(m, teamA, teamB, note, operator = '系统') {
  releaseAssignmentsOfMatch(m, note, operator, 'match_change')
  run(`UPDATE matches SET status='scheduled', team_a=?, team_b=?, score_a=NULL, score_b=NULL, tb_a=NULL, tb_b=NULL, winner=NULL, note=?,
      checkin_a_at=NULL, checkin_b_at=NULL, checkin_crew=0, checkin_crew_total=0, admission_denied=0 WHERE id=?`,
    teamA, teamB, note, m.id)
  const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
  addLog('match_change', m.id, null, `${matchTitle(m)} 因资格变动调整对阵，原执法安排已解除`, note, operator)
  return fresh
}

function canonicalSemiWinner(m) {
  if (m.status !== 'finished' || m.winner == null || !isActiveTeam(m.winner)) return null
  return m.winner
}
function canonicalSemiLoser(m) {
  const winner = canonicalSemiWinner(m)
  if (winner == null) return null
  const loser = winner === m.team_a ? m.team_b : m.team_a
  return isActiveTeam(loser) ? loser : null
}
// 半决赛胜者赛后失去资格时，该场被取消；唯一仍有效的原负者递补进入决赛
function canonicalSemiFinalist(m) {
  const winner = canonicalSemiWinner(m)
  if (winner != null) return winner
  if (m.status !== 'void') return null
  const active = [m.team_a, m.team_b].filter(isActiveTeam)
  return active.length === 1 ? active[0] : null
}
function activeSideOfMatch(m) {
  const active = [m.team_a, m.team_b].filter(isActiveTeam)
  return active.length === 1 ? active[0] : null
}

function createPlacementMatch(sportId, stage, teamA, teamB, orderNo, timeLabel, status, winner, note) {
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  const venueName = stage === '决赛' ? spo.venue : '备用2号场'
  const scoreA = status === 'finished' ? (teamA && winner === teamA ? 3 : 0) : null
  const scoreB = status === 'finished' ? (teamB && winner === teamB ? 3 : 0) : null
  const r = run(`INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status,score_a,score_b,winner,note)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    sportId, stage, teamA, teamB, vid(venueName), orderNo, timeLabel, status, scoreA, scoreB, status === 'finished' ? winner : null, note)
  return Number(r.lastInsertRowid)
}

// 将决赛/季军战同步到半决赛的权威晋级结果；处理递补、重赛、轮空与奖牌自动结算
function syncPlacementMatch(sportId, stage, desired, orderNo, timeLabel, reason, operator = '系统') {
  const m = get(`SELECT * FROM matches WHERE sport_id=? AND stage=?`, sportId, stage)
  const [a, b] = desired.teams
  if (!desired.teams.length) {
    if (m && m.status !== 'void') voidMatch(m, reason, operator)
    return null
  }

  if (desired.status === 'scheduled') {
    if (m && m.status === 'scheduled' && m.team_a === a && m.team_b === b) return m
    const fresh = m
      ? resetScheduledMatch(m, a, b, reason, operator)
      : get('SELECT * FROM matches WHERE id=?', createPlacementMatch(sportId, stage, a, b, orderNo, timeLabel, 'scheduled', null, null))
    if (!m) addLog('schedule_added', fresh.id, null, `${matchTitle(fresh)} 由淘汰赛资格变动级联生成`, reason, operator)
    autoCrewForNewMatches([fresh.id], operator)
    return fresh
  }

  // finished：当前轮次只剩一个有效队伍，按 3:0 轮空完赛并立即结算奖牌
  const winner = desired.teams[0]
  if (m) {
    const wasScheduled = m.status === 'scheduled'
    run(`UPDATE matches SET status='finished', team_a=?, team_b=?, score_a=?, score_b=?, tb_a=NULL, tb_b=NULL, winner=?, note=? WHERE id=?`,
      a, b, a ? (winner === a ? 3 : 0) : 0, b ? (winner === b ? 3 : 0) : 0, winner, reason, m.id)
    const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
    if (wasScheduled) lockAssignmentsOnFinish(fresh, operator)
    addLog('match_change', m.id, null, `${matchTitle(fresh)} 因资格变动按轮空完赛`, reason, operator)
    return fresh
  }

  const id = createPlacementMatch(sportId, stage, a, b, orderNo, timeLabel, 'finished', winner, reason)
  const fresh = get('SELECT * FROM matches WHERE id=?', id)
  addLog('schedule_added', id, null, `${matchTitle(fresh)} 因资格变动按轮空完赛生成`, reason, operator)
  return fresh
}

function reconcileKnockout(sportId, reason, operator = '系统') {
  const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
  if (semis.length !== 2) return { created: 0, adjusted: 0 }
  // 正在待赛且可继续比赛的半决赛（含小组递补）不应提前决定决赛；已取消/完赛才可按轮空结算
  const settled = semis.every(m => m.status === 'finished' || m.status === 'void')
  const finalists = semis.map(canonicalSemiFinalist).filter(Boolean)
  const losers = semis.map(canonicalSemiLoser).filter(Boolean)

  const before = all(`SELECT id,status,team_a,team_b,winner FROM matches WHERE sport_id=? AND stage IN ('决赛','季军')`, sportId)
  if (!settled) {
    all(`SELECT * FROM matches WHERE sport_id=? AND stage IN ('决赛','季军') AND status<>'void'`, sportId)
      .forEach(m => voidMatch(m, reason, operator))
    const after = all(`SELECT id,status,team_a,team_b,winner FROM matches WHERE sport_id=? AND stage IN ('决赛','季军')`, sportId)
    return { created: 0, adjusted: after.filter(x => before.some(y => y.id === x.id && JSON.stringify(y) !== JSON.stringify(x))).length }
  }
  const final = get(`SELECT * FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
  // 决赛已完赛且仍有有效决赛队伍时，保留原决赛/季军战链路；只把失格一方改为对手 3:0 胜。
  // 若决赛双方都失格，才回退到半决赛口径重新递补决赛。
  const preserveFinishedPlacement = final?.status === 'finished' && activeSideOfMatch(final) != null
  if (preserveFinishedPlacement) {
    if (!isActiveTeam(final.team_a) || !isActiveTeam(final.team_b)) {
      finishWalkover(final, activeSideOfMatch(final), reason, operator)
    }
  } else if (finalists.length === 2) {
    syncPlacementMatch(sportId, '决赛', { status: 'scheduled', teams: finalists }, 101, '16:00', reason, operator)
  } else if (finalists.length === 1) {
    const f = finalists[0]
    syncPlacementMatch(sportId, '决赛', { status: 'finished', teams: semis.find(m => canonicalSemiFinalist(m) === f).team_a === f ? [f, null] : [null, f] },
      101, '16:00', reason, operator)
  } else {
    syncPlacementMatch(sportId, '决赛', { teams: [] }, 101, '16:00', reason, operator)
  }

  const third = get(`SELECT * FROM matches WHERE sport_id=? AND stage='季军'`, sportId)
  if (preserveFinishedPlacement) {
    if (third && third.status !== 'void') {
      const remaining = activeSideOfMatch(third)
      if (!isActiveTeam(third.team_a) || !isActiveTeam(third.team_b)) {
        if (remaining != null) finishWalkover(third, remaining, reason, operator)
        else voidMatch(third, reason, operator)
      }
    }
  } else if (losers.length === 2) {
    syncPlacementMatch(sportId, '季军', { status: 'scheduled', teams: losers }, 102, '15:30', reason, operator)
  } else if (losers.length === 1) {
    const l = losers[0]
    syncPlacementMatch(sportId, '季军', { status: 'finished', teams: semis.find(m => canonicalSemiLoser(m) === l).team_a === l ? [l, null] : [null, l] },
      102, '15:30', reason, operator)
  } else {
    syncPlacementMatch(sportId, '季军', { teams: [] }, 102, '15:30', reason, operator)
  }

  const after = all(`SELECT id,status,team_a,team_b,winner FROM matches WHERE sport_id=? AND stage IN ('决赛','季军')`, sportId)
  return {
    created: after.filter(x => !before.some(y => y.id === x.id)).length,
    adjusted: after.filter(x => before.some(y => y.id === x.id && JSON.stringify(y) !== JSON.stringify(x))).length
  }
}

// 足球小组赛出线名额被取消时，只在尚未进行的半决赛按同组名次递补；半决赛已赛则按失利方递补
function groupAlternateFor(sportId, groupName, occupiedTeamIds) {
  const occupied = new Set(occupiedTeamIds)
  const ids = all(`SELECT DISTINCT team_a id FROM matches WHERE sport_id=? AND group_name=? AND team_a IS NOT NULL
                   UNION SELECT DISTINCT team_b FROM matches WHERE sport_id=? AND group_name=? AND team_b IS NOT NULL`,
    sportId, groupName, sportId, groupName)
    .map(r => r.id)
    .filter(id => isActiveTeam(id) && !occupied.has(id))
  return ids
    .map(id => ({ id, rank: get('SELECT rank r FROM standings WHERE sport_id=? AND team_id=?', sportId, id)?.r ?? 999 }))
    .sort((a, b) => a.rank - b.rank || a.id - b.id)[0]?.id ?? null
}

function replaceScheduledKnockoutTeam(m, teamId, replacement, reason, operator = '系统') {
  const teamA = m.team_a === teamId ? replacement : m.team_a
  const teamB = m.team_b === teamId ? replacement : m.team_b
  run(`UPDATE matches SET team_a=?, team_b=?, note=? WHERE id=?`, teamA, teamB, reason, m.id)
  const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
  addLog('match_change', m.id, null, `${matchTitle(m)}：失去资格队伍由递补队伍替换，执法安排继续有效`, reason, operator)
  return fresh
}

// 循环赛重排的场次初始化：保留仍存在对阵的时间/场地，新对阵补齐不撞场的默认时段
function initRoundRobinSchedule(sportId, oldMatches) {
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  const defaultVenueId = vid(spo.venue)
  const oldByPair = new Map()
  oldMatches.forEach(m => {
    if (!m.team_a || !m.team_b) return
    oldByPair.set(`${Math.min(m.team_a, m.team_b)}-${Math.max(m.team_a, m.team_b)}`, m)
  })
  const taken = new Set(all(`SELECT venue_id, time_label FROM matches
                            WHERE status='scheduled' AND venue_id IS NOT NULL AND time_label IS NOT NULL`)
    .map(m => `${m.venue_id}:${m.time_label}`))
  const makeTime = index => {
    const total = index * 20
    return `${String(9 + Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }
  let timeIndex = 0
  const nextSlot = venueId => {
    let label = makeTime(timeIndex++)
    while (venueId && taken.has(`${venueId}:${label}`)) label = makeTime(timeIndex++)
    if (venueId) taken.add(`${venueId}:${label}`)
    return label
  }
  return ([a, b], orderNo) => {
    const old = oldByPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`)
    const venueId = old?.venue_id || defaultVenueId
    const timeLabel = old?.time_label || nextSlot(venueId)
    return { venueId, timeLabel }
  }
}

function generateKO(sportId) {
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  if (spo.format === 'knockout') {
    // 羽毛球：半决赛全部有效完赛/取消后，由统一级联逻辑生成决赛与季军战
    const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
    const hasFinal = get(`SELECT id FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
    if (semis.length && semis.every(s => s.status === 'finished' || s.status === 'void')) {
      if (semis.some(s => s.status === 'finished' && s.winner == null)) return '半决赛存在平分未决胜场次，请先补录加时/点球决胜比分'
      reconcileKnockout(sportId, '淘汰赛按半决赛赛果编排', '系统')
      return '已生成羽毛球 决赛 与 季军战'
    }
    return null
  }
  // group_knockout：小组完成后生成半决赛，半决赛完成/取消后由统一逻辑同步决赛与季军战
  const groups = ['A组', 'B组']
  const done = {}
  groups.forEach(g => {
    const gms = all(`SELECT * FROM matches WHERE sport_id=? AND group_name=?`, sportId, g)
    done[g] = gms.length === 0 || gms.every(m => m.status === 'finished' || m.status === 'void')
  })
  const hasSemi = get(`SELECT id FROM matches WHERE sport_id=? AND stage='半决赛'`, sportId)
  if (groups.every(g => done[g]) && !hasSemi) {
    const rankOf = g => {
      const ids = all(`SELECT DISTINCT team_a id FROM matches WHERE sport_id=? AND group_name=? AND team_a IS NOT NULL UNION SELECT DISTINCT team_b FROM matches WHERE sport_id=? AND group_name=? AND team_b IS NOT NULL`, sportId, g, sportId, g)
        .map(r => r.id)
        .filter(id => get('SELECT status FROM teams WHERE id=?', id)?.status === 'approved')
      // 与积分榜同一排名口径（积分 → 净胜球），避免同分时晋级对阵与榜单不一致
      return ids.map(id => ({ id, rank: get('SELECT rank r FROM standings WHERE sport_id=? AND team_id=?', sportId, id)?.r ?? 999 })).sort((a, b) => a.rank - b.rank).map(r => r.id)
    }
    const A = rankOf('A组'), B = rankOf('B组')
    if (A.length >= 2 && B.length >= 2) {
      const r1 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '半决赛', A[0], B[1], vid('五人足球场'), 99, '14:00', 'scheduled')
      const r2 = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)', sportId, '半决赛', B[0], A[1], vid('五人足球场'), 100, '14:30', 'scheduled')
      const ids = [Number(r1.lastInsertRowid), Number(r2.lastInsertRowid)]
      ids.forEach(id => addLog('schedule_added', id, null, `${matchTitle(get('SELECT * FROM matches WHERE id=?', id))} 由小组出线排名生成`, null, '系统'))
      autoCrewForNewMatches(ids, '系统')
      return '已按小组排名生成足球半决赛'
    }
    return null
  }
  const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
  const hasFinal = get(`SELECT id FROM matches WHERE sport_id=? AND stage='决赛'`, sportId)
  if (semis.length && semis.every(s => s.status === 'finished' || s.status === 'void') && !hasFinal) {
    if (semis.some(s => s.status === 'finished' && s.winner == null)) return '半决赛存在平分未决胜场次，请先补录加时/点球决胜比分'
    reconcileKnockout(sportId, '淘汰赛按半决赛赛果编排', '系统')
    return '已生成决赛 与 季军战'
  }
  return null
}
function finishTrack(sportId, body) {
  // body: [{athlete_id, mark}]（顺序无关，服务端按成绩重新排名）
  const spo = get('SELECT * FROM sports WHERE id=?', sportId)
  if (!spo) throw new Error('比赛项目不存在')
  if (spo.format !== 'track') throw new Error('仅田径项目可录入计时成绩')
  if (!Array.isArray(body) || !body.length) throw new Error('成绩数据不能为空')

  // 逐条结构校验：运动员 id 必须有效，成绩必须为大于 0 的数字（拒绝空值/NaN/负数/0）
  const rows = []
  const seen = new Set()
  for (const b of body) {
    if (!b || typeof b !== 'object') throw new Error('存在格式无效的成绩记录')
    const athleteId = Number(b.athlete_id)
    if (!Number.isInteger(athleteId) || athleteId <= 0) throw new Error('存在无效的运动员编号')
    if (seen.has(athleteId)) {
      const dup = get('SELECT name FROM athletes WHERE id=?', athleteId)
      throw new Error(`运动员「${dup?.name || athleteId}」的成绩重复提交，请去重后重新结算`)
    }
    seen.add(athleteId)
    const mark = Number(b.mark)
    if (!Number.isFinite(mark) || mark <= 0) throw new Error('成绩必须为大于 0 的有效数字（秒），不能为空')
    rows.push({ athleteId, mark })
  }

  // 有效参赛名单 = 本项目有成绩档案且资格仍为 approved 的运动员
  const entries = all(`SELECT e.id entry_id, e.athlete_id, a.name, a.status
                       FROM entries e JOIN athletes a ON a.id=e.athlete_id
                       WHERE e.sport_id=?`, sportId)
  const byAthlete = new Map(entries.map(e => [e.athlete_id, e]))
  const foreign = rows.find(r => {
    const e = byAthlete.get(r.athleteId)
    return !e || e.status !== 'approved'
  })
  if (foreign) {
    const ath = get('SELECT name FROM athletes WHERE id=?', foreign.athleteId)
    throw new Error(`运动员「${ath?.name || foreign.athleteId}」不在本项目的有效参赛名单中，不能计入成绩`)
  }
  // 缺失校验：有效名单中任何一人未提交成绩，都不允许结算
  const missing = entries.filter(e => e.status === 'approved' && !seen.has(e.athlete_id))
  if (missing.length) {
    throw new Error(`还有 ${missing.length} 名运动员缺少成绩（${missing.map(m => m.name).join('、')}），补齐后才能结算`)
  }

  // 事务写入：任一更新失败整体回滚，绝不允许半结算污染排名与奖牌
  withTransaction(() => {
    // 清理失去资格（退报/撤销）运动员残留的成绩档案
    entries.filter(e => e.status !== 'approved').forEach(e => run('DELETE FROM entries WHERE id=?', e.entry_id))
    rows.sort((a, b) => a.mark - b.mark)
    rows.forEach((r, i) => {
      const unitId = get('SELECT unit_id FROM athletes WHERE id=?', r.athleteId)?.unit_id ?? null
      run('UPDATE entries SET mark=?, rank=?, unit_id=? WHERE athlete_id=? AND sport_id=?',
        r.mark, i + 1, unitId, r.athleteId, sportId)
    })
    run('UPDATE sports SET finished=1 WHERE id=?', sportId)
  })

  recomputeMedals()
}
/* ================= 参赛资格审核（报名 → 审核 → 退报/撤销） ================= */
function submitRegistration(kind, unitId, sportId, name) {
  // 单事务：重名检查与入库原子化，避免并发重复提交产生两条待审记录
  return withTransaction(() => {
    if (!get('SELECT id FROM units WHERE id=?', unitId)) throw new Error('参赛单位不存在')
    if (!get('SELECT id FROM sports WHERE id=?', sportId)) throw new Error('比赛项目不存在')
    name = (name || '').trim()
    if (!name) throw new Error('名称不能为空')
    if (kind === 'team') {
      if (get('SELECT id FROM teams WHERE name=? AND sport_id=? AND unit_id=?', name, sportId, unitId)) throw new Error('该单位已报名同名队伍')
      const r = run('INSERT INTO teams (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId, sportId, 'pending')
      const teamId = Number(r.lastInsertRowid)
      run('INSERT INTO registrations (kind,unit_id,sport_id,team_id,name,status) VALUES (?,?,?,?,?,?)', kind, unitId, sportId, teamId, name, 'pending')
      syncBadge('team', teamId, '系统', false)
      return { id: teamId, kind }
    }
    if (get('SELECT id FROM athletes WHERE name=? AND sport_id=? AND unit_id=?', name, sportId, unitId)) throw new Error('该单位已报名同名运动员')
    const r = run('INSERT INTO athletes (name,unit_id,sport_id,status) VALUES (?,?,?,?)', name, unitId, sportId, 'pending')
    const athId = Number(r.lastInsertRowid)
    run('INSERT INTO registrations (kind,unit_id,sport_id,athlete_id,name,status) VALUES (?,?,?,?,?,?)', kind, unitId, sportId, athId, name, 'pending')
    syncBadge('athlete', athId, '系统', false)
    return { id: athId, kind }
  })
}

function approveRegistration(regId, reviewer) {
  // 整体单事务（BEGIN IMMEDIATE）：名额检查 → 占位 → 资格生效 → 循环赛程重排 → 积分/奖牌重建，
  // 任一环节失败整体回滚，杜绝"名额已占但赛程重排一半"的中间态；写锁前置使并发审核串行化。
  return withTransaction(() => {
    const reg = get('SELECT * FROM registrations WHERE id=?', regId)
    if (!reg) throw new Error('报名记录不存在')
    // 审核幂等：重复提交（双击/重试/并发）直接返回首次审核结果，
    // 不重复占用名额、不重复触发循环赛程重排
    if (reg.status === 'approved') return { ok: true, quota_no: reg.quota_no, idempotent: true }
    if (reg.status !== 'pending') throw new Error('该报名已处理，不能重复审核')
    const quota = get('SELECT quota FROM sports WHERE id=?', reg.sport_id)?.quota ?? 8
    const approved = reg.kind === 'team'
      ? get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, reg.sport_id).c
      : get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, reg.sport_id).c
    if (approved >= quota) {
      const err = new Error(`名额已满（${quota} 个），无法通过`)
      err.code = 'QUOTA_FULL'
      throw err
    }
    const quotaNo = approved + 1
    // 原子状态迁移：并发下仅一个请求能把 pending → approved，其余按幂等成功返回首次结果
    const claim = run(`UPDATE registrations SET status='approved', quota_no=?, reviewed_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='pending'`, quotaNo, reviewer || '组委会', regId)
    if (!claim.changes) {
      const now = get('SELECT status, quota_no FROM registrations WHERE id=?', regId)
      if (now?.status === 'approved') return { ok: true, quota_no: now.quota_no, idempotent: true }
      throw new Error('该报名已处理，不能重复审核')
    }
    if (reg.kind === 'team') {
      run(`UPDATE teams SET status='approved' WHERE id=?`, reg.team_id)
      // 循环赛：若尚未开赛，重新排定循环赛程，把新队伍纳入对阵
      const spo = get('SELECT * FROM sports WHERE id=?', reg.sport_id)
      const finished = get(`SELECT COUNT(*) c FROM matches WHERE sport_id=? AND status='finished'`, reg.sport_id).c
      if (spo.format === 'roundrobin' && finished === 0) {
        // 赛程重排：先释放旧场次在派执法安排并留痕，再重建对阵（与审核同事务，失败一并回滚）
        const old = all(`SELECT * FROM matches WHERE sport_id=?`, reg.sport_id)
        old.forEach(m => releaseAssignmentsOfMatch(m, '报名通过触发循环赛程重排', reviewer || '系统'))
        run(`DELETE FROM matches WHERE sport_id=?`, reg.sport_id)
        const teams = all(`SELECT id FROM teams WHERE sport_id=? AND status='approved' ORDER BY id`, reg.sport_id).map(t => t.id)
        const pairList = arr => { const p = []; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) p.push([arr[i], arr[j]]); return p }
        const scheduleFor = initRoundRobinSchedule(reg.sport_id, old)
        let ono = 0
        const newIds = []
        pairList(teams).forEach(([a, b]) => {
          ono++
          const { venueId, timeLabel } = scheduleFor([a, b], ono)
          const r = run('INSERT INTO matches (sport_id,stage,team_a,team_b,venue_id,order_no,time_label,status) VALUES (?,?,?,?,?,?,?,?)',
            reg.sport_id, '循环', a, b, venueId, ono, timeLabel, 'scheduled')
          newIds.push(Number(r.lastInsertRowid))
        })
        const crewResult = autoCrewForNewMatches(newIds, reviewer || '系统')
        const skipText = crewResult.skipped.length ? `；${crewResult.skipped.length} 个执法席位待排班` : ''
        addLog('schedule_rebuild', null, null,
          `${spo.name} 循环赛程因新增通过队伍「${reg.name}」重排，共 ${newIds.length} 场；时间、场地已初始化，整场协同排班补齐 ${crewResult.assigned.length} 个执法席位（主裁/助理/记录台）${skipText}`,
          null, reviewer || '系统')
      }
    } else {
      run(`UPDATE athletes SET status='approved' WHERE id=?`, reg.athlete_id)
      // 田径：审核通过即建立成绩档案（成绩留空待录），否则该运动员无法参与成绩录入与结算
      const spo = get('SELECT * FROM sports WHERE id=?', reg.sport_id)
      if (spo.format === 'track') {
        const exists = get('SELECT id FROM entries WHERE sport_id=? AND athlete_id=?', reg.sport_id, reg.athlete_id)
        if (!exists) {
          run('INSERT INTO entries (sport_id,athlete_id,mark,rank,unit_id) VALUES (?,?,NULL,NULL,?)',
            reg.sport_id, reg.athlete_id, reg.unit_id)
        }
      }
    }
    rebuildStandings(reg.sport_id)
    recomputeMedals()
    // 资格生效 → 发放/激活赛事证件并按赛程同步动态授权区域
    syncBadge(reg.kind, reg.kind === 'team' ? reg.team_id : reg.athlete_id, reviewer || '系统', true)
    return { ok: true, quota_no: quotaNo }
  })
}

function rejectRegistration(regId, note, reviewer) {
  return withTransaction(() => {
    const reg = get('SELECT * FROM registrations WHERE id=?', regId)
    if (!reg) throw new Error('报名记录不存在')
    // 审核幂等：重复驳回直接返回成功，不产生二次副作用
    if (reg.status === 'rejected') return { ok: true, idempotent: true }
    if (reg.status !== 'pending') throw new Error('该报名已处理')
    const claim = run(`UPDATE registrations SET status='rejected', review_note=?, reviewed_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='pending'`, note || '资料不符', reviewer || '组委会', regId)
    if (!claim.changes) return { ok: true, idempotent: true }   // 并发下已被其它请求处理
    if (reg.kind === 'team') run(`UPDATE teams SET status='rejected' WHERE id=? AND status='pending'`, reg.team_id)
    else run(`UPDATE athletes SET status='rejected' WHERE id=? AND status='pending'`, reg.athlete_id)
    // 证件联动：资格驳回 → 证件保持停用（待资格通过后再激活）
    syncBadge(reg.kind, reg.kind === 'team' ? reg.team_id : reg.athlete_id, reviewer || '系统', false)
    return { ok: true }
  })
}

// 退报（单位主动）/ 撤销资格（组委会）：同步处理受影响的对阵及成绩
// 整体单事务：资格变更 + 弃权/取消成绩 + 淘汰赛递补级联 + 积分/奖牌重算，任一失败整体回滚
function withdrawOrRevoke(regId, action, note, reviewer) {
  return withTransaction(() => {
    const reg = get('SELECT * FROM registrations WHERE id=?', regId)
    if (!reg) throw new Error('报名记录不存在')
    const newStatus = action === 'withdraw' ? 'withdrawn' : 'revoked'
    const emptyImpact = { voided: 0, walkover: 0, entries: 0, replacements: 0, cascade: 0 }
    // 幂等：已处于目标状态（重复提交/重试）直接返回成功，不重复级联
    if (reg.status === newStatus) return { ok: true, idempotent: true, impact: emptyImpact }
    if (reg.status !== 'approved') throw new Error('仅已通过的报名可退报/撤销')
    const reason = note || (action === 'withdraw' ? '单位退报' : '组委会撤销资格')
    // 原子状态迁移：并发下仅一个请求生效
    const claim = run(`UPDATE registrations SET status=?, review_note=?, reviewed_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='approved'`, newStatus, reason, reviewer || '组委会', regId)
    if (!claim.changes) {
      const now = get('SELECT status FROM registrations WHERE id=?', regId)
      if (now?.status === newStatus) return { ok: true, idempotent: true, impact: emptyImpact }
      throw new Error('仅已通过的报名可退报/撤销')
    }
    const impact = { ...emptyImpact }
    if (reg.kind === 'team') {
      run(`UPDATE teams SET status=? WHERE id=?`, newStatus, reg.team_id)
      const teamId = reg.team_id
      const spo = get('SELECT * FROM sports WHERE id=?', reg.sport_id)
      const walkoverNote = action === 'withdraw' ? '弃权(退报)' : '弃权(撤销资格)'
      const voidNote = action === 'withdraw' ? '成绩取消(退报)' : '成绩取消(撤销资格)'
      const replaceNote = action === 'withdraw' ? '退报递补调整' : '撤销资格递补调整'
      const operator = reviewer || '系统'
      const matchesOfTeam = () => all(`SELECT * FROM matches WHERE sport_id=? AND (team_a=? OR team_b=?)`, reg.sport_id, teamId, teamId)

      if (spo.format === 'roundrobin') {
        matchesOfTeam().forEach(m => {
          if (m.status === 'scheduled') {
            const opponent = m.team_a === teamId ? m.team_b : m.team_a
            if (isActiveTeam(opponent)) {
              impact.walkover += finishWalkover(m, opponent, walkoverNote, operator) ? 1 : 0
            } else {
              voidMatch(m, voidNote, operator)
              impact.voided++
            }
          } else if (m.status === 'finished') {
            voidMatch(m, voidNote, operator)
            impact.voided++
          }
        })
        rebuildStandings(reg.sport_id)
      } else {
        const processMatch = m => {
          if (m.status === 'scheduled') {
            const opponent = m.team_a === teamId ? m.team_b : m.team_a
            if (isActiveTeam(opponent)) {
              impact.walkover += finishWalkover(m, opponent, walkoverNote, operator) ? 1 : 0
            } else {
              voidMatch(m, voidNote, operator)
              impact.voided++
            }
          } else if (m.status === 'finished') {
            voidMatch(m, voidNote, operator)
            impact.voided++
          }
        }

        // 先处理已有小组成绩并刷新积分榜；半决赛递补必须基于取消成绩后的真实排名
        matchesOfTeam().filter(m => m.group_name).forEach(processMatch)
        rebuildStandings(reg.sport_id)

        // 足球小组+淘汰：若半决赛尚未进行，先按同组积分榜顺位递补，避免后续轮次沿用失去资格的名额
        const existingSemis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, reg.sport_id)
        const sourceSemi = existingSemis.find(m => (m.team_a === teamId || m.team_b === teamId) && m.status === 'scheduled')
        if (spo.format === 'group_knockout' && sourceSemi) {
          const occupied = existingSemis.flatMap(m => [m.team_a, m.team_b]).filter(id => id != null && id !== teamId)
          const groupName = get(`SELECT group_name FROM matches WHERE sport_id=? AND (team_a=? OR team_b=?) AND group_name IS NOT NULL LIMIT 1`, reg.sport_id, teamId, teamId)?.group_name
          const substitute = groupAlternateFor(reg.sport_id, groupName, occupied)
          if (substitute != null) {
            replaceScheduledKnockoutTeam(sourceSemi, teamId, substitute, replaceNote, operator)
            impact.replacements++
          }
        }

        // 直接处理来源半决赛；已生成的决赛、季军战交给统一级联逻辑改赛、重赛或轮空，避免提前按旧对阵判弃权
        matchesOfTeam()
          .filter(m => !m.group_name && m.stage === '半决赛')
          .forEach(processMatch)

        // 统一同步决赛/季军战、轮空结算、执法安排和奖牌
        rebuildStandings(reg.sport_id)
        if (existingSemis.length) {
          const r = reconcileKnockout(reg.sport_id, `${reason}触发淘汰赛级联调整`, operator)
          impact.cascade = r.created + r.adjusted
        }
      }
    } else {
      run(`UPDATE athletes SET status=? WHERE id=?`, newStatus, reg.athlete_id)
      // 田径：删除该运动员在该项目的成绩
      const r = run(`DELETE FROM entries WHERE athlete_id=? AND sport_id=?`, reg.athlete_id, reg.sport_id)
      impact.entries = r.changes
      recomputeTrackRanks(reg.sport_id)
    }
    recomputeMedals()
    // 证件联动：退报/撤销资格 → 赛事证件立即停用，原授权区域收回（入场核验将拒绝）
    syncBadge(reg.kind, reg.kind === 'team' ? reg.team_id : reg.athlete_id, reviewer || '系统', true)
    return { ok: true, impact }
  })
}

function recomputeTrackRanks(sportId) {
  // 空成绩（未录入）不参与排名，避免 NULL 在升序中排到首位而被奖牌统计取中
  const rows = all(`SELECT id FROM entries WHERE sport_id=? AND mark IS NOT NULL ORDER BY mark ASC`, sportId)
  rows.forEach((r, i) => run(`UPDATE entries SET rank=? WHERE id=?`, i + 1, r.id))
  run(`UPDATE entries SET rank=NULL WHERE sport_id=? AND mark IS NULL`, sportId)
}

/* ================= 赛事申诉复核 ================= */
// 申诉单工作流：pending(待受理) → reviewing(复核中) → upheld(改判) / rejected(驳回)；
// pending/reviewing 可由申诉单位撤案(withdrawn)。全部状态迁移与改判级联包裹在单事务中，幂等可重放。
const APPEAL_OPEN = new Set(['pending', 'reviewing'])
function nextAppealCode() {
  // 申诉单永久保留，按总数顺序编号即可；BEGIN IMMEDIATE 写锁保证并发不重号
  const n = get('SELECT COUNT(*) c FROM appeals').c + 1
  return 'SS-' + String(n).padStart(4, '0')
}
function addAppealLog(appealId, action, detail, snapshot, operator = '组委会') {
  run(`INSERT INTO appeal_logs (appeal_id,action,detail,snapshot,operator) VALUES (?,?,?,?,?)`,
    appealId, action, detail ?? null, snapshot ? JSON.stringify(snapshot) : null, operator)
}
// 奖牌 / 积分快照：改判前后各取一份，差异写入审计，回答"谁的奖牌积分发生了什么变化"
function medalSnapshot() {
  return Object.fromEntries(all('SELECT unit_id, gold, silver, bronze FROM medals')
    .map(r => [r.unit_id, { gold: r.gold, silver: r.silver, bronze: r.bronze }]))
}
function standingsSnapshot(sportId) {
  return Object.fromEntries(all('SELECT team_id, points, rank FROM standings WHERE sport_id=?', sportId)
    .map(r => [r.team_id, { points: r.points, rank: r.rank }]))
}
function diffMedalMap(before, after) {
  const out = []
  new Set([...Object.keys(before), ...Object.keys(after)]).forEach(k => {
    const b = before[k] || { gold: 0, silver: 0, bronze: 0 }
    const a = after[k] || { gold: 0, silver: 0, bronze: 0 }
    if (a.gold !== b.gold || a.silver !== b.silver || a.bronze !== b.bronze) {
      out.push({ unit_id: Number(k), gold: a.gold - b.gold, silver: a.silver - b.silver, bronze: a.bronze - b.bronze })
    }
  })
  return out
}
function diffStandingsMap(sportId, before) {
  const after = standingsSnapshot(sportId)
  const out = []
  new Set([...Object.keys(before), ...Object.keys(after)]).forEach(k => {
    const b = before[k] || { points: 0, rank: 0 }
    const a = after[k] || { points: 0, rank: 0 }
    if (a.points !== b.points || a.rank !== b.rank) {
      out.push({ team_id: Number(k), name: get('SELECT name FROM teams WHERE id=?', Number(k))?.name || '',
        points_from: b.points, points_to: a.points, rank_from: b.rank, rank_to: a.rank })
    }
  })
  return out
}
const scoreText = (sa, sb, ta, tb) => `${sa}:${sb}` + (ta != null ? `（决胜 ${ta}:${tb}）` : '')

// 已完赛场次因申诉回退重赛：清比分/胜方回到待赛；执法名单作为原班人马保留（void 场次需重新排班）
function resetMatchForReplay(m, teamA, teamB, note, operator) {
  const wasVoid = m.status === 'void'
  run(`UPDATE matches SET status='scheduled', team_a=?, team_b=?, score_a=NULL, score_b=NULL,
      tb_a=NULL, tb_b=NULL, winner=NULL, note=?,
      checkin_a_at=NULL, checkin_b_at=NULL, checkin_crew=0, checkin_crew_total=0, admission_denied=0 WHERE id=?`, teamA, teamB, note, m.id)
  const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
  if (wasVoid) addLog('match_change', m.id, null, `${matchTitle(fresh)} 因申诉改判恢复待赛并替换对阵，重新联动排班`, note, operator)
  else addLog('match_change', m.id, null, `${matchTitle(fresh)} 因申诉改判回退待赛重赛，原执法名单保留`, note, operator)
  return fresh
}
// 决赛/季军战按改判后的半决赛赛果同步：对阵变化或已完赛需重赛 → 回退待赛；不变则保留
function syncPlacementForReplay(sportId, stage, teams, orderNo, timeLabel, note, operator) {
  const m = get(`SELECT * FROM matches WHERE sport_id=? AND stage=?`, sportId, stage)
  const [a, b] = teams.length === 2 ? teams : [null, null]
  if (!a || !b) {
    if (m && m.status !== 'void') { voidMatch(m, note, operator); return { resetted: true, match: m } }
    return { resetted: false, match: m }
  }
  if (!m) {
    const id = createPlacementMatch(sportId, stage, a, b, orderNo, timeLabel, 'scheduled', null, null)
    const fresh = get('SELECT * FROM matches WHERE id=?', id)
    addLog('schedule_added', id, null, `${matchTitle(fresh)} 因申诉改判级联生成`, note, operator)
    autoCrewForNewMatches([id], operator)
    return { resetted: true, match: fresh }
  }
  if (m.status === 'scheduled' && m.team_a === a && m.team_b === b) return { resetted: false, match: m }
  const wasVoid = m.status === 'void'
  const fresh = resetMatchForReplay(m, a, b, note, operator)
  if (wasVoid) autoCrewForNewMatches([m.id], operator)
  return { resetted: true, match: fresh }
}

// 小组赛改判后按全新积分排名重排半决赛：
// 待赛半决赛直接替换队伍（执法名单继续有效）；已赛/已取消半决赛回退待赛重赛；随后决赛/季军作废待重赛编排
function reseatSemisFromGroups(sportId, note, operator) {
  const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
  const replays = []
  if (!semis.length) return { reseated: 0, replays, cascade: 0 }
  const rankIds = g => {
    const ids = all(`SELECT DISTINCT team_a id FROM matches WHERE sport_id=? AND group_name=? AND team_a IS NOT NULL
                     UNION SELECT DISTINCT team_b FROM matches WHERE sport_id=? AND group_name=? AND team_b IS NOT NULL`,
      sportId, g, sportId, g).map(r => r.id).filter(id => get('SELECT status FROM teams WHERE id=?', id)?.status === 'approved')
    return ids.map(id => ({ id, rank: get('SELECT rank r FROM standings WHERE sport_id=? AND team_id=?', sportId, id)?.r ?? 999 }))
      .sort((x, y) => x.rank - y.rank).map(r => r.id)
  }
  const A = rankIds('A组'), B = rankIds('B组')
  if (A.length < 2 || B.length < 2) throw new Error('小组改判后有效出线队伍不足 2 支，无法重新编排半决赛')
  const desired = [[A[0], B[1]], [B[0], A[1]]]
  const needCrew = []
  semis.forEach((m, i) => {
    const [da, db] = desired[i]
    if (m.status !== 'void' && m.team_a === da && m.team_b === db) return
    const wasVoid = m.status === 'void'
    const fresh = resetMatchForReplay(m, da, db, note, operator)
    replays.push({ match_id: m.id, stage: '半决赛', title: matchTitle(fresh) })
    if (wasVoid) needCrew.push(m.id)
  })
  let cascade = 0
  if (replays.length) {
    if (needCrew.length) autoCrewForNewMatches(needCrew, operator)
    // 半决赛不再全部 settled → reconcileKnockout 统一作废决赛/季军（解除在派裁判并留痕）
    const r = reconcileKnockout(sportId, note, operator)
    cascade = r.created + r.adjusted
  }
  return { reseated: replays.length, replays, cascade }
}

// 半决赛改判后：以新的胜/负方同步决赛与季军战（变化的回退待赛重赛）
function reconcilePlacementForReplay(sportId, note, operator) {
  const semis = all(`SELECT * FROM matches WHERE sport_id=? AND stage='半决赛' ORDER BY order_no,id`, sportId)
  if (semis.length !== 2) return { replays: [], cascade: 0 }
  const finalists = semis.map(canonicalSemiWinner)
  const losers = semis.map(canonicalSemiLoser)
  if (finalists.some(x => x == null)) throw new Error('改判后存在无有效胜方的半决赛，无法同步决赛对阵')
  const replays = []
  const f = syncPlacementForReplay(sportId, '决赛', finalists, 101, '16:00', note, operator)
  if (f.resetted && f.match) replays.push({ match_id: f.match.id, stage: '决赛', title: matchTitle(f.match) })
  const t = syncPlacementForReplay(sportId, '季军', losers.every(x => x != null) ? losers : [], 102, '15:30', note, operator)
  if (t.resetted && t.match) replays.push({ match_id: t.match.id, stage: '季军', title: matchTitle(t.match) })
  return { replays, cascade: replays.length }
}

function submitAppeal(body) {
  return withTransaction(() => {
    const targetType = body.target_type
    if (!['match', 'track', 'eligibility'].includes(targetType)) throw new Error('申诉对象类型无效')
    const unitId = Number(body.unit_id)
    if (!get('SELECT id FROM units WHERE id=?', unitId)) throw new Error('申诉单位不存在')
    const reason = (body.reason || '').trim()
    if (!reason) throw new Error('请填写申诉理由')
    const targetId = Number(body.target_id)
    if (!Number.isInteger(targetId) || targetId <= 0) throw new Error('请选择申诉对象')

    // 解析并校验申诉对象，确定归属项目
    let sportId = null, targetDesc = ''
    if (targetType === 'match') {
      const m = get('SELECT * FROM matches WHERE id=?', targetId)
      if (!m) throw new Error('被申诉场次不存在')
      if (m.status === 'void') throw new Error('该场次成绩已取消，不能申诉')
      if (m.status !== 'finished') throw new Error('该场次尚未完赛，暂不能申诉')
      const ua = m.team_a ? get('SELECT unit_id FROM teams WHERE id=?', m.team_a)?.unit_id : null
      const ub = m.team_b ? get('SELECT unit_id FROM teams WHERE id=?', m.team_b)?.unit_id : null
      if (unitId !== ua && unitId !== ub) throw new Error('仅对阵参赛单位可对该场比分申诉')
      sportId = m.sport_id
      targetDesc = matchTitle(m)
    } else if (targetType === 'track') {
      const e = get(`SELECT e.*, a.name aname FROM entries e JOIN athletes a ON a.id=e.athlete_id WHERE e.id=?`, targetId)
      if (!e) throw new Error('被申诉成绩不存在')
      if (e.mark == null) throw new Error('该成绩尚未录入，暂不能申诉')
      sportId = e.sport_id
      targetDesc = `${get('SELECT name FROM sports WHERE id=?', sportId).name} · ${e.aname} ${e.mark}s（第 ${e.rank} 名）`
    } else {
      const reg = get('SELECT * FROM registrations WHERE id=?', targetId)
      if (!reg) throw new Error('被申诉报名记录不存在')
      if (reg.status !== 'approved') throw new Error('仅已通过资格审核的对象可被资格申诉')
      if (reg.unit_id === unitId) throw new Error('不能对本单位自身资格提起申诉（如需退出请走退报流程）')
      sportId = reg.sport_id
      targetDesc = `${reg.kind === 'team' ? '队伍' : '运动员'}「${reg.name}」的参赛资格（${get('SELECT name FROM units WHERE id=?', reg.unit_id)?.name}）`
    }

    // 同单位同一对象存在未结案申诉时拒绝，避免重复立案
    const dup = get(`SELECT id FROM appeals WHERE target_type=? AND target_id=? AND unit_id=? AND status IN ('pending','reviewing')`,
      targetType, targetId, unitId)
    if (dup) throw new Error('该单位已就该对象提交申诉且正在处理中，请勿重复提交')

    const code = nextAppealCode()
    const r = run(`INSERT INTO appeals (code,target_type,target_id,unit_id,sport_id,reason,contact,evidence,status)
                   VALUES (?,?,?,?,?,?,?,?, 'pending')`,
      code, targetType, targetId, unitId, sportId, reason, (body.contact || '').trim() || null, (body.evidence || '').trim() || null)
    const id = Number(r.lastInsertRowid)
    const unitName = get('SELECT name FROM units WHERE id=?', unitId).name
    addAppealLog(id, 'submit', `${unitName} 对 ${targetDesc} 提交异议：${reason}`, null, unitName)
    return { ok: true, id, code }
  })
}

function acceptAppeal(appealId, reviewer = '组委会') {
  return withTransaction(() => {
    const a = get('SELECT * FROM appeals WHERE id=?', appealId)
    if (!a) throw new Error('申诉单不存在')
    if (a.status === 'reviewing') return { ok: true, idempotent: true }
    if (a.status !== 'pending') throw new Error('该申诉已结案，不能再受理')
    const claim = run(`UPDATE appeals SET status='reviewing', accepted_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='pending'`, reviewer, appealId)
    if (!claim.changes) return { ok: true, idempotent: true }
    addAppealLog(appealId, 'accept', `${reviewer} 受理申诉 ${a.code}，进入复核`, null, reviewer)
    return { ok: true }
  })
}

function closeAppeal(appealId, action, note, operator) {
  return withTransaction(() => {
    const a = get('SELECT * FROM appeals WHERE id=?', appealId)
    if (!a) throw new Error('申诉单不存在')
    const targetStatus = action === 'reject' ? 'rejected' : 'withdrawn'
    if (a.status === targetStatus) return { ok: true, idempotent: true }
    if (!APPEAL_OPEN.has(a.status)) throw new Error('该申诉已结案，不能重复处理')
    if (action === 'reject' && !(note || '').trim()) throw new Error('驳回申诉必须填写复核意见')
    const claim = run(`UPDATE appeals SET status=?, review_note=?, reviewed_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status IN ('pending','reviewing')`,
      targetStatus, (note || '').trim() || null, operator || '申诉单位', appealId)
    if (!claim.changes) return { ok: true, idempotent: true }
    if (action === 'reject') {
      addAppealLog(appealId, 'reject', `${operator} 驳回申诉 ${a.code}：${(note || '').trim()}`, null, operator)
    } else {
      const unitName = get('SELECT name FROM units WHERE id=?', a.unit_id)?.name || '申诉单位'
      addAppealLog(appealId, 'withdraw', `${unitName} 撤回申诉 ${a.code}${note ? '：' + String(note).trim() : ''}`, null, unitName)
    }
    return { ok: true }
  })
}

// 复核改判：回写比分/成绩或撤销资格，原子联动积分榜、淘汰赛递补重赛与奖牌榜
function upholdAppeal(appealId, body) {
  return withTransaction(() => {
    const a = get('SELECT * FROM appeals WHERE id=?', appealId)
    if (!a) throw new Error('申诉单不存在')
    if (a.status === 'upheld') return { ok: true, idempotent: true, impact: safeParseJson(a.impact) }
    if (a.status !== 'reviewing') throw new Error('需先受理申诉进入复核，才能作出改判')
    const reviewer = (body.reviewer || '组委会').trim() || '组委会'
    const note = (body.note || '').trim()
    if (!note) throw new Error('复核改判必须填写复核意见')

    const beforeMedals = medalSnapshot()
    const beforeStandings = a.sport_id ? standingsSnapshot(a.sport_id) : {}
    const impact = { resolution: null, corrected: [], replays: [], cascade: 0 }
    let scoreSnap = null

    if (a.target_type === 'match') {
      const m = get('SELECT * FROM matches WHERE id=?', a.target_id)
      if (!m) throw new Error('被申诉场次不存在')
      if (m.status !== 'finished') throw new Error('该场次当前不是已完赛状态，无法回写比分')
      if (!m.team_a || !m.team_b || !isActiveTeam(m.team_a) || !isActiveTeam(m.team_b)) {
        throw new Error('对阵中存在失去资格队伍，请改走资格类申诉处理')
      }
      const sa = Number(body.score_a), sb = Number(body.score_b)
      if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0) throw new Error('改判比分必须为非负整数')
      let winner = null, ta = null, tb = null
      if (sa > sb) winner = m.team_a
      else if (sb > sa) winner = m.team_b
      else if (KO_STAGES.includes(m.stage)) {
        ta = body.tb_a === '' || body.tb_a == null ? null : Number(body.tb_a)
        tb = body.tb_b === '' || body.tb_b == null ? null : Number(body.tb_b)
        if (!Number.isInteger(ta) || !Number.isInteger(tb) || ta < 0 || tb < 0) throw new Error('淘汰赛平分改判需录入加时/点球决胜比分')
        if (ta === tb) throw new Error('决胜比分不能再次持平')
        winner = ta > tb ? m.team_a : m.team_b
      }
      if (sa === m.score_a && sb === m.score_b && ta === (m.tb_a ?? null) && tb === (m.tb_b ?? null)) {
        throw new Error('回写比分与原比分一致，无需改判')
      }
      scoreSnap = {
        match_id: m.id, from: { score_a: m.score_a, score_b: m.score_b, tb_a: m.tb_a, tb_b: m.tb_b },
        to: { score_a: sa, score_b: sb, tb_a: ta, tb_b: tb }
      }
      const changeNote = `申诉改判(${a.code})`
      run(`UPDATE matches SET score_a=?, score_b=?, tb_a=?, tb_b=?, winner=?, note=? WHERE id=?`, sa, sb, ta, tb, winner, changeNote, m.id)
      const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
      addLog('match_change', m.id, null,
        `${matchTitle(fresh)} 申诉改判：${scoreText(m.score_a, m.score_b, m.tb_a, m.tb_b)} → ${scoreText(sa, sb, ta, tb)}`,
        `${a.code} ${note}`, reviewer)
      impact.corrected.push({ match_id: m.id, stage: m.stage, group_name: m.group_name,
        from: scoreText(m.score_a, m.score_b, m.tb_a, m.tb_b), to: scoreText(sa, sb, ta, tb) })

      const spo = get('SELECT * FROM sports WHERE id=?', m.sport_id)
      if (spo.format === 'roundrobin' || m.stage === '循环') {
        rebuildStandings(m.sport_id)
      } else if (m.group_name) {
        // 小组赛改判：先重建小组积分，再按新排名重置半决赛、作废后续轮次
        rebuildStandings(m.sport_id)
        const r = reseatSemisFromGroups(m.sport_id, `${changeNote}：小组改判后按新排名递补`, reviewer)
        impact.replays = r.replays
        impact.replacements = r.reseated
        impact.cascade = r.cascade
      } else if (m.stage === '半决赛') {
        // 半决赛改判：按新胜/负方同步决赛与季军战，变化的回退待赛重赛
        const r = reconcilePlacementForReplay(m.sport_id, `${changeNote}：半决赛改判后重新确定对阵`, reviewer)
        impact.replays = r.replays
        impact.cascade = r.cascade
      }
      impact.resolution = 'score_corrected'
    } else if (a.target_type === 'track') {
      const e = get(`SELECT * FROM entries WHERE id=?`, a.target_id)
      if (!e) throw new Error('被申诉成绩不存在')
      const ath = get('SELECT * FROM athletes WHERE id=?', e.athlete_id)
      if (ath.status !== 'approved') throw new Error('该运动员已失去资格，请改走资格类申诉处理')
      const mark = Number(body.mark)
      if (!Number.isFinite(mark) || mark <= 0) throw new Error('改判成绩必须为大于 0 的有效数字（秒）')
      if (e.mark != null && Math.abs(e.mark - mark) < 1e-9) throw new Error('回写成绩与原成绩一致，无需改判')
      scoreSnap = { entry_id: e.id, athlete: ath.name, from: { mark: e.mark, rank: e.rank }, to: { mark } }
      run('UPDATE entries SET mark=? WHERE id=?', mark, e.id)
      recomputeTrackRanks(e.sport_id)
      impact.corrected.push({ entry_id: e.id, athlete: ath.name, from: `${e.mark}s（第${e.rank}名）`, to: `${mark}s` })
      impact.resolution = 'track_corrected'
    } else {
      const reg = get('SELECT * FROM registrations WHERE id=?', a.target_id)
      if (!reg) throw new Error('被申诉报名记录不存在')
      if (reg.status !== 'approved') throw new Error('该对象当前不具备有效资格，无需撤销')
      const revokeNote = `申诉撤销资格(${a.code})：${note}`
      // 复用资格撤销级联（嵌套并入本事务）：弃权/取消成绩/淘汰赛递补/田径成绩删除
      const r = withdrawOrRevoke(reg.id, 'revoke', revokeNote, reviewer)
      Object.assign(impact, r.impact)
      impact.corrected.push({ registration_id: reg.id, name: reg.name, kind: reg.kind })
      impact.resolution = 'revoked'
    }

    recomputeMedals()
    const medalChanges = diffMedalMap(beforeMedals, medalSnapshot())
    const standingsChanges = a.sport_id ? diffStandingsMap(a.sport_id, beforeStandings) : []
    impact.medal_changes = medalChanges
    impact.standings_changes = standingsChanges

    const claim = run(`UPDATE appeals SET status='upheld', reviewed_at=datetime('now','localtime'), reviewer=?,
                       review_note=?, resolution=?, impact=? WHERE id=? AND status='reviewing'`,
      reviewer, note, impact.resolution, JSON.stringify(impact), appealId)
    if (!claim.changes) {
      const now = get('SELECT status, impact FROM appeals WHERE id=?', appealId)
      if (now?.status === 'upheld') return { ok: true, idempotent: true, impact: safeParseJson(now.impact) }
      throw new Error('该申诉已被其它请求处理')
    }
    const detailParts = [`${reviewer} 复核改判 ${a.code}`]
    impact.corrected.forEach(c => detailParts.push(c.from && c.to ? `回写 ${c.from} → ${c.to}` : `撤销「${c.name}」资格`))
    if (impact.replays?.length) detailParts.push(`回退重赛/递补 ${impact.replays.length} 场`)
    if (medalChanges.length) detailParts.push(`奖牌变动 ${medalChanges.length} 个单位`)
    addAppealLog(appealId, 'uphold', detailParts.join('；'), { score: scoreSnap, impact }, reviewer)
    return { ok: true, impact }
  })
}
function safeParseJson(s) { try { return s ? JSON.parse(s) : null } catch { return null } }

/* ================= 历史赛程统计修复 ================= */
// 校正并发审核/重排在历史数据中遗留的失真，让积分榜与奖牌榜回到权威赛果口径：
// 1) 循环赛重复对阵场次去重（并发重排可能重复插场）：保留最早有效场，多余场解除执法并作废留痕
// 2) 已通过报名的名额序号按审核时间重排，消除并发占号造成的重号/跳号
// 3) 清理失去资格运动员残留的成绩档案并重排田径名次
// 4) 积分榜按已完赛历史全量重建；5) 奖牌榜按权威赛果全量重算
// 幂等：健康库上执行为无操作；超额项目只报告不自动处置（取消资格属业务决策）
function repairHistoricalStats(operator = '系统') {
  return withTransaction(() => {
    const report = { duplicate_matches: 0, quota_no_fixed: 0, entries_cleaned: 0, standings_rebuilt: 0, over_quota: [] }

    // 1) 循环赛重复对阵去重（同项目同一对阵只允许存在一场有效场次）
    all(`SELECT id FROM sports WHERE format='roundrobin'`).forEach(spo => {
      const rows = all(`SELECT * FROM matches WHERE sport_id=? AND status<>'void'
                        AND team_a IS NOT NULL AND team_b IS NOT NULL ORDER BY id`, spo.id)
      const seen = new Set()
      rows.forEach(m => {
        const key = `${Math.min(m.team_a, m.team_b)}-${Math.max(m.team_a, m.team_b)}`
        if (!seen.has(key)) { seen.add(key); return }
        releaseAssignmentsOfMatch(m, '历史修复：并发重排产生的重复场次作废', operator)
        run(`UPDATE matches SET status='void', note=? WHERE id=?`, '历史修复：并发重排产生的重复场次', m.id)
        addLog('match_change', m.id, null, `${matchTitle(m)} 历史修复：并发重排产生的重复场次作废`, null, operator)
        report.duplicate_matches++
      })
    })

    // 2) 名额序号重排（按审核时间/提交顺序连续编号）
    all(`SELECT DISTINCT sport_id, kind FROM registrations WHERE status='approved'`).forEach(({ sport_id, kind }) => {
      const rows = all(`SELECT id, quota_no FROM registrations WHERE sport_id=? AND kind=? AND status='approved'
                        ORDER BY reviewed_at, id`, sport_id, kind)
      rows.forEach((r, i) => {
        if (r.quota_no !== i + 1) { run('UPDATE registrations SET quota_no=? WHERE id=?', i + 1, r.id); report.quota_no_fixed++ }
      })
    })

    // 3) 失格运动员残留成绩档案清理 + 田径名次重排
    report.entries_cleaned = run(`DELETE FROM entries WHERE athlete_id IN (SELECT id FROM athletes WHERE status<>'approved')`).changes
    all(`SELECT id FROM sports WHERE format='track'`).forEach(s => recomputeTrackRanks(s.id))

    // 4)+5) 积分榜/奖牌榜全量重建（均以完赛场次与有效资格为唯一口径）
    rebuildStandings()
    recomputeMedals()
    report.standings_rebuilt = all('SELECT id FROM sports').length

    // 超额项目告警：历史并发放行造成的超额只报告，不自动取消资格
    all('SELECT id, name, format, quota FROM sports').forEach(s => {
      const quota = s.quota ?? 8
      const used = s.format === 'track'
        ? get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, s.id).c
        : get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, s.id).c
      if (used > quota) report.over_quota.push({ sport_id: s.id, name: s.name, quota, approved: used })
    })
    return report
  })
}

/* ================= 赛事安全事件处置 ================= */
// 医疗 / 安保 / 裁判 / 组委会 协同：上报 → 分级派单 → 联动处置（证件暂扣 / 场次暂停·改期）→ 处置完成 → 结案
const INCIDENT_CATEGORY = {
  injury: '伤病急救', security: '治安事件', dispute: '冲突纠纷',
  facility: '场地器材', weather: '天气突发', other: '其他'
}
const INCIDENT_ROLE = { medical: '医疗', security: '安保', referee: '裁判', organizer: '组委会' }
const INCIDENT_SEVERITY = { major: '重大', general: '较大', minor: '一般' }
const INCIDENT_STATUS = { pending: '待分级', handling: '处置中', resolved: '待结案', closed: '已结案' }
const INCIDENT_OPEN = new Set(['pending', 'handling', 'resolved'])
const INCIDENT_ACTIONS = {
  submit: '上报事件', triage: '分级派单', progress: '协同进展',
  badge_block: '暂扣证件', badge_release: '解除暂扣',
  match_pause: '暂停场次', match_resume: '恢复场次', match_reschedule: '场次改期',
  resolve: '处置完成', reopen: '重新处置', close: '结案归档'
}
function nextIncidentCode() {
  const n = get('SELECT COUNT(*) c FROM incidents').c + 1
  return 'SI-' + String(n).padStart(4, '0')
}
function addIncidentLog(incidentId, action, detail, { role = null, badgeId = null, matchId = null, operator = '系统' } = {}) {
  run(`INSERT INTO incident_logs (incident_id,action,role,detail,badge_id,match_id,operator)
       VALUES (?,?,?,?,?,?,?)`, incidentId, action, role, detail ?? null, badgeId ?? null, matchId ?? null, operator || '系统')
}
// 重新汇总当前事件的联动快照（关联暂扣 + 暂停/改期场次），持久化到 incidents.impact
function buildIncidentImpact(incidentId) {
  const badges = all(`SELECT ib.*, b.code badge_code, b.name badge_name, b.subject_type
                     FROM incident_badges ib JOIN badges b ON b.id=ib.badge_id
                     WHERE ib.incident_id=?`, incidentId)
  const pausedRows = all(`SELECT * FROM matches WHERE pause_incident_id=? AND is_paused=1`, incidentId)
  const rescheduledRows = all(`SELECT * FROM matches WHERE reschedule_incident_code=(SELECT code FROM incidents WHERE id=?)
                               AND reschedule_incident_code IS NOT NULL`, incidentId)
  const resumedRows = all(`SELECT * FROM matches WHERE resume_incident_id=? AND is_paused=0 AND pause_incident_id=?
                           AND reschedule_incident_code IS NULL`, incidentId, incidentId)
  return {
    badges_blocked: badges.filter(b => b.status === 'active').length,
    badges_released: badges.filter(b => b.status === 'released').length,
    badges: badges.map(b => ({ link_id: b.id, badge_id: b.badge_id, code: b.badge_code, name: b.badge_name, subject_type: b.subject_type, status: b.status, reason: b.reason, released_reason: b.released_reason, released_at: b.released_at })),
    matches_paused: pausedRows.length,
    matches_resumed: resumedRows.length,
    matches_rescheduled: rescheduledRows.length,
    paused_matches: pausedRows.map(m => ({ match_id: m.id, title: matchTitle(m), time_label: m.time_label, venue: m.venue_id ? get('SELECT name FROM venues WHERE id=?', m.venue_id)?.name : null })),
    rescheduled_matches: rescheduledRows.map(m => ({ match_id: m.id, title: matchTitle(m), from_time: m.orig_time_label, to_time: m.time_label, venue: m.venue_id ? get('SELECT name FROM venues WHERE id=?', m.venue_id)?.name : null }))
  }
}
function persistIncidentImpact(incidentId) {
  run(`UPDATE incidents SET impact=? WHERE id=?`, JSON.stringify(buildIncidentImpact(incidentId)), incidentId)
}
function incidentOpen(id, allow = null) {
  const inc = get('SELECT * FROM incidents WHERE id=?', id)
  if (!inc) throw new Error('安全事件不存在')
  if (allow ? !allow.includes(inc.status) : inc.status === 'closed') {
    throw new Error(`事件 ${inc.code} 当前为「${INCIDENT_STATUS[inc.status]}」状态，不能执行该操作`)
  }
  return inc
}
// 事件关联场次集合：一起安全事件可关联多场比赛（incident_matches），兼容旧字段 incidents.match_id
function incidentMatchIds(id, inc = null) {
  const ids = all(`SELECT match_id FROM incident_matches WHERE incident_id=? ORDER BY id`, id).map(r => r.match_id)
  const legacy = inc ? inc.match_id : get('SELECT match_id FROM incidents WHERE id=?', id)?.match_id
  if (legacy && !ids.includes(legacy)) ids.unshift(legacy)
  return ids
}
function linkIncidentMatch(incidentId, matchId) {
  if (matchId) run(`INSERT OR IGNORE INTO incident_matches (incident_id,match_id) VALUES (?,?)`, incidentId, matchId)
}
const incidentSeverityRank = { major: 3, general: 2, minor: 1 }

// 四方协同上报
function reportIncident(body) {
  return withTransaction(() => {
    const category = body.category
    if (!INCIDENT_CATEGORY[category]) throw new Error('事件类型无效')
    const reporterRole = body.reporter_role
    if (!INCIDENT_ROLE[reporterRole]) throw new Error('上报方角色无效（医疗/安保/裁判/组委会）')
    const description = (body.description || '').trim()
    if (!description) throw new Error('请描述安全事件经过')
    const reporterName = (body.reporter_name || '').trim() || INCIDENT_ROLE[reporterRole]
    const venueId = body.venue_id ? Number(body.venue_id) : null
    if (venueId && !get('SELECT id FROM venues WHERE id=?', venueId)) throw new Error('事发场地不存在')
    // 关联场次：支持一次关联多场比赛（match_ids 数组），兼容单场 match_id
    const matchIds = [...new Set(
      (Array.isArray(body.match_ids) && body.match_ids.length ? body.match_ids : [body.match_id])
        .filter(x => x !== null && x !== undefined && x !== '')
        .map(Number)
    )]
    const matches = []
    for (const mid of matchIds) {
      const m = get('SELECT * FROM matches WHERE id=?', mid)
      if (!m) throw new Error(`关联场次 #${mid} 不存在`)
      matches.push(m)
    }
    const matchId = matches[0]?.id ?? null   // incidents.match_id 保留主关联场次（兼容旧查询）
    const code = nextIncidentCode()
    const r = run(`INSERT INTO incidents (code,category,reporter_role,reporter_name,venue_id,match_id,description,status)
                   VALUES (?,?,?,?,?,?,?, 'pending')`,
      code, category, reporterRole, reporterName, venueId, matchId, description)
    const id = Number(r.lastInsertRowid)
    matches.forEach(m => linkIncidentMatch(id, m.id))
    const loc = [
      venueId ? '地点：' + get('SELECT name FROM venues WHERE id=?', venueId)?.name : null,
      matches.length ? '关联场次：' + matches.map(m => matchTitle(m)).join('、') : null
    ].filter(Boolean).join('；')
    addIncidentLog(id, 'submit',
      `${INCIDENT_ROLE[reporterRole]}上报安全事件（${INCIDENT_CATEGORY[category]}）：${description}${loc ? '（' + loc + '）' : ''}`,
      { role: reporterRole, matchId, operator: reporterName })
    return { ok: true, id, code }
  })
}

// 组委会分级派单：重大 / 较大 / 一般，指定牵头方
function triageIncident(id, body) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['pending'])
    const severity = body.severity
    if (!INCIDENT_SEVERITY[severity]) throw new Error('请选择事件等级（重大/较大/一般）')
    const lead = body.lead || 'organizer'
    if (!INCIDENT_ROLE[lead]) throw new Error('牵头处置方无效')
    const operator = (body.operator || '组委会').trim() || '组委会'
    const note = (body.dispatch_note || '').trim()
    const claim = run(`UPDATE incidents SET severity=?, lead=?, status='handling', dispatch_note=?, triaged_at=datetime('now','localtime'), reviewer=?
                       WHERE id=? AND status='pending'`, severity, lead, note || null, operator, id)
    if (!claim.changes) {
      const now = get('SELECT status FROM incidents WHERE id=?', id)
      if (now?.status === 'handling') return { ok: true, idempotent: true }
      throw new Error('该事件已处理，不能重复分级')
    }
    addIncidentLog(id, 'triage',
      `${operator} 完成分级派单：等级「${INCIDENT_SEVERITY[severity]}」，由${INCIDENT_ROLE[lead]}牵头处置${note ? '；派单说明：' + note : ''}`,
      { role: 'organizer', operator })
    return { ok: true }
  })
}

// 协同进展（四方均可补充）
function progressIncident(id, body) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['handling', 'resolved'])
    const role = body.role || inc.lead || 'organizer'
    if (!INCIDENT_ROLE[role]) throw new Error('协同方角色无效')
    const note = (body.note || '').trim()
    if (!note) throw new Error('请填写处置进展')
    addIncidentLog(id, 'progress', `${INCIDENT_ROLE[role]}：${note}`, { role, matchId: inc.match_id ?? null, operator: body.operator || INCIDENT_ROLE[role] })
    // 待结案状态下有新的处置进展，自动回到处置中
    if (inc.status === 'resolved') {
      run(`UPDATE incidents SET status='handling', resolved_at=NULL WHERE id=? AND status='resolved'`, id)
      addIncidentLog(id, 'reopen', '出现新的协同处置进展，事件由「待结案」退回「处置中」', { role, operator: body.operator || INCIDENT_ROLE[role] })
    }
    return { ok: true }
  })
}

// 联动：暂扣证件（复用证件人工暂扣；建立事件关联，供结案统一解除）
function incidentBlockBadge(id, body) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['handling', 'resolved'])
    const badgeId = Number(body.badge_id)
    const badge = get('SELECT * FROM badges WHERE id=?', badgeId)
    if (!badge) throw new Error('证件不存在')
    const reason = (body.reason || '').trim()
    if (!reason) throw new Error('暂扣证件必须填写原因并留痕')
    const operator = (body.operator || INCIDENT_ROLE[inc.lead || 'organizer']).trim() || '组委会'
    const link = get(`SELECT * FROM incident_badges WHERE incident_id=? AND badge_id=? AND status='active'`, id, badgeId)
    if (!link) {
      run(`INSERT INTO incident_badges (incident_id,badge_id,status,reason) VALUES (?,?,'active',?)`, id, badgeId, reason)
    }
    // 已暂扣（人工/其他事件）为幂等：补充关联即可，证件状态不再重复变更
    setBadgeBlocked(badgeId, true, `安全事件 ${inc.code}：${reason}`, operator, inc.code)
    if (!link) {
      addIncidentLog(id, 'badge_block', `暂扣证件 ${badge.code}（${badge.name}）：${reason}`,
        { role: body.role || inc.lead || 'organizer', badgeId, matchId: inc.match_id ?? null, operator })
    }
    persistIncidentImpact(id)
    return { ok: true }
  })
}

// 联动：解除本事件暂扣的证件
function incidentReleaseBadge(id, linkId, body = {}) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['handling', 'resolved'])
    const link = get(`SELECT * FROM incident_badges WHERE id=? AND incident_id=?`, linkId, id)
    if (!link) throw new Error('暂扣记录不存在')
    if (link.status === 'released') return { ok: true, idempotent: true }
    const reason = (body.reason || `安全事件 ${inc.code} 处置解除暂扣`).trim()
    const operator = (body.operator || INCIDENT_ROLE[inc.lead || 'organizer']).trim() || '组委会'
    run(`UPDATE incident_badges SET status='released', released_reason=?, released_at=datetime('now','localtime') WHERE id=?`, reason, linkId)
    const badge = get('SELECT code,name FROM badges WHERE id=?', link.badge_id)
    // 同一证件仍被其它安全事件暂扣时保持停用，避免提前解停
    const otherHold = get(`SELECT COUNT(*) c FROM incident_badges WHERE badge_id=? AND status='active'`, link.badge_id)?.c
    if (otherHold) {
      addIncidentLog(id, 'badge_release', `本事件解除证件 ${badge?.code} 的暂扣关联（${badge?.name}），但该证仍被其它安全事件暂扣，维持停用`,
        { role: body.role || inc.lead || 'organizer', badgeId: link.badge_id, matchId: inc.match_id ?? null, operator })
    } else {
      setBadgeBlocked(link.badge_id, false, reason, operator, inc.code)
      addIncidentLog(id, 'badge_release', `解除证件 ${badge?.code} 的暂扣（${badge?.name}），已按当前资格重新同步：${reason}`,
        { role: body.role || inc.lead || 'organizer', badgeId: link.badge_id, matchId: inc.match_id ?? null, operator })
    }
    persistIncidentImpact(id)
    return { ok: true }
  })
}

// 联动：暂停场次（停止入场核验、锁定比分录入，等待恢复或改期）
// 支持一次批量暂停多场（match_ids 数组）；未指定场次时回退事件全部关联场次。
// 批量暂停在单事务内完成：任一场次不可暂停（已完赛/被其它事件暂停）则整单回滚；
// 本事件已暂停的场次按幂等跳过，不重复留痕。
function incidentPauseMatch(id, body = {}) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['handling', 'resolved'])
    let ids = Array.isArray(body.match_ids) && body.match_ids.length
      ? body.match_ids.map(Number)
      : [body.match_id ? Number(body.match_id) : null].filter(Boolean)
    if (!ids.length) ids = incidentMatchIds(id, inc)
    ids = [...new Set(ids)]
    if (!ids.length) throw new Error('请选择要暂停的关联场次')
    const operator = (body.operator || INCIDENT_ROLE[inc.lead || 'organizer']).trim() || '组委会'
    const reason = (body.reason || `${inc.code} 安全事件暂停（${INCIDENT_CATEGORY[inc.category]}）`).trim()
    const paused = []
    let skipped = 0
    for (const mid of ids) {
      const m = get('SELECT * FROM matches WHERE id=?', mid)
      if (!m) throw new Error(`场次 #${mid} 不存在`)
      if (m.status !== 'scheduled') throw new Error(`仅待赛场次可以暂停（「${matchTitle(m)}」已完赛/取消）`)
      if (m.is_paused) {
        if (m.pause_incident_id !== id) throw new Error(`「${matchTitle(m)}」已被另一安全事件暂停`)
        skipped++
        linkIncidentMatch(id, m.id)
        continue
      }
      run(`UPDATE matches SET is_paused=1, pause_incident_id=?, pause_reason=?, paused_at=datetime('now','localtime') WHERE id=?`, id, reason, m.id)
      linkIncidentMatch(id, m.id)
      paused.push(m)
    }
    // 逐场留痕：事件时间线 + 入场异常审计 + 排班变更留痕，三域同步
    paused.forEach(m => {
      addIncidentLog(id, 'match_pause', `暂停场次：${matchTitle(get('SELECT * FROM matches WHERE id=?', m.id))}；${reason}`,
        { role: body.role || inc.lead || 'organizer', matchId: m.id, operator })
      addAccessLog('incident_pause', null, null, `${matchTitle(m)} 因安全事件 ${inc.code} 暂停，入场核验与比分录入已锁定`, reason, operator, 'danger', m.id, m.venue_id)
      addLog('match_change', m.id, null, `${matchTitle(m)} 因安全事件 ${inc.code} 暂停`, reason, operator)
    })
    if (paused.length > 1) {
      addIncidentLog(id, 'match_pause',
        `批量暂停 ${paused.length} 场比赛：${paused.map(m => matchTitle(m)).join('、')}；入场核验、裁判签到与成绩录入已同步锁定`,
        { role: body.role || inc.lead || 'organizer', operator })
    }
    persistIncidentImpact(id)
    if (!paused.length) return { ok: true, idempotent: true, paused: 0, skipped }
    return { ok: true, paused: paused.length, skipped }
  })
}

// 联动：恢复场次（解除暂停，原档期继续）
// 支持 match_ids 批量恢复，或 all=true 一键恢复本事件全部暂停场次；单事务批量落库，逐场留痕。
function incidentResumeMatch(id, body = {}) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['handling', 'resolved'])
    let ids
    if (Array.isArray(body.match_ids) && body.match_ids.length) ids = body.match_ids.map(Number)
    else if (body.all) ids = all(`SELECT id FROM matches WHERE pause_incident_id=? AND is_paused=1`, id).map(r => r.id)
    else ids = [body.match_id ? Number(body.match_id) : inc.match_id].filter(Boolean)
    ids = [...new Set(ids)]
    if (!ids.length) throw new Error('没有需要恢复的暂停场次')
    const operator = (body.operator || INCIDENT_ROLE[inc.lead || 'organizer']).trim() || '组委会'
    const note = (body.note || '').trim()
    const resumed = []
    let skipped = 0
    for (const mid of ids) {
      const m = get('SELECT * FROM matches WHERE id=?', mid)
      if (!m) throw new Error(`场次 #${mid} 不存在`)
      if (!m.is_paused) { skipped++; continue }   // 幂等：未暂停的场次跳过
      if (m.pause_incident_id !== id) throw new Error(`「${matchTitle(m)}」由另一安全事件暂停，需由该事件恢复`)
      run(`UPDATE matches SET is_paused=0, pause_reason=NULL, resume_incident_id=?, resumed_at=datetime('now','localtime') WHERE id=?`, id, m.id)
      resumed.push(m)
    }
    resumed.forEach(m => {
      const detail = `恢复场次：${matchTitle(get('SELECT * FROM matches WHERE id=?', m.id))}，恢复入场核验与比分录入${note ? '；' + note : ''}`
      addIncidentLog(id, 'match_resume', detail, { role: body.role || inc.lead || 'organizer', matchId: m.id, operator })
      addAccessLog('incident_resume', null, null, `${matchTitle(m)} 随安全事件 ${inc.code} 恢复，入场核验放行恢复`, note, operator, 'info', m.id, m.venue_id)
      addLog('match_change', m.id, null, `${matchTitle(m)} 安全事件 ${inc.code} 处置恢复`, note || '安全事件处置恢复', operator)
    })
    if (resumed.length > 1) {
      addIncidentLog(id, 'match_resume',
        `批量恢复 ${resumed.length} 场比赛：${resumed.map(m => matchTitle(m)).join('、')}；入场核验与成绩录入同步恢复`,
        { role: body.role || inc.lead || 'organizer', operator })
    }
    persistIncidentImpact(id)
    if (!resumed.length) return { ok: true, idempotent: true, resumed: 0, skipped }
    return { ok: true, resumed: resumed.length, skipped }
  })
}

// 联动：暂停场次改期（沿用赛程变更的冲突检测/自动重排，成功后解除暂停并记录原档期）
// 支持 items 数组一次批量改期多场关联场次：全部场次在同一事务内依次改期，
// 场地/裁判冲突无法解决时任一场失败整单原子回滚，不留半改期中间态。
function incidentRescheduleMatch(id, body) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['handling', 'resolved'])
    const items = Array.isArray(body.items) && body.items.length
      ? body.items
      : [{ match_id: body.match_id, time_label: body.time_label, venue_id: body.venue_id }]
    const operator = (body.operator || INCIDENT_ROLE[inc.lead || 'organizer']).trim() || '组委会'
    const reason = (body.reason || '').trim() || `安全事件 ${inc.code} 处置改期`
    const results = []
    for (const item of items) {
      const matchId = item.match_id ? Number(item.match_id) : inc.match_id
      const m = matchId ? get('SELECT * FROM matches WHERE id=?', matchId) : null
      if (!m) throw new Error('请选择要改期的场次')
      if (m.status !== 'scheduled') throw new Error(`仅待赛场次可以改期（「${matchTitle(m)}」已完赛/取消）`)
      const wasPaused = !!m.is_paused
      const origTime = m.time_label, origVenue = m.venue_id
      const r = updateMatchSchedule(m.id, {
        time_label: item.time_label, venue_id: item.venue_id === undefined ? m.venue_id : item.venue_id,
        operator, reason: `安全事件 ${inc.code} 改期：${reason}`,
        force: !!body.force, auto_rearrange: body.auto_rearrange !== false, allow_paused: true
      })
      if (r.unchanged) throw new Error(`「${matchTitle(m)}」改期时间/场地与原档期一致，无需改期`)
      // 改期成功：解除暂停，留存原档期与事件编号（origTime/origVenue 为改期前快照，不能再读已更新的列）
      run(`UPDATE matches SET is_paused=0, pause_reason=NULL, resume_incident_id=?, resumed_at=datetime('now','localtime'),
           reschedule_incident_code=?, orig_time_label=?, orig_venue_id=? WHERE id=?`,
        id, inc.code, origTime ?? null, origVenue ?? null, m.id)
      linkIncidentMatch(id, m.id)
      const fresh = get('SELECT * FROM matches WHERE id=?', m.id)
      const oldVenueName = origVenue ? get('SELECT name FROM venues WHERE id=?', origVenue)?.name : '未指定'
      const newVenueName = fresh.venue_id ? get('SELECT name FROM venues WHERE id=?', fresh.venue_id)?.name : '未指定'
      addIncidentLog(id, 'match_reschedule',
        `场次改期：${matchTitle(fresh)}；时间 ${origTime || '未指定'} → ${fresh.time_label || '未指定'}；场地 ${oldVenueName} → ${newVenueName}${wasPaused ? '；暂停随改期解除' : ''}`,
        { role: body.role || inc.lead || 'organizer', matchId: m.id, operator })
      addAccessLog('incident_reschedule', null, null,
        `${matchTitle(fresh)} 因安全事件 ${inc.code} 改期（${origTime || '未指定'}/${oldVenueName} → ${fresh.time_label || '未指定'}/${newVenueName}），暂停同步解除`,
        reason, operator, 'warn', m.id, fresh.venue_id)
      results.push({ match_id: m.id, ...r })
    }
    if (results.length > 1) {
      addIncidentLog(id, 'match_reschedule',
        `批量改期 ${results.length} 场比赛完成：${results.map(x => matchTitle(get('SELECT * FROM matches WHERE id=?', x.match_id))).join('、')}；执法名单随改期自动重排/补齐，暂停同步解除`,
        { role: body.role || inc.lead || 'organizer', operator })
    }
    persistIncidentImpact(id)
    return { ok: true, count: results.length, results }
  })
}

// 处置完成：转入待结案；存在仍暂停场次时必须先恢复或改期
function resolveIncident(id, body = {}) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['handling'])
    const note = (body.note || '').trim()
    if (!note) throw new Error('请填写处置完成说明')
    const operator = (body.operator || INCIDENT_ROLE[inc.lead || 'organizer']).trim() || '组委会'
    const stillPaused = all(`SELECT id FROM matches WHERE pause_incident_id=? AND is_paused=1`, id)
    if (stillPaused.length) throw new Error(`还有 ${stillPaused.length} 个场次处于暂停状态，请先恢复或改期后再完成处置`)
    const claim = run(`UPDATE incidents SET status='resolved', resolution_note=?, resolved_at=datetime('now','localtime') WHERE id=? AND status='handling'`, note, id)
    if (!claim.changes) {
      const now = get('SELECT status FROM incidents WHERE id=?', id)
      if (now?.status === 'resolved') return { ok: true, idempotent: true }
      throw new Error('当前状态不能标记处置完成')
    }
    persistIncidentImpact(id)
    addIncidentLog(id, 'resolve', `现场处置完成：${note}；转入待结案，由组委会复核结案`, { role: inc.lead || 'organizer', matchId: inc.match_id ?? null, operator })
    return { ok: true }
  })
}

// 待结案 → 退回处置（补充处置）
function reopenIncident(id, body = {}) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['resolved'])
    const note = (body.note || '').trim() || '复核发现仍有遗留事项，退回继续处置'
    const operator = (body.operator || '组委会').trim() || '组委会'
    run(`UPDATE incidents SET status='handling', resolved_at=NULL WHERE id=? AND status='resolved'`, id)
    addIncidentLog(id, 'reopen', note, { role: 'organizer', matchId: inc.match_id ?? null, operator })
    return { ok: true }
  })
}

// 结案：组委会复核归档；仅「待结案」可结案（处置中需先完成处置）。默认解除本事件仍暂扣的证件
function closeIncident(id, body = {}) {
  return withTransaction(() => {
    const inc = incidentOpen(id, ['resolved'])
    const operator = (body.operator || '组委会').trim() || '组委会'
    const summary = (body.summary || '').trim()
    if (!summary) throw new Error('请填写结案总结')
    const keepBlocked = !!body.keep_blocked
    const keepReason = (body.keep_reason || '').trim()
    if (keepBlocked && !keepReason) throw new Error('选择继续暂扣证件时必须注明原因（责任追究/纪律调查）')
    const stillPaused = all(`SELECT id FROM matches WHERE pause_incident_id=? AND is_paused=1`, id)
    if (stillPaused.length) throw new Error(`还有 ${stillPaused.length} 个暂停场次未恢复或改期，不能结案`)

    const activeLinks = all(`SELECT * FROM incident_badges WHERE incident_id=? AND status='active'`, id)
    const released = []
    if (!keepBlocked) {
      activeLinks.forEach(link => {
        run(`UPDATE incident_badges SET status='released', released_reason=?, released_at=datetime('now','localtime') WHERE id=?`,
          `安全事件 ${inc.code} 结案统一解除暂扣`, link.id)
        // 仍被其它未结事件暂扣的证件保持停用
        const otherHold = get(`SELECT COUNT(*) c FROM incident_badges WHERE badge_id=? AND status='active'`, link.badge_id)?.c
        if (!otherHold) {
          setBadgeBlocked(link.badge_id, false, `安全事件 ${inc.code} 结案统一解除暂扣`, operator, inc.code)
          released.push(link.id)
        }
      })
    }
    run(`UPDATE incidents SET status='closed', close_summary=?, closed_at=datetime('now','localtime'), reviewer=? WHERE id=?`,
      summary, operator, id)
    persistIncidentImpact(id)
    const impact = safeParseJson(get('SELECT impact FROM incidents WHERE id=?', id).impact)
    const parts = [`${operator} 结案归档：${summary}`]
    if (released.length) parts.push(`结案统一解除暂扣证件 ${released.length} 张`)
    if (keepBlocked && activeLinks.length) parts.push(`${activeLinks.length} 张证件继续暂扣（${keepReason}），需在证件管理中人工解除`)
    parts.push(`本事件累计暂扣/解除证件 ${impact.badges_blocked + impact.badges_released} 张次，暂停 ${impact.matches_paused + impact.matches_resumed + impact.matches_rescheduled} 场、改期 ${impact.matches_rescheduled} 场`)
    addIncidentLog(id, 'close', parts.join('；'), { role: 'organizer', matchId: inc.match_id ?? null, operator })
    return { ok: true, released: released.length }
  })
}

seed()
// 启动即对历史库做一次统计修复（幂等，健康库为无操作）
{
  const r = repairHistoricalStats('系统')
  const fixed = r.duplicate_matches + r.quota_no_fixed + r.entries_cleaned
  if (fixed || r.over_quota.length) console.log('[SPORT] 历史赛程统计修复：', JSON.stringify(r))
}
// 启动即全量同步赛事证件（为旧库补发、按资格刷新授权区域；幂等，健康库为无操作）
syncAllBadges('系统', false)

/* ================= API ================= */
const joinMatch = m => {
  if (!m) return null
  return {
    ...m,
    teamA: m.team_a ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_a) : null,
    teamB: m.team_b ? get('SELECT id,name,unit_id FROM teams WHERE id=?', m.team_b) : null,
    venue: get('SELECT * FROM venues WHERE id=?', m.venue_id) || null
  }
}
app.get('/api/sports', (_, res) => res.json(all('SELECT * FROM sports')))
app.get('/api/teams', (_, res) => res.json(all('SELECT t.*, u.name unit, u.color FROM teams t JOIN units u ON u.id=t.unit_id')))
app.get('/api/units', (_, res) => res.json(all('SELECT * FROM units')))
app.get('/api/venues', (_, res) => res.json(all('SELECT * FROM venues')))
app.get('/api/referees', (_, res) => res.json(all('SELECT * FROM referees ORDER BY id')))
app.post('/api/referees', (req, res) => {
  const name = (req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: '裁判姓名不能为空' })
  if (get('SELECT id FROM referees WHERE name=?', name)) return res.status(400).json({ error: '已存在同名裁判' })
  const r = run('INSERT INTO referees (name,sport,level,status) VALUES (?,?,?,?)', name, req.body.sport || null, req.body.level || '主裁', req.body.status || '就绪')
  syncBadge('referee', Number(r.lastInsertRowid), '组委会', true)
  res.json({ ok: true, id: Number(r.lastInsertRowid) })
})
app.get('/api/athletes', (_, res) => res.json(all('SELECT a.*, u.name unit FROM athletes a JOIN units u ON u.id=a.unit_id')))
app.get('/api/matches', (_, res) => res.json(all('SELECT * FROM matches').map(joinMatch)))
app.get('/api/entries', (_, res) => res.json(all('SELECT e.*, a.name aname, u.name unit FROM entries e JOIN athletes a ON a.id=e.athlete_id JOIN units u ON u.id=e.unit_id')))

/* —— 裁判排班：执法安排 / 冲突 / 留痕 —— */
const joinAssignment = a => ({
  ...a,
  referee: get('SELECT id,name,sport,level,status FROM referees WHERE id=?', a.referee_id),
  match: joinMatch(get('SELECT * FROM matches WHERE id=?', a.match_id))
})
app.get('/api/assignments', (_, res) => {
  res.json(all(`SELECT a.* FROM assignments a WHERE a.status='assigned' ORDER BY a.id DESC`).map(joinAssignment))
})
app.post('/api/assignments', (req, res) => {
  try {
    const r = assignReferee(Number(req.body.match_id), Number(req.body.referee_id), req.body.role || 'chief', req.body.operator, req.body.reason, !!req.body.force)
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' || e.code === 'SKILL_MISMATCH' || e.code === 'ROLE_MISMATCH' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
app.post('/api/assignments/auto', (req, res) => res.json({ ok: true, ...autoAssign(req.body.operator) }))
app.post('/api/assignments/:id/release', (req, res) => {
  try { res.json(releaseAssignment(Number(req.params.id), req.body.operator, req.body.reason)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/assignments/:id/reassign', (req, res) => {
  try {
    const r = reassignAssignment(Number(req.params.id), {
      target_id: req.body.target_id ? Number(req.body.target_id) : null,
      new_referee_id: req.body.new_referee_id,
      reason: req.body.reason, operator: req.body.operator
    })
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' || e.code === 'SKILL_MISMATCH' || e.code === 'ROLE_MISMATCH' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
// 赛程变更（时间/场地），联动执法安排
app.patch('/api/matches/:id/schedule', (req, res) => {
  try {
    const r = updateMatchSchedule(Number(req.params.id), {
      time_label: req.body.time_label, venue_id: req.body.venue_id,
      operator: req.body.operator, reason: req.body.reason, force: !!req.body.force,
      auto_rearrange: req.body.auto_rearrange !== false
    })
    res.json({ ok: true, ...r })
  } catch (e) {
    res.status(e.code === 'CONFLICT' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts })
  }
})
app.get('/api/assignment-logs', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 100)
  const rows = all(`SELECT l.*, r.name referee_name,
    s.name sport_name,
    (SELECT ta.name FROM matches m2 LEFT JOIN teams ta ON ta.id=m2.team_a WHERE m2.id=l.match_id) team_a_name,
    (SELECT tb.name FROM matches m3 LEFT JOIN teams tb ON tb.id=m3.team_b WHERE m3.id=l.match_id) team_b_name
    FROM assignment_logs l
    LEFT JOIN referees r ON r.id=l.referee_id
    LEFT JOIN matches m ON m.id=l.match_id
    LEFT JOIN sports s ON s.id=m.sport_id
    ORDER BY l.id DESC LIMIT ?`, limit)
  res.json(rows)
})
// 冲突与整场排班覆盖总览：待安排（分角色席位）/ 裁判撞档 / 场地撞场 / 专长不符 / 角色资质不符
app.get('/api/conflicts', (_, res) => {
  const allBall = all(`SELECT * FROM matches WHERE team_a IS NOT NULL AND team_b IS NOT NULL`)
  const scheduled = allBall.filter(m => m.status === 'scheduled' && crewSpecOfMatch(m).chief > 0)
  const coverage = crewCoverageStats(allBall)
  // unassigned / crew_gaps 保持待赛口径，供排班操作页处理；overall_* 供报表兼容已完成与待赛
  const crewGaps = coverage.gaps.map(g => ({
    match_id: g.match_id, title: g.title, status: g.status,
    missing: g.missing, missing_text: crewShortText(g.missing), missing_count: g.missing_count
  }))
  const unassigned = crewGaps
    .filter(g => g.missing.chief)
    .map(g => ({ match_id: g.match_id, title: g.title }))
  const refereeConflicts = []
  all(`SELECT a.* FROM assignments a WHERE a.status='assigned'`).forEach(a => {
    const m = get(`SELECT * FROM matches WHERE id=?`, a.match_id)
    if (!m || m.status !== 'scheduled') return
    refBusyMatches(a.referee_id, m.time_label, m.id).forEach(b => {
      const key = [a.id, b.aid].sort().join('-')
      if (refereeConflicts.some(c => c.key === key)) return
      const r1 = get('SELECT name FROM referees WHERE id=?', a.referee_id)
      refereeConflicts.push({
        key, referee_id: a.referee_id, referee: r1?.name, time: m.time_label,
        role: a.role, role_name: ROLE_NAME[a.role] || '执法',
        match_x: { match_id: m.id, status: m.status, title: matchTitle(m) },
        match_y: { match_id: b.id, status: b.status, title: matchTitle(b) }
      })
    })
  })
  const venueConflicts = []
  allBall.filter(m => ['scheduled', 'finished'].includes(m.status)).forEach(m => {
    if (!m.venue_id) return
    venueClashMatches(m.venue_id, m.time_label, m.id, ['scheduled', 'finished']).forEach(o => {
      const key = [m.id, o.id].sort().join('-')
      if (venueConflicts.some(c => c.key === key)) return
      const v = get('SELECT name FROM venues WHERE id=?', m.venue_id)
      venueConflicts.push({
        key, venue_id: m.venue_id, venue: v?.name, time: m.time_label,
        operational: m.status === 'scheduled' || o.status === 'scheduled',
        match_x: { match_id: m.id, status: m.status, title: matchTitle(m) },
        match_y: { match_id: o.id, status: o.status, title: matchTitle(o) }
      })
    })
  })
  const skillMismatch = [], roleMismatch = []
  all(`SELECT a.* FROM assignments a WHERE a.status='assigned'`).forEach(a => {
    const m = get(`SELECT * FROM matches WHERE id=?`, a.match_id)
    if (!m || m.status !== 'scheduled') return
    const r = get('SELECT * FROM referees WHERE id=?', a.referee_id)
    if (!refSportOk(r, m.sport_id)) skillMismatch.push({ assignment_id: a.id, referee: r.name, referee_sport: r.sport, role: a.role, role_name: ROLE_NAME[a.role], match_id: m.id, title: matchTitle(m) })
    if (!refLevelOk(r, a.role)) roleMismatch.push({ assignment_id: a.id, referee: r.name, level: r.level, role: a.role, role_name: ROLE_NAME[a.role], match_id: m.id, title: matchTitle(m) })
  })
  res.json({
    // 顶层 coverage 保持待赛口径，coverage.overall 汇总已完赛+待赛
    unassigned,
    crew_gaps: crewGaps,
    coverage,
    referee_conflicts: refereeConflicts,
    venue_conflicts: venueConflicts,
    historical_venue_conflicts: venueConflicts.filter(c => !c.operational),
    skill_mismatch: skillMismatch,
    role_mismatch: roleMismatch
  })
})
// 裁判执法工作量（含历史完赛场次，按角色拆分 + 合计）
app.get('/api/referee-workload', (_, res) => {
  const rows = all(`SELECT r.id, r.name, r.sport, r.level, r.status,
      SUM(CASE WHEN m.status='finished' THEN 1 ELSE 0 END) done,
      SUM(CASE WHEN m.status='scheduled' THEN 1 ELSE 0 END) upcoming,
      SUM(CASE WHEN m.status='finished' AND a.role='chief' THEN 1 ELSE 0 END) done_chief,
      SUM(CASE WHEN m.status='finished' AND a.role='assistant' THEN 1 ELSE 0 END) done_assistant,
      SUM(CASE WHEN m.status='finished' AND a.role='recorder' THEN 1 ELSE 0 END) done_recorder,
      SUM(CASE WHEN m.status='scheduled' AND a.role='chief' THEN 1 ELSE 0 END) upcoming_chief,
      SUM(CASE WHEN m.status='scheduled' AND a.role='assistant' THEN 1 ELSE 0 END) upcoming_assistant,
      SUM(CASE WHEN m.status='scheduled' AND a.role='recorder' THEN 1 ELSE 0 END) upcoming_recorder
    FROM referees r LEFT JOIN assignments a ON a.referee_id=r.id AND a.status='assigned'
    LEFT JOIN matches m ON m.id=a.match_id
    GROUP BY r.id ORDER BY done DESC, upcoming DESC, r.id`)
  res.json(rows.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v ?? 0]))))
})

// 参赛报名与资格审核
app.get('/api/registrations', (_, res) => {
  const rows = all(`SELECT r.*, u.name unit, s.name sport, s.format, s.category,
    CASE WHEN r.kind='team' THEN t.name ELSE a.name END AS name
    FROM registrations r
    JOIN units u ON u.id=r.unit_id
    JOIN sports s ON s.id=r.sport_id
    LEFT JOIN teams t ON t.id=r.team_id
    LEFT JOIN athletes a ON a.id=r.athlete_id
    ORDER BY r.id DESC`)
  res.json(rows)
})
app.post('/api/registrations', (req, res) => {
  const { kind, unit_id, sport_id, name } = req.body
  if (!['team', 'athlete'].includes(kind)) return res.status(400).json({ error: '报名类型无效' })
  try {
    const r = submitRegistration(kind, Number(unit_id), Number(sport_id), name)
    res.json({ ok: true, ...r })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/approve', (req, res) => {
  try { res.json(approveRegistration(Number(req.params.id), req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/reject', (req, res) => {
  try { res.json(rejectRegistration(Number(req.params.id), req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/withdraw', (req, res) => {
  try { res.json(withdrawOrRevoke(Number(req.params.id), 'withdraw', req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/registrations/:id/revoke', (req, res) => {
  try { res.json(withdrawOrRevoke(Number(req.params.id), 'revoke', req.body.note, req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
// 历史赛程统计修复：重复对阵去重 / 名额序号重排 / 失格成绩清理 / 积分奖牌全量重建（幂等）
app.post('/api/maintenance/repair', (req, res) => {
  try { res.json({ ok: true, report: repairHistoricalStats(req.body?.operator || '组委会') }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

/* —— 赛事申诉复核：单位提交异议 → 组委会受理/复核改判/驳回，全量留痕 —— */
const joinAppeal = a => {
  const unit = get('SELECT id,name,color FROM units WHERE id=?', a.unit_id)
  const sport = a.sport_id ? get('SELECT id,name,format,category FROM sports WHERE id=?', a.sport_id) : null
  let target = null
  if (a.target_type === 'match') {
    const m = get('SELECT * FROM matches WHERE id=?', a.target_id)
    target = m ? {
      ...joinMatch(m),
      team_a_unit: m.team_a ? get('SELECT unit_id FROM teams WHERE id=?', m.team_a)?.unit_id : null,
      team_b_unit: m.team_b ? get('SELECT unit_id FROM teams WHERE id=?', m.team_b)?.unit_id : null
    } : null
  } else if (a.target_type === 'track') {
    target = get(`SELECT e.*, a.name aname, a.unit_id athlete_unit, u.name athlete_unit_name
                  FROM entries e JOIN athletes a ON a.id=e.athlete_id JOIN units u ON u.id=a.unit_id
                  WHERE e.id=?`, a.target_id)
  } else {
    const r = get(`SELECT r.*, u.name target_unit FROM registrations r JOIN units u ON u.id=r.unit_id WHERE r.id=?`, a.target_id)
    target = r
  }
  const logs = all(`SELECT * FROM appeal_logs WHERE appeal_id=? ORDER BY id`, a.id)
  return { ...a, impact: safeParseJson(a.impact), unit, sport, target, logs }
}
app.get('/api/appeals', (_, res) => {
  res.json(all('SELECT * FROM appeals ORDER BY id DESC').map(joinAppeal))
})
app.post('/api/appeals', (req, res) => {
  try {
    const r = submitAppeal(req.body || {})
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/appeals/:id/accept', (req, res) => {
  try { res.json(acceptAppeal(Number(req.params.id), req.body.reviewer)) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/appeals/:id/reject', (req, res) => {
  try { res.json(closeAppeal(Number(req.params.id), 'reject', req.body.note, req.body.reviewer || '组委会')) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/appeals/:id/withdraw', (req, res) => {
  try { res.json(closeAppeal(Number(req.params.id), 'withdraw', req.body.note, req.body.operator || '申诉单位')) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/appeals/:id/uphold', (req, res) => {
  try {
    const r = upholdAppeal(Number(req.params.id), req.body || {})
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

/* —— 赛事安全事件处置：医疗/安保/裁判/组委会协同上报、分级、处置、结案 —— */
const joinIncident = inc => {
  const venue = inc.venue_id ? get('SELECT id,name FROM venues WHERE id=?', inc.venue_id) : null
  const match = inc.match_id ? joinMatch(get('SELECT * FROM matches WHERE id=?', inc.match_id)) : null
  // 一起事件可关联多场比赛：match 保留主关联（兼容），matches 为全量关联场次
  const matchIds = incidentMatchIds(inc.id, inc)
  const matches = matchIds.map(mid => joinMatch(get('SELECT * FROM matches WHERE id=?', mid))).filter(Boolean)
  const logs = all(`SELECT * FROM incident_logs WHERE incident_id=? ORDER BY id`, inc.id)
  const badgeLinks = all(`SELECT ib.*, b.code badge_code, b.name badge_name, b.subject_type, b.status badge_status
                          FROM incident_badges ib JOIN badges b ON b.id=ib.badge_id
                          WHERE ib.incident_id=? ORDER BY ib.id`, inc.id)
  return {
    ...inc,
    impact: safeParseJson(inc.impact),
    venue, match,
    match_ids: matchIds,
    matches,
    logs,
    badge_links: badgeLinks.map(l => ({ ...l }))
  }
}
app.get('/api/incidents', (_, res) => {
  // 待办在前：待分级 → 处置中 → 待结案 → 已结案
  res.json(all(`SELECT * FROM incidents ORDER BY
    CASE status WHEN 'pending' THEN 0 WHEN 'handling' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
    CASE severity WHEN 'major' THEN 0 WHEN 'general' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, id DESC`).map(joinIncident))
})
app.post('/api/incidents', (req, res) => {
  try { res.json(reportIncident(req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/triage', (req, res) => {
  try { res.json(triageIncident(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/progress', (req, res) => {
  try { res.json(progressIncident(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/badges', (req, res) => {
  try { res.json(incidentBlockBadge(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/badges/:linkId/release', (req, res) => {
  try { res.json(incidentReleaseBadge(Number(req.params.id), Number(req.params.linkId), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/pause', (req, res) => {
  try { res.json(incidentPauseMatch(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(e.code === 'CONFLICT' ? 409 : 400).json({ error: e.message, code: e.code }) }
})
app.post('/api/incidents/:id/resume', (req, res) => {
  try { res.json(incidentResumeMatch(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/reschedule', (req, res) => {
  try { res.json(incidentRescheduleMatch(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(e.code === 'CONFLICT' ? 409 : 400).json({ error: e.message, code: e.code, conflicts: e.conflicts }) }
})
app.post('/api/incidents/:id/resolve', (req, res) => {
  try { res.json(resolveIncident(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/reopen', (req, res) => {
  try { res.json(reopenIncident(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/incidents/:id/close', (req, res) => {
  try { res.json(closeIncident(Number(req.params.id), req.body || {})) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
/* —— 赛事证件与入场核验 —— */
const joinBadge = b => {
  let subject = null, unit = null
  if (b.subject_type === 'team') subject = get('SELECT id,name,status,unit_id,sport_id FROM teams WHERE id=?', b.subject_id)
  else if (b.subject_type === 'athlete') subject = get('SELECT id,name,status,unit_id,sport_id FROM athletes WHERE id=?', b.subject_id)
  else if (b.subject_type === 'referee') subject = get('SELECT id,name,status,sport,level FROM referees WHERE id=?', b.subject_id)
  else subject = get(`SELECT vs.id,vs.name,vs.status,vs.role,vs.venue_id, v.name venue_name
                      FROM venue_staff vs LEFT JOIN venues v ON v.id=vs.venue_id WHERE vs.id=?`, b.subject_id)
  if (b.unit_id) unit = get('SELECT id,name,color FROM units WHERE id=?', b.unit_id)
  const sport = b.sport_id ? get('SELECT id,name,format,category FROM sports WHERE id=?', b.sport_id) : null
  const venue = b.venue_id ? get('SELECT id,name FROM venues WHERE id=?', b.venue_id) : null
  return { ...b, zones: safeParseJson(b.zones) || [], subject, unit, sport, venue }
}
app.get('/api/badges', (_, res) => {
  res.json(all(`SELECT * FROM badges ORDER BY
    CASE status WHEN 'blocked' THEN 0 ELSE 1 END, subject_type, id`).map(joinBadge))
})
app.post('/api/badges/sync', (req, res) => {
  try {
    withTransaction(() => syncAllBadges(req.body?.operator || '组委会', true))
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/badges/:id/block', (req, res) => {
  try { res.json(setBadgeBlocked(Number(req.params.id), true, req.body.reason, req.body.operator || '组委会')) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/badges/:id/unblock', (req, res) => {
  try { res.json(setBadgeBlocked(Number(req.params.id), false, req.body.reason, req.body.operator || '组委会')) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
// 场地工作人员
app.get('/api/staff', (_, res) => {
  res.json(all(`SELECT vs.*, v.name venue_name FROM venue_staff vs LEFT JOIN venues v ON v.id=vs.venue_id ORDER BY vs.id`))
})
app.post('/api/staff', (req, res) => {
  try {
    const name = (req.body.name || '').trim()
    if (!name) return res.status(400).json({ error: '工作人员姓名不能为空' })
    const role = (req.body.role || '志愿者').trim()
    if (!STAFF_ZONES[role]) return res.status(400).json({ error: '岗位无效' })
    const venueId = Number(req.body.venue_id)
    if (!get('SELECT id FROM venues WHERE id=?', venueId)) return res.status(400).json({ error: '请选择服务场地' })
    if (get('SELECT id FROM venue_staff WHERE name=? AND venue_id=?', name, venueId)) return res.status(400).json({ error: '该场地已存在同名工作人员' })
    const r = run('INSERT INTO venue_staff (name,role,venue_id,phone,status) VALUES (?,?,?,?,?)',
      name, role, venueId, (req.body.phone || '').trim() || null, req.body.status || '在岗')
    const id = Number(r.lastInsertRowid)
    withTransaction(() => syncBadge('staff', id, req.body.operator || '组委会', true))
    res.json({ ok: true, id })
  } catch (e) { res.status(400).json({ error: e.message }) }
})
// 入场核验（扫码）：资格 + 赛程 动态判定，结果回写报名/排班/比赛，拒绝写入异常审计
app.post('/api/access/verify', (req, res) => {
  try {
    const r = withTransaction(() => verifyAccess({
      code: req.body.code, venueId: req.body.venue_id ? Number(req.body.venue_id) : null,
      matchId: req.body.match_id ? Number(req.body.match_id) : null,
      gate: req.body.gate, force: !!req.body.force, reason: req.body.reason,
      operator: req.body.operator, timeLabel: req.body.time_label || null
    }))
    res.json(r)
  } catch (e) { res.status(400).json({ error: e.message }) }
})
app.get('/api/access/checkins', (req, res) => {
  const limit = Math.min(300, Number(req.query.limit) || 100)
  const result = req.query.result
  const rows = all(`SELECT c.*, v.name venue_name
                    FROM access_checkins c LEFT JOIN venues v ON v.id=c.venue_id
                    ${result ? 'WHERE c.result=?' : ''}
                    ORDER BY c.id DESC LIMIT ?`, ...(result ? [result] : []), limit)
  res.json(rows.map(c => ({ ...c, zones: safeParseJson(c.zones) || [] })))
})
app.get('/api/access/logs', (req, res) => {
  const limit = Math.min(300, Number(req.query.limit) || 100)
  const severity = req.query.severity
  res.json(all(`SELECT l.*, v.name venue_name FROM access_logs l
                LEFT JOIN venues v ON v.id=l.venue_id
                ${severity ? 'WHERE l.severity=?' : ''}
                ORDER BY l.id DESC LIMIT ?`, ...(severity ? [severity] : []), limit))
})
// 场次入场汇总：双方到场 / 执法到岗 / 异常拦截
app.get('/api/access/matches', (req, res) => {
  const ms = all('SELECT * FROM matches ORDER BY time_label, id')
  let rows = matchAdmissionRows(ms)
  if (String(req.query.status || '') === 'scheduled') rows = rows.filter(r => r.status === 'scheduled')
  res.json(rows)
})
app.get('/api/quota', (_, res) => {
  const sports = all('SELECT * FROM sports')
  res.json(sports.map(s => {
    const approved = s.format === 'track'
      ? get(`SELECT COUNT(*) c FROM athletes WHERE sport_id=? AND status='approved'`, s.id).c
      : get(`SELECT COUNT(*) c FROM teams WHERE sport_id=? AND status='approved'`, s.id).c
    const pending = get(`SELECT COUNT(*) c FROM registrations WHERE sport_id=? AND status='pending'`, s.id).c
    return { sport_id: s.id, name: s.name, format: s.format, quota: s.quota, approved, pending, used: approved + pending }
  }))
})
app.get('/api/standings/:sid', (req, res) => res.json(all('SELECT s.*, t.name tname, u.name unit, u.color FROM standings s JOIN teams t ON t.id=s.team_id JOIN units u ON u.id=t.unit_id WHERE s.sport_id=? ORDER BY s.rank', Number(req.params.sid))))
app.get('/api/medals', (_, res) => res.json(all('SELECT m.*, u.name FROM medals m JOIN units u ON u.id=m.unit_id ORDER BY m.gold DESC, m.silver DESC')))

app.get('/api/overview', (_, res) => {
  const sp = all('SELECT * FROM sports')
  const mats = all('SELECT * FROM matches')
  const done = mats.filter(m => m.status === 'finished')
  const pend = mats.filter(m => m.status === 'scheduled' && m.team_a && m.team_b)
  // 排班联动速览：overall 兼容已完赛归档与待赛排班；upcoming 给待赛缺口提示
  const crewStats = crewCoverageStats(mats)
  const crewGapsMissingChief = crewStats.scheduled.gaps.filter(g => g.missing.chief).length
  res.json({
    sports: sp.length,
    finishedMatches: done.length,
    pendingMatches: mats.filter(m => m.status === 'scheduled').length,
    teams: all('SELECT id FROM teams').length || 0,
    athletes: all('SELECT id FROM athletes').length,
    unassignedMatches: crewGapsMissingChief,
    crewCoverage: {
      ...crewStats.overall,
      upcoming: { need: crewStats.scheduled.slots_need, filled: crewStats.scheduled.slots_filled, pct: crewStats.scheduled.slots_pct },
      finished: { need: crewStats.finished.slots_need, filled: crewStats.finished.slots_filled, pct: crewStats.finished.slots_pct }
    },
    refereeConflicts: all(`SELECT COUNT(DISTINCT a1.id) c FROM assignments a1
      JOIN assignments a2 ON a1.referee_id=a2.referee_id AND a1.id<a2.id AND a1.status='assigned' AND a2.status='assigned'
      JOIN matches m1 ON m1.id=a1.match_id JOIN matches m2 ON m2.id=a2.match_id
      WHERE m1.status='scheduled' AND m2.status='scheduled' AND m1.time_label=m2.time_label`)[0]?.c || 0,
    appeals: {
      total: get('SELECT COUNT(*) c FROM appeals')?.c || 0,
      pending: get(`SELECT COUNT(*) c FROM appeals WHERE status='pending'`)?.c || 0,
      reviewing: get(`SELECT COUNT(*) c FROM appeals WHERE status='reviewing'`)?.c || 0,
      upheld: get(`SELECT COUNT(*) c FROM appeals WHERE status='upheld'`)?.c || 0
    },
    // 安全事件速览：待分级 + 处置中 + 待结案 = 待办；重大事件与暂停场次单独预警
    incidents: {
      total: get('SELECT COUNT(*) c FROM incidents')?.c || 0,
      pending: get(`SELECT COUNT(*) c FROM incidents WHERE status='pending'`)?.c || 0,
      handling: get(`SELECT COUNT(*) c FROM incidents WHERE status='handling'`)?.c || 0,
      resolved: get(`SELECT COUNT(*) c FROM incidents WHERE status='resolved'`)?.c || 0,
      closed: get(`SELECT COUNT(*) c FROM incidents WHERE status='closed'`)?.c || 0,
      major_open: get(`SELECT COUNT(*) c FROM incidents WHERE severity='major' AND status IN ('pending','handling','resolved')`)?.c || 0,
      general_open: get(`SELECT COUNT(*) c FROM incidents WHERE severity='general' AND status IN ('pending','handling','resolved')`)?.c || 0,
      paused_matches: get(`SELECT COUNT(*) c FROM matches WHERE is_paused=1`)?.c || 0,
      blocked_by_incident: get(`SELECT COUNT(*) c FROM incident_badges WHERE status='active'`)?.c || 0
    },
    // 证件与入场核验速览：发证规模、当日核验、异常拦截、双方到场/执法到岗准备度
    access: (() => {
      const today = get("SELECT date('now','localtime') d")?.d
      const todayRows = all(`SELECT result, is_duplicate FROM access_checkins WHERE checkin_date=?`, today)
      const countToday = (result, dupOnly = null) => todayRows.filter(r => r.result === result && (dupOnly == null || !!r.is_duplicate === dupOnly)).length
      const badgesActive = get(`SELECT COUNT(*) c FROM badges WHERE status='active'`)?.c || 0
      const badgesBlocked = get(`SELECT COUNT(*) c FROM badges WHERE status='blocked'`)?.c || 0
      const scheduledBall = mats.filter(m => m.status === 'scheduled' && m.team_a && m.team_b && crewSpecOfMatch(m).chief > 0)
      const teamsMissing = scheduledBall.reduce((n, m) => n + (m.checkin_a_at ? 0 : 1) + (m.checkin_b_at ? 0 : 1), 0)
      const crewRows = all(`SELECT a.checkin_at, a.match_id FROM assignments a JOIN matches m ON m.id=a.match_id
                            WHERE a.status='assigned' AND m.status='scheduled' AND m.team_a IS NOT NULL AND m.team_b IS NOT NULL`)
      const crewTotal = crewRows.length
      const crewReady = crewRows.filter(a => a.checkin_at).length
      return {
        badges_active: badgesActive,
        badges_blocked: badgesBlocked,
        today_pass: countToday('pass', false),
        today_duplicate: countToday('pass', true) + countToday('forced_pass', true),
        today_deny: countToday('deny'),
        today_forced: countToday('forced_pass', false),
        total_checkins: get('SELECT COUNT(*) c FROM access_checkins')?.c || 0,
        matches_not_ready: scheduledBall.filter(m => !m.checkin_a_at || !m.checkin_b_at).length,
        scheduled_matches: scheduledBall.length,
        teams_missing: teamsMissing,
        crew_ready: crewReady,
        crew_total: crewTotal
      }
    })(),
    sportDone: sp.map(s => ({ ...s, total: mats.filter(m => m.sport_id === s.id).length, done: done.filter(m => m.sport_id === s.id).length })),
    recent: all('SELECT * FROM matches ORDER BY id DESC LIMIT 5').map(joinMatch)
  })
})
app.post('/api/matches/:id/score', (req, res) => {
  const { score_a, score_b, tb_a, tb_b } = req.body
  const m = get('SELECT * FROM matches WHERE id=?', Number(req.params.id))
  if (!m) return res.status(404).json({ error: '场次不存在' })
  if (m.team_a == null || m.team_b == null) return res.status(400).json({ error: '对阵尚未编排，先编排淘汰赛' })
  const sa = Number(score_a), sb = Number(score_b)
  if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa < 0 || sb < 0) return res.status(400).json({ error: '比分必须为非负整数' })
  // 录入预警：主裁缺失必须提示；其余执法席位（助理/记录台）缺口同步提示
  const crew = crewRowsOf(m.id)
  const hasChief = crew.some(a => a.role === 'chief')
  const missing = crewMissing(m, crew)
  const warnings = []
  if (!hasChief) warnings.push('该场次未安排主裁')
  if (missing.assistant) warnings.push(`缺助理裁判×${missing.assistant}`)
  if (missing.recorder) warnings.push('缺记录台')
  try {
    finishMatch(m.id, sa, sb, tb_a, tb_b)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  res.json({ ok: true, warning: warnings.length ? warnings.join('，') + '，请注意补录执法记录' : null })
})
app.post('/api/ko/:sportId', (req, res) => {
  // 单事务：半决赛/决赛生成与自动排班原子化，避免并发编排产生重复轮次
  const msg = withTransaction(() => generateKO(Number(req.params.sportId)))
  res.json({ ok: !!msg, msg })
})
app.post('/api/track/:sportId', (req, res) => {
  try {
    finishTrack(Number(req.params.sportId), req.body)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})
app.get('/api/reset', (_, res) => {
  // 单事务重置 + 重置后立即执行历史统计修复，保证演示数据口径一致
  withTransaction(() => {
    ['access_checkins', 'access_logs', 'incident_badges', 'incident_logs', 'incidents', 'badges', 'venue_staff', 'appeal_logs', 'appeals', 'assignment_logs', 'assignments', 'registrations', 'entries', 'standings', 'medals', 'matches', 'referees', 'venues', 'athletes', 'teams', 'units', 'sports'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
    seed()
    repairHistoricalStats('系统')
  })
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SPORT] API running at http://localhost:${PORT}`))
