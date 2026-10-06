<script setup>
import { ref, computed, reactive, nextTick } from 'vue'
import { useEventStore } from '@/store/event'

const store = useEventStore()
const tab = ref('gate')
const toast = ref('')
function flash(msg, ok = true) { toast.value = (ok ? '' : '⚠️ ') + msg; setTimeout(() => toast.value = '', 3600) }

const SUBJECT_TEXT = { team: '队伍', athlete: '田径运动员', referee: '裁判', staff: '场地工作人员' }
const SUBJECT_ICON = { team: '🏀', athlete: '🏃', referee: '🧑‍⚖️', staff: '🛠️' }
const ZONE_TEXT = { competition: '比赛区', warmup: '热身区', staff: '工作区', media: '媒体区' }
const RESULT_META = {
  pass: { tag: 'g', text: '放行' },
  forced_pass: { tag: 'y', text: '强制放行' },
  deny: { tag: 'r', text: '拒绝入场' }
}
const REASON_TEXT = {
  BADGE_NOT_FOUND: '证件不存在', BADGE_BLOCKED: '证件停用/暂扣', INELIGIBLE: '资格失效',
  NO_FIXTURE: '无本场赛程', WRONG_VENUE: '场地不符', NOT_ASSIGNED: '无执法排班',
  MATCH_NOT_PLAYABLE: '场次不可入场', MATCH_PAUSED: '场次安全暂停', DUPLICATE: '重复核验'
}
const STAFF_ROLES = ['场地主管', '医疗', '安保', '器材', '志愿者', '媒体']

/* ---------- 扫码核验 ---------- */
const gateForm = reactive({ code: '', venue_id: '', match_id: '', operator: '检票员' })
const codeInput = ref(null)
const lastResult = ref(null)
// 拒绝后可强制放行（必填原因）
const forcePanel = reactive({ show: false, reason: '', deny: null })

const gateMatches = computed(() => store.matchAccess.filter(m => m.status === 'scheduled'))
function pickMatch(mid) {
  gateForm.match_id = mid || ''
  const m = store.matchAccess.find(x => x.match_id === Number(mid))
  if (m) {
    const mm = store.matches.find(x => x.id === Number(mid))
    if (mm?.venue_id) gateForm.venue_id = String(mm.venue_id)
  }
}
async function submitVerify(force = false) {
  const code = gateForm.code.trim()
  if (!code) return flash('请扫描或输入证件编号', false)
  if (force && !forcePanel.reason.trim()) return flash('强制放行必须填写原因并留痕', false)
  try {
    const r = await store.verifyAccess({
      code,
      venue_id: gateForm.venue_id ? Number(gateForm.venue_id) : null,
      match_id: gateForm.match_id ? Number(gateForm.match_id) : null,
      operator: gateForm.operator || '检票员',
      force, reason: force ? forcePanel.reason.trim() : null
    })
    lastResult.value = r
    forcePanel.show = false
    forcePanel.reason = ''
    gateForm.code = ''
    await nextTick(); codeInput.value?.focus()
  } catch (e) {
    flash(e.message, false)
  }
}
function showForce() {
  forcePanel.deny = lastResult.value
  forcePanel.show = true
}
async function confirmForce() {
  if (!forcePanel.reason.trim()) return flash('强制放行必须填写原因并留痕', false)
  gateForm.code = forcePanel.deny?.badge?.code || gateForm.code
  await submitVerify(true)
}
function quickFill(code) { gateForm.code = code; codeInput.value?.focus() }

// 便捷：取一张演示证件（各类型一张有效证 + 一张异常证）
const demoCodes = computed(() => {
  const pick = t => store.badges.find(b => b.subject_type === t && b.status === 'active')
  return [pick('team'), pick('athlete'), pick('referee'), pick('staff')].filter(Boolean)
})

/* ---------- 证件管理 ---------- */
const badgeFilter = ref('all')
const filteredBadges = computed(() => store.badges.filter(b => {
  if (badgeFilter.value === 'all') return true
  if (badgeFilter.value === 'blocked') return b.status === 'blocked'
  return b.subject_type === badgeFilter.value
}))
const badgeStatusText = b => {
  if (b.status === 'blocked') return b.block_manual ? '人工暂扣' : (b.block_reason || '资格失效停用')
  return '有效'
}
async function doBlock(b) {
  const reason = prompt(`暂扣证件 ${b.code}（${b.name}），请填写原因并留痕：`, '违反赛场纪律')
  if (reason == null) return
  if (!reason.trim()) return flash('暂扣原因不能为空', false)
  try { await store.blockBadge(b.id, reason.trim()); flash('证件已暂扣，该证入场将被拦截') }
  catch (e) { flash(e.message, false) }
}
async function doUnblock(b) {
  try { await store.unblockBadge(b.id, '核查无误，解除暂扣'); flash('证件已解除暂扣并按当前资格重新同步') }
  catch (e) { flash(e.message, false) }
}
async function doSync() {
  try { await store.syncBadges('组委会'); flash('已按最新资格与赛程全量同步证件授权') }
  catch (e) { flash(e.message, false) }
}

// 新增场地工作人员
const staffForm = reactive({ name: '', role: '志愿者', venue_id: '', phone: '' })
async function addStaff() {
  if (!staffForm.name.trim()) return flash('工作人员姓名不能为空', false)
  if (!staffForm.venue_id) return flash('请选择服务场地', false)
  try {
    await store.addStaff({ name: staffForm.name.trim(), role: staffForm.role, venue_id: Number(staffForm.venue_id), phone: staffForm.phone.trim() })
    staffForm.name = ''; staffForm.phone = ''
    flash('工作人员已录入并发放证件')
  } catch (e) { flash(e.message, false) }
}

/* ---------- 场次入场 ---------- */
const accessOf = mid => store.matchAccess.find(m => m.match_id === mid)
function crewReadyPct(m) { return m.crew_total ? Math.round(m.crew_checked / m.crew_total * 100) : 100 }

/* ---------- 流水 / 审计 ---------- */
const logFilter = ref('danger')
const filteredLogs = computed(() => store.accessLogs.filter(l => {
  if (logFilter.value === 'all') return true
  if (logFilter.value === 'danger') return l.severity === 'danger'
  if (logFilter.value === 'warn') return l.severity === 'warn'
  return l.action === logFilter.value
}))
const LOG_META = {
  issue: { text: '发证', tag: 'b' }, sync: { text: '同步', tag: 'gray' },
  block: { text: '暂扣', tag: 'r' }, unblock: { text: '解除暂扣', tag: 'g' },
  deny: { text: '拒绝入场', tag: 'r' }, force_pass: { text: '强制放行', tag: 'y' },
  pass: { text: '放行', tag: 'g' },
  incident_pause: { text: '事件暂停', tag: 'r' }, incident_resume: { text: '事件恢复', tag: 'g' },
  incident_reschedule: { text: '事件改期', tag: 'y' }
}

const access = computed(() => store.overview?.access || {})
const matchBrief = id => {
  const m = store.matches.find(x => x.id === id)
  if (!m) return ''
  const sp = store.sports.find(s => s.id === m.sport_id)?.name || ''
  return `${sp}·${m.stage}${m.group_name || ''} ${m.teamA?.name || ''}VS${m.teamB?.name || ''}`
}
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>🪪 赛事证件与入场核验</h2><div class="sub">运动员 · 裁判 · 场地工作人员按资格与赛程获得动态权限 · 核验结果回写报名 / 排班 / 比赛 / 异常审计</div></div>
      <div class="filters">
        <button class="chip" :class="{ on: tab === 'gate' }" @click="tab = 'gate'">🎫 入场核验<span v-if="access.today_deny" class="dot-badge">{{ access.today_deny }}</span></button>
        <button class="chip" :class="{ on: tab === 'badges' }" @click="tab = 'badges'">🪪 证件管理</button>
        <button class="chip" :class="{ on: tab === 'matches' }" @click="tab = 'matches'">🏟️ 场次入场</button>
        <button class="chip" :class="{ on: tab === 'records' }" @click="tab = 'records'">📋 核验流水</button>
        <button class="chip" :class="{ on: tab === 'audit' }" @click="tab = 'audit'">⚠️ 异常审计<span v-if="access.today_deny + access.today_forced" class="dot-badge">{{ access.today_deny + access.today_forced }}</span></button>
      </div>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>

    <!-- 顶部统计 -->
    <div class="grid" style="grid-template-columns:repeat(6,1fr)">
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#22c15e,#7edda4)"></span><span class="ic">🪪</span><b>{{ access.badges_active }}</b><em>有效证件</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#dd5b5b,#f0a1a1)"></span><span class="ic">🚫</span><b>{{ access.badges_blocked }}</b><em>停用/暂扣</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#2f9bff,#79c4ff)"></span><span class="ic">✅</span><b>{{ access.today_pass }}</b><em>今日放行</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#e5484d,#f0a1a1)"></span><span class="ic">⛔</span><b>{{ access.today_deny }}</b><em>今日拦截</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ffb92b,#ffd98a)"></span><span class="ic">⚠️</span><b>{{ access.today_forced }}</b><em>强制放行</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ff7a2f,#ffb27e)"></span><span class="ic">🏟️</span><b>{{ access.matches_not_ready }}/{{ access.scheduled_matches }}</b><em>双方未齐到场</em></div>
    </div>

    <!-- ============ Tab 1：入场核验 ============ -->
    <template v-if="tab === 'gate'">
      <div class="grid g2 mt">
        <div class="card">
          <div class="caption"><span>🎫 扫码核验口</span><span class="hint">资格 + 赛程实时判定动态权限</span></div>
          <div class="pad">
            <div class="form-row">
              <label>证件编号</label>
              <input ref="codeInput" v-model="gateForm.code" placeholder="如 T-0001 / R-0003 / S-0002" @keyup.enter="submitVerify(false)" style="flex:1;font-family:Consolas,monospace;font-weight:700;letter-spacing:1px;text-transform:uppercase" />
            </div>
            <div class="form-row">
              <label>核验场次</label>
              <select v-model="gateForm.match_id" @change="pickMatch(gateForm.match_id)" style="flex:1">
                <option value="">不指定（按赛程自动匹配）</option>
                <option v-for="m in gateMatches" :key="m.match_id" :value="m.match_id">{{ m.is_paused ? '⏸️ ' : '' }}{{ m.title }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>核验场地</label>
              <select v-model="gateForm.venue_id" style="flex:1">
                <option value="">不限场地</option>
                <option v-for="v in store.venues" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
            </div>
            <div class="form-row">
              <label>检票员</label>
              <input v-model="gateForm.operator" placeholder="检票员姓名" style="flex:1" />
            </div>
            <div class="row spread mt8">
              <span class="hint">快速选证演示：
                <button v-for="b in demoCodes" :key="b.id" class="mini" @click="quickFill(b.code)">{{ SUBJECT_ICON[b.subject_type] }} {{ b.code }}</button>
              </span>
              <button class="btn primary" @click="submitVerify(false)">🔍 核验入场</button>
            </div>
          </div>
        </div>

        <!-- 核验结果 -->
        <div class="card">
          <div class="caption"><span>📺 核验结果</span></div>
          <div class="pad">
            <div v-if="!lastResult" class="empty" style="padding:40px">扫码或输入证件编号开始核验</div>
            <template v-else>
              <div :class="['result-box', lastResult.pass ? (lastResult.result === 'forced_pass' ? 'warn' : 'ok') : 'deny']">
                <div class="rb-head">
                  <span class="rb-icon">{{ lastResult.pass ? (lastResult.result === 'forced_pass' ? '⚠️' : '✅') : '⛔' }}</span>
                  <b>{{ lastResult.duplicate ? '重复核验' : (lastResult.pass ? (lastResult.result === 'forced_pass' ? '强制放行' : '核验通过') : '禁止入场') }}</b>
                  <span v-if="lastResult.badge" class="mono" style="font-weight:700">{{ lastResult.badge.code }}</span>
                </div>
                <div class="rb-name">{{ lastResult.badge?.name }}<span v-if="lastResult.role" class="tag gray" style="margin-left:8px">{{ lastResult.role }}</span></div>
                <div class="rb-msg">{{ lastResult.message || lastResult.reason }}</div>
                <div v-if="lastResult.zones_text" class="rb-zones">授权区域：<b>{{ lastResult.zones_text }}</b></div>
                <div v-if="lastResult.match" class="rb-match">🏟️ {{ lastResult.match }}</div>
              </div>
              <div v-if="!lastResult.pass" class="row mt16 spread">
                <span class="tag r">已写入异常审计 · 该场异常计数 +1</span>
                <button v-if="lastResult.badge" class="btn sm" style="background:#fff6dd;color:#c98a00;border:1px solid #f0d68a" @click="showForce">✍️ 值班主任强制放行（必填原因留痕）</button>
                <span v-else class="hint">无法识别的证件不能强制放行，请核验证件来源</span>
              </div>
              <div v-if="forcePanel.show" class="act-panel mt8">
                <textarea v-model="forcePanel.reason" rows="2" placeholder="强制放行原因（必填，将写入异常审计与核验流水）" style="width:100%"></textarea>
                <div class="row" style="justify-content:flex-end;margin-top:8px">
                  <button class="btn ghost sm" @click="forcePanel.show = false">取消</button>
                  <button class="btn primary sm" :disabled="!forcePanel.reason.trim()" @click="confirmForce">确认强制放行</button>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- 最近核验流水 -->
      <div class="card mt">
        <div class="caption"><span>🕐 最近核验记录</span><span class="hint">同证同日同场重复扫码自动识别，不重复回写</span></div>
        <div class="pad">
          <table>
            <thead><tr><th>时间</th><th>证件</th><th>持证人</th><th>类型</th><th>场次/场地</th><th>结果</th><th>说明</th><th>检票员</th></tr></thead>
            <tbody>
              <tr v-for="c in store.checkins.slice(0, 8)" :key="c.id">
                <td class="mono ph" style="white-space:nowrap">{{ c.created_at }}</td>
                <td class="mono" style="font-weight:700">{{ c.badge_code || '—' }}</td>
                <td><b>{{ c.subject_name }}</b></td>
                <td><span class="tag gray">{{ SUBJECT_TEXT[c.subject_type] || '未知' }}</span></td>
                <td class="ph" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ matchBrief(c.match_id) }}{{ c.match_id && c.venue_name ? ' · ' : '' }}{{ c.venue_name || '' }}</td>
                <td><span class="tag" :class="RESULT_META[c.result]?.tag">{{ c.is_duplicate ? '🔁 重复核验' : RESULT_META[c.result]?.text }}</span></td>
                <td class="ph" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ c.reason || '—' }}</td>
                <td>{{ c.operator }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ============ Tab 2：证件管理 ============ -->
    <template v-else-if="tab === 'badges'">
      <div class="card">
        <div class="caption">
          <span>🪪 赛事证件名册 <span class="hint">授权区域按资格/岗位/赛程动态生成</span></span>
          <div class="row">
            <div class="filters">
              <button class="chip" :class="{ on: badgeFilter === 'all' }" @click="badgeFilter = 'all'">全部</button>
              <button v-for="(t, k) in SUBJECT_TEXT" :key="k" class="chip" :class="{ on: badgeFilter === k }" @click="badgeFilter = k">{{ t }}</button>
              <button class="chip" :class="{ on: badgeFilter === 'blocked' }" @click="badgeFilter = 'blocked'">停用/暂扣</button>
            </div>
            <button class="btn primary sm" @click="doSync">🔄 全量同步资格</button>
          </div>
        </div>
        <div class="pad">
          <table>
            <thead><tr><th>证件号</th><th>持证人</th><th>类型</th><th>单位/服务场地</th><th>项目</th><th>授权区域</th><th>状态</th><th>最近核验</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="b in filteredBadges" :key="b.id" :class="{ blockedrow: b.status === 'blocked' }">
                <td class="mono" style="font-weight:800;color:var(--accent3)">{{ b.code }}</td>
                <td><b>{{ b.name }}</b><div class="ph" style="font-size:11px">{{ b.subject?.level || b.subject?.role || '' }}</div></td>
                <td>{{ SUBJECT_ICON[b.subject_type] }} {{ SUBJECT_TEXT[b.subject_type] }}</td>
                <td>
                  <span v-if="b.unit" class="badge"><span class="dot" :style="{ background: b.unit.color }"></span>{{ b.unit.name }}</span>
                  <span v-else-if="b.subject?.venue_name" class="tag b">📍 {{ b.subject.venue_name }}</span>
                  <span v-else class="ph">—</span>
                </td>
                <td class="ph">{{ b.sport?.name || (b.subject_type === 'staff' ? '—' : '—') }}</td>
                <td>
                  <span v-for="z in b.zones" :key="z" class="tag g" style="margin-right:4px">{{ ZONE_TEXT[z] }}</span>
                  <span v-if="!b.zones.length" class="tag r">无授权</span>
                </td>
                <td><span class="tag" :class="b.status === 'active' ? 'g' : 'r'">{{ badgeStatusText(b) }}</span></td>
                <td class="ph" style="font-size:11px;white-space:nowrap">{{ b.last_checkin_at || '未核验' }}<span v-if="b.checkin_count"> · {{ b.checkin_count }}次</span></td>
                <td>
                  <button v-if="b.status === 'active'" class="mini danger" @click="doBlock(b)">暂扣</button>
                  <button v-else class="mini" style="color:var(--accent2);border-color:#bfe8cd" @click="doUnblock(b)">解除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!filteredBadges.length" class="empty">暂无证件</div>
        </div>
      </div>

      <!-- 场地工作人员录入 -->
      <div class="card mt">
        <div class="caption"><span>🛠️ 录入场地工作人员</span><span class="hint">岗位决定授权区域：场地主管/医疗/安保→比赛区+工作区，器材→热身区+工作区，媒体→媒体区，志愿者→工作区</span></div>
        <div class="pad row wrap" style="gap:10px">
          <input v-model="staffForm.name" placeholder="姓名" style="width:120px" />
          <select v-model="staffForm.role" style="width:120px">
            <option v-for="r in STAFF_ROLES" :key="r" :value="r">{{ r }}</option>
          </select>
          <select v-model="staffForm.venue_id" style="width:150px">
            <option value="" disabled>服务场地</option>
            <option v-for="v in store.venues" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
          <input v-model="staffForm.phone" placeholder="联系电话（选填）" style="width:150px" />
          <button class="btn primary sm" @click="addStaff">录入并发证</button>
        </div>
      </div>
    </template>

    <!-- ============ Tab 3：场次入场 ============ -->
    <template v-else-if="tab === 'matches'">
      <div class="card">
        <div class="caption"><span>🏟️ 各场次到场与到岗情况</span><span class="hint">核验结果实时回写比赛：双方到场 · 执法到岗 · 异常拦截</span></div>
        <div class="pad" style="display:flex;flex-direction:column;gap:12px">
          <div v-for="m in store.matchAccess" :key="m.match_id" class="mcard" :class="{ done: m.status === 'finished', paused: m.is_paused }">
            <div class="mheader">
              <span><b>{{ m.title }}</b></span>
              <span>⏱ {{ m.time_label }} · 📍 {{ m.venue }}
                <span v-if="m.is_paused" class="tag r" style="margin-left:8px">⏸️ 安全事件暂停{{ m.pause_incident_code ? '（' + m.pause_incident_code + '）' : '' }}</span>
                <span v-else class="tag" :class="m.status === 'finished' ? 'g' : 'o'" style="margin-left:8px">{{ m.status === 'finished' ? '已完赛' : '待赛' }}</span>
              </span>
            </div>
            <div v-if="m.is_paused" class="pause-tip">🚑 {{ m.pause_reason || '该场次因安全事件暂停' }}，入场核验与比分录入已锁定，恢复或改期后自动放行</div>
            <div class="att-grid">
              <div class="att-item">
                <span class="tag" :class="m.team_a.checked_in ? 'g' : 'o'">{{ m.team_a.checked_in ? '✅ 已到场' : '⏳ 未到场' }}</span>
                <b>{{ m.team_a.name }}</b>
                <span class="ph" style="font-size:11px">{{ m.team_a.at || '' }}</span>
              </div>
              <div class="att-item">
                <span class="tag" :class="m.team_b.checked_in ? 'g' : 'o'">{{ m.team_b.checked_in ? '✅ 已到场' : '⏳ 未到场' }}</span>
                <b>{{ m.team_b.name }}</b>
                <span class="ph" style="font-size:11px">{{ m.team_b.at || '' }}</span>
              </div>
              <div class="att-item crew">
                <div class="row spread"><span class="tag" :class="m.crew_checked >= m.crew_total && m.crew_total ? 'g' : 'o'">🧑‍⚖️ 执法到岗 {{ m.crew_checked }}/{{ m.crew_total }}</span><span v-if="m.denied" class="tag r">⛔ 异常拦截 {{ m.denied }}</span></div>
                <div class="hbar" style="margin-top:6px"><i :style="{ width: crewReadyPct(m) + '%', background: crewReadyPct(m) === 100 ? 'var(--accent2)' : 'var(--accent)' }"></i></div>
                <div class="crew-att" style="margin-top:6px">
                  <span v-for="c in m.crew" :key="c.id" class="tag" :class="c.checked_in ? 'g' : 'gray'" style="margin:2px">{{ c.role_name }}·{{ c.name }}{{ c.checked_in ? ' ✔' : '' }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!store.matchAccess.length" class="empty">暂无有效场次</div>
        </div>
      </div>
    </template>

    <!-- ============ Tab 4：核验流水 ============ -->
    <template v-else-if="tab === 'records'">
      <div class="card">
        <div class="caption"><span>📋 入场核验流水</span><span class="hint">共 {{ store.checkins.length }} 条（放行/拒绝/强制放行/重复核验全量留存）</span></div>
        <div class="pad">
          <table>
            <thead><tr><th>时间</th><th>证件号</th><th>持证人</th><th>类型/角色</th><th>场地</th><th>核验口</th><th>结果</th><th>原因码</th><th>说明</th><th>检票员</th></tr></thead>
            <tbody>
              <tr v-for="c in store.checkins" :key="c.id">
                <td class="mono ph" style="white-space:nowrap">{{ c.created_at }}</td>
                <td class="mono" style="font-weight:700">{{ c.badge_code || '—' }}</td>
                <td><b>{{ c.subject_name }}</b></td>
                <td><span class="tag gray">{{ SUBJECT_TEXT[c.subject_type] || '未知' }}</span><span v-if="c.role_snapshot" class="ph"> · {{ c.role_snapshot }}</span></td>
                <td>{{ c.venue_name || '—' }}</td>
                <td class="ph">{{ c.gate || '—' }}</td>
                <td><span class="tag" :class="RESULT_META[c.result]?.tag">{{ c.is_duplicate ? '🔁 重复' : RESULT_META[c.result]?.text }}</span></td>
                <td class="mono ph" style="font-size:11px">{{ c.reason_code || '—' }}</td>
                <td class="ph" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ c.reason || '—' }}</td>
                <td>{{ c.operator }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="!store.checkins.length" class="empty">暂无核验记录</div>
        </div>
      </div>
    </template>

    <!-- ============ Tab 5：异常审计 ============ -->
    <template v-else>
      <div class="card">
        <div class="caption">
          <span>⚠️ 证件与入场异常审计</span>
          <div class="filters">
            <button class="chip" :class="{ on: logFilter === 'danger' }" @click="logFilter = 'danger'">⛔ 危险（拦截/暂扣）</button>
            <button class="chip" :class="{ on: logFilter === 'warn' }" @click="logFilter = 'warn'">⚠️ 预警（强制放行）</button>
            <button class="chip" :class="{ on: logFilter === 'all' }" @click="logFilter = 'all'">全部留痕</button>
          </div>
        </div>
        <div class="pad">
          <table>
            <thead><tr><th>时间</th><th>操作</th><th>证件</th><th>详情</th><th>原因</th><th>经办人</th></tr></thead>
            <tbody>
              <tr v-for="l in filteredLogs" :key="l.id" :class="{ dangerrow: l.severity === 'danger' }">
                <td class="mono ph" style="white-space:nowrap">{{ l.created_at }}</td>
                <td><span class="tag" :class="LOG_META[l.action]?.tag">{{ LOG_META[l.action]?.text || l.action }}</span></td>
                <td class="mono">{{ l.badge_code || '—' }}</td>
                <td>{{ l.detail }}</td>
                <td class="ph" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ l.reason || '—' }}</td>
                <td><b>{{ l.operator }}</b></td>
              </tr>
            </tbody>
          </table>
          <div v-if="!filteredLogs.length" class="empty">暂无异常记录</div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dot-badge { background: #e5484d; color: #fff; border-radius: 20px; font-size: 10px; padding: 1px 6px; margin-left: 4px; }
.form-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.form-row label { width: 72px; flex-shrink: 0; font-size: 12px; color: var(--muted); font-weight: 700; }
.result-box { border-radius: 14px; padding: 22px; text-align: center; border: 2px solid; }
.result-box.ok { background: linear-gradient(180deg,#f2fdf5,#fff); border-color: #bfe8cd; }
.result-box.deny { background: linear-gradient(180deg,#fff5f5,#fff); border-color: #f0a1a1; }
.result-box.warn { background: linear-gradient(180deg,#fff9ec,#fff); border-color: #f0d68a; }
.rb-head { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 18px; }
.rb-icon { font-size: 30px; }
.rb-name { margin: 10px 0 4px; font-size: 16px; font-weight: 800; }
.rb-msg { color: var(--muted); font-size: 13px; }
.rb-zones { margin-top: 8px; font-size: 13px; color: var(--ink); }
.rb-match { margin-top: 6px; font-size: 12px; color: var(--accent3); font-weight: 600; }
.act-panel { padding: 10px; background: var(--bg2); border-radius: 10px; }
.att-grid { display: grid; grid-template-columns: 1fr 1fr 1.4fr; gap: 12px; margin-top: 8px; }
.att-item { display: flex; flex-direction: column; gap: 4px; background: var(--bg2); border-radius: 10px; padding: 9px 12px; }
.att-item.crew { background: #fbfcfe; }
.blockedrow { background: #fff8f8; }
.blockedrow td { color: var(--muted); }
.dangerrow { background: #fff8f8; }
.paused { border-color: #f0a1a1 !important; background: linear-gradient(180deg,#fff8f8,#fff) !important; }
.pause-tip { margin-top: 8px; font-size: 12px; color: #b3186e; background: #fff0f6; border: 1px solid #f3c9dd; border-radius: 8px; padding: 6px 10px; }
.mini { background: #fff; border: 1px solid var(--line); border-radius: 7px; font-size: 11px; padding: 2px 7px; color: var(--muted); }
.mini:hover { border-color: var(--accent); color: var(--accent); }
.mini.danger:hover { border-color: #e5484d; color: #e5484d; }
</style>
