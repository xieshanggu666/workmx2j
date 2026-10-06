<script setup>
import { ref, computed, reactive } from 'vue'
import { useEventStore } from '@/store/event'
const store = useEventStore()

const toast = ref('')
function flash(msg, ok = true) { toast.value = (ok ? '' : '⚠️ ') + msg; setTimeout(() => toast.value = '', 3800) }

const CAT_META = {
  injury: { icon: '🩺', text: '伤病急救' },
  security: { icon: '🚨', text: '治安事件' },
  dispute: { icon: '🥊', text: '冲突纠纷' },
  facility: { icon: '🛠️', text: '场地器材' },
  weather: { icon: '🌩️', text: '天气突发' },
  other: { icon: '📌', text: '其他' }
}
const ROLE_META = {
  medical: { icon: '🩺', text: '医疗', tag: 'g' },
  security: { icon: '🚨', text: '安保', tag: 'r' },
  referee: { icon: '🧑‍⚖️', text: '裁判', tag: 'b' },
  organizer: { icon: '🎛️', text: '组委会', tag: 'o' }
}
const SEV_META = {
  major: { tag: 'r', text: '重大' },
  general: { tag: 'y', text: '较大' },
  minor: { tag: 'b', text: '一般' }
}
const STATUS_META = {
  pending: { tag: 'o', text: '待分级' },
  handling: { tag: 'r', text: '处置中' },
  resolved: { tag: 'y', text: '待结案' },
  closed: { tag: 'g', text: '已结案' }
}
const ACTION_META = {
  submit: { tag: 'gray', text: '上报' }, triage: { tag: 'o', text: '分级派单' }, progress: { tag: 'b', text: '协同进展' },
  badge_block: { tag: 'r', text: '暂扣证件' }, badge_release: { tag: 'g', text: '解除暂扣' },
  match_pause: { tag: 'r', text: '暂停场次' }, match_resume: { tag: 'g', text: '恢复场次' }, match_reschedule: { tag: 'y', text: '场次改期' },
  resolve: { tag: 'y', text: '处置完成' }, reopen: { tag: 'o', text: '重新处置' }, close: { tag: 'g', text: '结案归档' }
}

const counts = computed(() => {
  const c = { pending: 0, handling: 0, resolved: 0, closed: 0, major: 0 }
  store.incidents.forEach(i => { c[i.status]++; if (i.severity === 'major' && i.status !== 'closed') c.major++ })
  return c
})

/* ---------- 协同上报 ---------- */
const form = reactive({ category: 'injury', reporter_role: 'medical', reporter_name: '', venue_id: '', match_id: '', description: '' })
function resetForm() { form.reporter_name = ''; form.venue_id = ''; form.match_id = ''; form.description = '' }
// 选择场次时自动带出比赛场地
function pickVenueByMatch() {
  const m = store.matches.find(x => x.id === Number(form.match_id))
  if (m?.venue_id) form.venue_id = String(m.venue_id)
}
async function submit() {
  if (!form.description.trim()) return flash('请描述事件经过', false)
  try {
    const r = await store.reportIncident({
      category: form.category, reporter_role: form.reporter_role,
      reporter_name: form.reporter_name.trim(),
      venue_id: form.venue_id ? Number(form.venue_id) : null,
      match_id: form.match_id ? Number(form.match_id) : null,
      description: form.description.trim()
    })
    flash(`✅ 事件已上报（编号 ${r.code}），等待组委会分级派单`)
    resetForm()
    statusFilter.value = 'all'
  } catch (e) { flash(e.message, false) }
}

/* ---------- 列表筛选 ---------- */
const statusFilter = ref('all')
const list = computed(() => store.incidents.filter(i => statusFilter.value === 'all' || i.status === statusFilter.value))

/* ---------- 卡片操作面板 ---------- */
const acting = ref(null)
const panel = ref('')
function openPanel(id, mode) { acting.value = id; panel.value = mode }
function closePanel() { acting.value = null; panel.value = '' }
const cur = computed(() => store.incidents.find(i => i.id === acting.value))

// 分级派单
const triage = reactive({ severity: 'general', lead: 'organizer', dispatch_note: '', operator: '组委会值班' })
function openTriage(i) { openPanel(i.id, 'triage'); triage.severity = 'general'; triage.lead = 'organizer'; triage.dispatch_note = '' }
async function submitTriage(i) {
  try { await store.triageIncident(i.id, { ...triage }); flash(`✅ ${i.code} 已分级为「${SEV_META[triage.severity].text}」，${ROLE_META[triage.lead].text}牵头处置`); closePanel() }
  catch (e) { flash(e.message, false) }
}

// 协同进展
const prog = reactive({ role: 'organizer', operator: '', note: '' })
function openProgress(i) { openPanel(i.id, 'progress'); prog.role = i.lead || 'organizer'; prog.operator = ''; prog.note = '' }
async function submitProgress(i) {
  if (!prog.note.trim()) return flash('请填写处置进展', false)
  try { await store.progressIncident(i.id, { role: prog.role, operator: prog.operator.trim() || ROLE_META[prog.role].text, note: prog.note.trim() }); flash('✅ 协同进展已记录'); closePanel() }
  catch (e) { flash(e.message, false) }
}

// 暂扣证件
const blockF = reactive({ badge_id: '', reason: '', role: 'security' })
function openBlock(i) { openPanel(i.id, 'block'); blockF.badge_id = ''; blockF.reason = ''; blockF.role = i.lead || 'security' }
async function submitBlock(i) {
  if (!blockF.badge_id) return flash('请选择要暂扣的证件', false)
  if (!blockF.reason.trim()) return flash('暂扣原因必填并留痕', false)
  try {
    await store.incidentBlockBadge(i.id, { badge_id: Number(blockF.badge_id), reason: blockF.reason.trim(), role: blockF.role })
    flash('🪪 证件已暂扣，该证入场将被拦截并计入异常审计'); closePanel()
  } catch (e) { flash(e.message, false) }
}
async function releaseLink(i, link) {
  if (!confirm(`确认解除证件 ${link.badge_code}（${link.badge_name}）的暂扣？解除后按当前资格重新同步。`)) return
  try { await store.incidentReleaseBadge(i.id, link.id, {}); flash('✅ 证件暂扣已解除') }
  catch (e) { flash(e.message, false) }
}

// 暂停场次
const pauseF = reactive({ match_id: '', reason: '' })
function openPause(i) { openPanel(i.id, 'pause'); pauseF.match_id = i.match_id || ''; pauseF.reason = '' }
async function submitPause(i) {
  if (!pauseF.match_id) return flash('请选择要暂停的场次', false)
  if (!pauseF.reason.trim()) return flash('暂停原因必填', false)
  try { await store.incidentPause(i.id, { match_id: Number(pauseF.match_id), reason: pauseF.reason.trim() }); flash('⏸️ 场次已暂停：入场核验与比分录入已锁定'); closePanel() }
  catch (e) { flash(e.message, false) }
}
// 恢复场次
async function resumeMatch(i, matchId) {
  if (!confirm('确认恢复该场次？恢复后入场核验放行、可正常录入比分。')) return
  try { await store.incidentResume(i.id, { match_id: matchId, note: '现场处置完毕，恢复比赛' }); flash('▶️ 场次已恢复') }
  catch (e) { flash(e.message, false) }
}
// 改期
const TIME_PRESETS = ['09:00', '09:20', '09:30', '09:40', '10:00', '10:20', '10:40', '11:00', '11:20', '12:30', '13:00', '14:00', '14:30', '15:30', '16:00', '16:30', '17:00']
const resched = reactive({ show: false, match_id: null, time_label: '', venue_id: '', reason: '', error: '', force: false })
function openReschedule(i, m) {
  const mm = m || store.matches.find(x => x.id === i.match_id)
  openPanel(i.id, 'reschedule')
  resched.match_id = mm?.id || null; resched.time_label = mm?.time_label || ''; resched.venue_id = mm?.venue_id || ''
  resched.reason = ''; resched.error = ''; resched.force = false
}
async function submitReschedule(i) {
  if (!resched.time_label.trim()) return flash('请填写改期时间', false)
  if (!resched.reason.trim()) return flash('改期原因必填并留痕', false)
  try {
    await store.incidentReschedule(i.id, {
      match_id: resched.match_id, time_label: resched.time_label.trim(),
      venue_id: resched.venue_id ? Number(resched.venue_id) : null,
      reason: resched.reason.trim(), force: resched.force
    })
    flash('📅 场次已改期，暂停同步解除，执法名单已自动重排/补齐'); closePanel()
  } catch (e) { resched.error = e.message; flash(e.message, false) }
}

// 处置完成 / 退回 / 结案
const resolveF = ref('')
function openResolve(i) { openPanel(i.id, 'resolve'); resolveF.value = '' }
async function submitResolve(i) {
  if (!resolveF.value.trim()) return flash('请填写处置完成说明', false)
  try { await store.resolveIncident(i.id, { note: resolveF.value.trim() }); flash('✅ 已标记处置完成，转入待结案'); closePanel() }
  catch (e) { flash(e.message, false) }
}
async function reopen(i) {
  try { await store.reopenIncident(i.id, {}); flash('↩️ 已退回处置中') }
  catch (e) { flash(e.message, false) }
}
const closeF = reactive({ summary: '', keep_blocked: false, keep_reason: '' })
function openClose(i) { openPanel(i.id, 'close'); closeF.summary = ''; closeF.keep_blocked = false; closeF.keep_reason = '' }
async function submitClose(i) {
  if (!closeF.summary.trim()) return flash('请填写结案总结', false)
  if (closeF.keep_blocked && !closeF.keep_reason.trim()) return flash('继续暂扣证件须注明原因', false)
  try {
    const r = await store.closeIncident(i.id, { summary: closeF.summary.trim(), keep_blocked: closeF.keep_blocked, keep_reason: closeF.keep_reason.trim() })
    flash(`📁 已结案归档${r.released ? `，统一解除暂扣证件 ${r.released} 张` : ''}`); closePanel()
  } catch (e) { flash(e.message, false) }
}

/* ---------- 展示辅助 ---------- */
function matchLabel(m) {
  if (!m) return ''
  const sp = store.sports.find(s => s.id === m.sport_id)?.name || ''
  return `${sp}·${m.stage}${m.group_name || ''} ${m.teamA?.name || '待定'} VS ${m.teamB?.name || '待定'}（${m.time_label || '时间待定'}）`
}
// 可暂停/改期场次：全部待赛场次（默认选中事件关联场次）
const scheduledMatches = computed(() => store.matches.filter(m => m.status === 'scheduled'))
// 事件仍在暂停中的场次
const pausedMatchesOf = i => store.matches.filter(m => m.pause_incident_id === i.id && m.is_paused)
// 可暂扣证件：有效证件优先；已暂扣标记
const badgeOptions = computed(() => store.badges)
const SUBJECT_TEXT = { team: '队伍', athlete: '运动员', referee: '裁判', staff: '工作人员' }
const badgeBrief = b => `${b.code} · ${b.name}（${SUBJECT_TEXT[b.subject_type] || ''}）${b.status === 'blocked' ? '｜已暂扣' : ''}`
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>🚑 赛事安全事件处置</h2><div class="sub">医疗 · 安保 · 裁判 · 组委会协同上报 → 分级派单 → 联动处置（证件暂扣 / 场次暂停改期）→ 结案，全程留痕并写入异常审计</div></div>
      <div v-if="toast" class="toast">{{ toast }}</div>
    </div>

    <!-- 统计卡 -->
    <div class="grid" style="grid-template-columns:repeat(6,1fr)">
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ff7a2f,#ffb27e)"></span><span class="ic">📥</span><b>{{ counts.pending }}</b><em>待分级</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#e5484d,#f0a1a1)"></span><span class="ic">🚨</span><b>{{ counts.handling }}</b><em>处置中</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ffb92b,#ffd98a)"></span><span class="ic">📝</span><b>{{ counts.resolved }}</b><em>待结案</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#22c15e,#7edda4)"></span><span class="ic">📁</span><b>{{ counts.closed }}</b><em>已结案</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#b3186e,#e06bb0)"></span><span class="ic">🔴</span><b :style="{ color: counts.major ? '#b3186e' : undefined }">{{ counts.major }}</b><em>未结重大事件</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#2f9bff,#79c4ff)"></span><span class="ic">⏸️</span><b>{{ store.overview?.incidents?.paused_matches || 0 }}</b><em>暂停中场次</em></div>
    </div>

    <div class="grid g2 mt">
      <!-- 协同上报 -->
      <div class="card">
        <div class="caption">📡 协同上报 <span class="hint">四方岗位发现事件随时上报</span></div>
        <div class="pad">
          <div class="form-row">
            <label>事件类型</label>
            <div class="filters">
              <button v-for="(m, key) in CAT_META" :key="key" class="chip sm-chip" :class="{ on: form.category === key }" @click="form.category = key">{{ m.icon }} {{ m.text }}</button>
            </div>
          </div>
          <div class="form-row">
            <label>上报岗位</label>
            <div class="filters">
              <button v-for="(m, key) in ROLE_META" :key="key" class="chip sm-chip" :class="{ on: form.reporter_role === key }" @click="form.reporter_role = key">{{ m.icon }} {{ m.text }}</button>
            </div>
          </div>
          <div class="form-row">
            <label>上报人</label>
            <input v-model="form.reporter_name" :placeholder="ROLE_META[form.reporter_role].text + '值班人员（选填）'" style="flex:1">
          </div>
          <div class="form-row">
            <label>事发场地</label>
            <select v-model="form.venue_id" style="flex:1">
              <option value="">不指定场地</option>
              <option v-for="v in store.venues" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>关联场次</label>
            <select v-model="form.match_id" @change="pickVenueByMatch" style="flex:1">
              <option value="">与场次无关 / 稍后关联</option>
              <option v-for="m in scheduledMatches" :key="m.id" :value="m.id">{{ matchLabel(m) }}</option>
            </select>
          </div>
          <div class="form-row" style="align-items:flex-start">
            <label style="margin-top:7px">事件经过</label>
            <textarea v-model="form.description" rows="3" placeholder="时间、地点、人员、现状与已采取措施……" style="flex:1;resize:vertical"></textarea>
          </div>
          <div class="row mt8" style="justify-content:flex-end">
            <button class="btn ghost sm" @click="resetForm">清空</button>
            <button class="btn primary" @click="submit">📡 上报安全事件</button>
          </div>
        </div>
      </div>

      <!-- 处置流程说明 -->
      <div class="card">
        <div class="caption">ℹ️ 协同处置流程与联动</div>
        <div class="pad rules">
          <p><span class="tag o">待分级</span> 任意岗位上报后，由组委会评估等级并派单：<span class="tag r">重大</span><span class="tag y">较大</span><span class="tag b">一般</span>，指定医疗/安保/裁判/组委会牵头。</p>
          <p>· <b>🩺 医疗</b>：伤病急救、转运与伤情反馈；<b>🚨 安保</b>：秩序控制、人员隔离与证件暂扣；<b>🧑‍⚖️ 裁判</b>：暂停/恢复比赛、裁判组调度；<b>🎛️ 组委会</b>：分级派单、改期决策与结案。</p>
          <p>· <b>🪪 证件暂扣</b>：联动证件体系人工暂扣，入场核验一律 <b>BADGE_BLOCKED</b> 拦截并计入异常审计；可在处置中解除，结案默认统一解除（可选择继续暂扣留痕）。</p>
          <p>· <b>⏸️ 场次暂停</b>：关联待赛场次立即锁定——入场核验拒绝（<span class="mono">MATCH_PAUSED</span>）、成绩录入锁定、普通改期入口锁定。</p>
          <p>· <b>📅 暂停改期</b>：复用赛程变更引擎（场地/裁判冲突检测、自动重排、无法解决整单回滚），成功后自动解除暂停并记录原档期。</p>
          <p>· <b>处置完成 → 待结案 → 组委会结案</b>：暂停场次未恢复/改期不得完成处置；仍有暂停场次不得结案；每一步均在 <b>BEGIN IMMEDIATE 单事务</b> 内完成、幂等可重放，全量写入安全事件审计。</p>
        </div>
      </div>
    </div>

    <!-- 事件案卷 -->
    <div class="card mt">
      <div class="caption">
        <span>🗂️ 事件案卷 <span class="hint">共 {{ list.length }} 件</span></span>
        <div class="filters">
          <button class="chip" :class="{ on: statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
          <button v-for="(meta, key) in STATUS_META" :key="key" class="chip" :class="{ on: statusFilter === key }">{{ meta.text }}</button>
        </div>
      </div>
      <div class="pad" style="display:flex;flex-direction:column;gap:12px">
        <div v-for="i in list" :key="i.id" class="icard" :class="[i.status, i.severity === 'major' && i.status !== 'closed' ? 'major' : '']">
          <div class="iheader">
            <span>
              <b class="mono" style="color:var(--accent3)">{{ i.code }}</b>
              <span class="tag" :class="SEV_META[i.severity]?.tag || 'gray'" style="margin-left:8px">{{ CAT_META[i.category].icon }} {{ CAT_META[i.category].text }}{{ i.severity ? ' · ' + SEV_META[i.severity].text : '' }}</span>
              <span v-if="i.lead" class="tag gray" style="margin-left:6px">牵头：{{ ROLE_META[i.lead].icon }} {{ ROLE_META[i.lead].text }}</span>
            </span>
            <span class="tag" :class="STATUS_META[i.status].tag">{{ STATUS_META[i.status].text }}</span>
          </div>

          <div class="idesc">💬 {{ i.description }}</div>
          <div class="imeta">
            <span><span class="tag" :class="ROLE_META[i.reporter_role].tag">{{ ROLE_META[i.reporter_role].icon }} {{ ROLE_META[i.reporter_role].text }}上报</span> {{ i.reporter_name }}</span>
            <span v-if="i.venue">📍 {{ i.venue.name }}</span>
            <span v-if="i.match">🏟️ {{ matchLabel(i.match) }}</span>
            <span>🕐 {{ i.reported_at }}</span>
          </div>

          <!-- 暂停场次横幅 -->
          <div v-for="m in pausedMatchesOf(i)" :key="'pm'+m.id" class="pause-banner">
            <span>⏸️ <b>{{ matchLabel(m) }}</b> 已暂停：{{ m.pause_reason }}</span>
            <span class="row">
              <button class="btn green sm" @click="resumeMatch(i, m.id)">▶️ 恢复</button>
              <button class="btn sm" style="background:#fff6dd;color:#c98a00" @click="openReschedule(i, m)">📅 改期</button>
            </span>
          </div>

          <!-- 联动状态 -->
          <div v-if="i.impact && (i.impact.badges_blocked || i.impact.matches_rescheduled || i.impact.badges_released || i.impact.matches_resumed)" class="impact-box">
            <div v-if="i.impact.badges_blocked" class="imp-row"><span class="tag r">🪪 暂扣中 {{ i.impact.badges_blocked }}</span>
              <span v-for="b in i.impact.badges.filter(x => x.status === 'active')" :key="b.badge_id" class="badge" style="margin-right:8px">{{ b.code }} {{ b.name }}</span>
            </div>
            <div v-if="i.impact.badges_released" class="imp-row"><span class="tag g">解除暂扣 {{ i.impact.badges_released }}</span></div>
            <div v-if="i.impact.matches_resumed" class="imp-row"><span class="tag g">▶️ 已恢复场次 {{ i.impact.matches_resumed }}</span></div>
            <div v-for="m in i.impact.rescheduled_matches" :key="'rs'+m.match_id" class="imp-row">
              <span class="tag y">📅 改期</span><b>{{ m.title }}</b>
              <span class="ph">{{ m.from_time || '时间待定' }} → {{ m.to_time || '时间待定' }}<template v-if="m.venue"> · {{ m.venue }}</template></span>
            </div>
          </div>

          <!-- 派单 / 处置 / 结案说明 -->
          <div v-if="i.dispatch_note" class="note-line">🎯 派单：{{ i.dispatch_note }}（{{ i.reviewer }} · {{ i.triaged_at }}）</div>
          <div v-if="i.resolution_note && i.status !== 'closed'" class="note-line ok">✅ 处置说明：{{ i.resolution_note }}</div>
          <div v-if="i.close_summary" class="note-line ok">📁 结案总结：{{ i.close_summary }}（{{ i.reviewer }} · {{ i.closed_at }}）</div>

          <!-- 操作按钮 -->
          <div v-if="i.status !== 'closed'" class="row mt8" style="justify-content:flex-end;gap:6px;flex-wrap:wrap">
            <template v-if="i.status === 'pending'">
              <button class="btn primary sm" @click="openTriage(i)">🎯 分级派单</button>
            </template>
            <template v-else>
              <button class="btn sm" style="background:#e8f2ff;color:var(--accent3)" @click="openProgress(i)">📝 协同进展</button>
              <button class="btn sm" style="background:#ffecec;color:#e5484d" @click="openBlock(i)">🪪 暂扣证件</button>
              <button v-if="!pausedMatchesOf(i).length" class="btn sm" style="background:#fff1e6;color:var(--accent)" @click="openPause(i)">⏸️ 暂停场次</button>
              <template v-if="i.status === 'handling'">
                <button class="btn green sm" @click="openResolve(i)">✅ 处置完成</button>
              </template>
              <template v-else-if="i.status === 'resolved'">
                <button class="btn ghost sm" @click="reopen(i)">↩️ 退回处置</button>
                <button class="btn primary sm" @click="openClose(i)">📁 复核结案</button>
              </template>
            </template>
          </div>

          <!-- 操作面板 -->
          <div v-if="acting === i.id" class="act-panel">
            <!-- 分级派单 -->
            <template v-if="panel === 'triage'">
              <div class="corr-box">
                <div class="corr-title">🎯 事件分级与派单</div>
                <div class="row" style="gap:6px;flex-wrap:wrap">
                  等级：
                  <button v-for="(m, key) in SEV_META" :key="key" class="chip sm-chip" :class="{ on: triage.severity === key, sev: true }" @click="triage.severity = key">{{ m.text }}</button>
                </div>
                <div class="row" style="gap:6px;flex-wrap:wrap">
                  牵头：
                  <button v-for="(m, key) in ROLE_META" :key="key" class="chip sm-chip" :class="{ on: triage.lead === key }" @click="triage.lead = key">{{ m.icon }} {{ m.text }}</button>
                </div>
              </div>
              <input v-model="triage.operator" placeholder="分级经办（默认组委会值班）">
              <textarea v-model="triage.dispatch_note" rows="2" placeholder="派单说明：响应要求、协同分工（选填）"></textarea>
              <div class="row" style="justify-content:flex-end;gap:6px">
                <button class="btn ghost sm" @click="closePanel">取消</button>
                <button class="btn primary sm" @click="submitTriage(i)">确认分级派单</button>
              </div>
            </template>

            <!-- 协同进展 -->
            <template v-else-if="panel === 'progress'">
              <div class="row" style="gap:6px">
                <select v-model="prog.role" style="width:130px">
                  <option v-for="(m, key) in ROLE_META" :key="key" :value="key">{{ m.icon }} {{ m.text }}</option>
                </select>
                <input v-model="prog.operator" placeholder="经办人（选填）">
              </div>
              <textarea v-model="prog.note" rows="2" placeholder="处置进展 / 现场情况 / 协同请求"></textarea>
              <div class="row" style="justify-content:flex-end;gap:6px">
                <button class="btn ghost sm" @click="closePanel">取消</button>
                <button class="btn sm" style="background:#e8f2ff;color:var(--accent3)" @click="submitProgress(i)">记录进展</button>
              </div>
            </template>

            <!-- 暂扣证件 -->
            <template v-else-if="panel === 'block'">
              <div class="corr-box">
                <div class="corr-title">🪪 暂扣赛事证件（联动入场拦截 + 异常审计）</div>
                <select v-model="blockF.badge_id">
                  <option value="" disabled>选择证件</option>
                  <option v-for="b in badgeOptions" :key="b.id" :value="b.id">{{ badgeBrief(b) }}</option>
                </select>
                <input v-model="blockF.reason" placeholder="暂扣原因（必填，写入证件审计与事件留痕）">
              </div>
              <div class="row" style="justify-content:flex-end;gap:6px">
                <button class="btn ghost sm" @click="closePanel">取消</button>
                <button class="btn sm" style="background:#ffecec;color:#e5484d" @click="submitBlock(i)">确认暂扣</button>
              </div>
            </template>

            <!-- 暂停场次 -->
            <template v-else-if="panel === 'pause'">
              <div class="corr-box">
                <div class="corr-title">⏸️ 暂停场次（入场核验与比分录入立即锁定）</div>
                <select v-model="pauseF.match_id">
                  <option value="" disabled>选择场次</option>
                  <option v-for="m in scheduledMatches" :key="m.id" :value="m.id">{{ matchLabel(m) }}</option>
                </select>
                <input v-model="pauseF.reason" placeholder="暂停原因（必填）">
              </div>
              <div class="row" style="justify-content:flex-end;gap:6px">
                <button class="btn ghost sm" @click="closePanel">取消</button>
                <button class="btn sm" style="background:#ffecec;color:#e5484d" @click="submitPause(i)">确认暂停</button>
              </div>
            </template>

            <!-- 改期 -->
            <template v-else-if="panel === 'reschedule'">
              <div class="corr-box">
                <div class="corr-title">📅 场次暂停改期（冲突自动重排，无法解决整单回滚）</div>
                <div class="row wrap" style="gap:10px">
                  <label>新时间
                    <input v-model="resched.time_label" list="inc-time-presets" placeholder="如 16:30" style="width:120px;margin-left:6px">
                    <datalist id="inc-time-presets"><option v-for="t in TIME_PRESETS" :key="t" :value="t" /></datalist>
                  </label>
                  <label>新场地
                    <select v-model="resched.venue_id" style="width:160px;margin-left:6px">
                      <option value="">未指定</option>
                      <option v-for="v in store.venues" :key="v.id" :value="v.id">{{ v.name }}</option>
                    </select>
                  </label>
                </div>
                <input v-model="resched.reason" placeholder="改期原因（必填）">
                <label class="row"><input type="checkbox" v-model="resched.force" /> 存在无法自动解决的冲突时强制保留并留痕（谨慎）</label>
                <div v-if="resched.error" class="conf-box">{{ resched.error }}</div>
              </div>
              <div class="row" style="justify-content:flex-end;gap:6px">
                <button class="btn ghost sm" @click="closePanel">取消</button>
                <button class="btn primary sm" @click="submitReschedule(i)">确认改期并解除暂停</button>
              </div>
            </template>

            <!-- 处置完成 -->
            <template v-else-if="panel === 'resolve'">
              <textarea v-model="resolveF" rows="2" placeholder="处置完成说明（必填）：现场结果、人员情况、遗留事项"></textarea>
              <div class="row" style="justify-content:flex-end;gap:6px">
                <button class="btn ghost sm" @click="closePanel">取消</button>
                <button class="btn green sm" @click="submitResolve(i)">完成处置，转待结案</button>
              </div>
            </template>

            <!-- 结案 -->
            <template v-else-if="panel === 'close'">
              <textarea v-model="closeF.summary" rows="2" placeholder="结案总结（必填）：事件结论、处置评估、改进措施"></textarea>
              <label class="row"><input type="checkbox" v-model="closeF.keep_blocked" /> 暂扣证件暂不解除（继续责任追究/纪律调查）</label>
              <input v-if="closeF.keep_blocked" v-model="closeF.keep_reason" placeholder="继续暂扣原因（必填，证件需在证件管理中人工解除）">
              <div class="row" style="justify-content:flex-end;gap:6px">
                <button class="btn ghost sm" @click="closePanel">取消</button>
                <button class="btn primary sm" @click="submitClose(i)">确认结案归档</button>
              </div>
            </template>
          </div>

          <!-- 暂扣证件清单（可逐项解除） -->
          <div v-if="i.badge_links?.length" class="badge-links">
            <div v-for="l in i.badge_links" :key="l.id" class="bl-row">
              <span class="tag" :class="l.status === 'active' ? 'r' : 'g'">{{ l.status === 'active' ? '暂扣中' : '已解除' }}</span>
              <b class="mono">{{ l.badge_code }}</b> {{ l.badge_name }}
              <span class="tag gray">{{ SUBJECT_TEXT[l.subject_type] }}</span>
              <span class="ph">{{ l.reason }}</span>
              <button v-if="l.status === 'active' && i.status !== 'closed'" class="mini" @click="releaseLink(i, l)">解除暂扣</button>
            </div>
          </div>

          <!-- 审计时间线 -->
          <div class="timeline">
            <div v-for="l in i.logs" :key="l.id" class="tl-item">
              <span class="tag" :class="ACTION_META[l.action]?.tag || 'gray'">{{ ACTION_META[l.action]?.text || l.action }}</span>
              <span v-if="l.role" class="tag gray">{{ ROLE_META[l.role]?.icon }} {{ ROLE_META[l.role]?.text }}</span>
              <span class="tl-detail">{{ l.detail }}</span>
              <span class="tl-time">{{ l.operator }} · {{ l.created_at }}</span>
            </div>
          </div>
        </div>
        <div v-if="!list.length" class="empty">暂无安全事件</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; }
.form-row label { width: 72px; flex-shrink: 0; font-size: 12px; color: var(--muted); font-weight: 700; padding-top: 7px; }
.sm-chip { padding: 4px 10px; font-size: 12px; }
.rules p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.8; color: var(--ink); }
.icard { border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; background: #fff; box-shadow: var(--shadow-sm); border-left: 4px solid var(--line); }
.icard.pending { border-left-color: var(--accent); }
.icard.handling { border-left-color: #e5484d; }
.icard.resolved { border-left-color: var(--gold); }
.icard.closed { border-left-color: var(--accent2); background: linear-gradient(180deg, #f6fdf8, #fff); }
.icard.major { box-shadow: 0 0 0 2px rgba(179, 24, 110, .12), var(--shadow-sm); }
.iheader { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; }
.idesc { font-size: 13.5px; margin-top: 8px; }
.imeta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted); margin-top: 7px; align-items: center; }
.pause-banner { margin-top: 10px; padding: 9px 12px; background: #fff5f5; border: 1px solid #f0a1a1; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; }
.impact-box { margin-top: 10px; padding: 10px 12px; background: #f7f9fc; border: 1px solid var(--line); border-radius: 10px; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; }
.imp-row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.note-line { font-size: 12px; color: var(--muted); margin-top: 8px; padding: 6px 10px; background: var(--bg2); border-radius: 8px; }
.note-line.ok { background: #f2fbf5; color: #207a47; }
.act-panel { margin-top: 10px; padding: 12px; background: var(--bg2); border-radius: 12px; display: flex; flex-direction: column; gap: 10px; }
.corr-box { background: #fff; border: 1px dashed var(--accent3); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 9px; }
.corr-title { font-weight: 800; font-size: 13px; }
.conf-box { background: #fff5f5; border: 1px solid #f0a1a1; border-radius: 8px; padding: 8px 10px; font-size: 12px; }
.badge-links { margin-top: 10px; display: flex; flex-direction: column; gap: 5px; }
.bl-row { display: flex; align-items: center; gap: 8px; font-size: 12px; background: var(--bg2); border-radius: 8px; padding: 6px 10px; flex-wrap: wrap; }
.mini { background: #fff; border: 1px solid var(--line); border-radius: 7px; font-size: 11px; padding: 2px 8px; color: var(--accent2); margin-left: auto; }
.mini:hover { border-color: var(--accent2); }
.timeline { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--line); display: flex; flex-direction: column; gap: 6px; }
.tl-item { display: flex; align-items: baseline; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.tl-detail { flex: 1; min-width: 200px; color: var(--ink); }
.tl-time { color: var(--muted); font-size: 11px; white-space: nowrap; }
</style>
