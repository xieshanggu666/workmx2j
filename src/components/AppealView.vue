<script setup>
import { ref, computed, reactive } from 'vue'
import { useEventStore } from '@/store/event'
const store = useEventStore()

const toast = ref('')
const showToast = msg => { toast.value = msg; setTimeout(() => toast.value = '', 3800) }

const STATUS_META = {
  pending: { tag: 'o', text: '待受理' },
  reviewing: { tag: 'b', text: '复核中' },
  upheld: { tag: 'g', text: '已改判' },
  rejected: { tag: 'r', text: '已驳回' },
  withdrawn: { tag: 'gray', text: '已撤案' }
}
const TYPE_META = {
  match: { icon: '🏀', text: '球类比分' },
  track: { icon: '🏃', text: '田径成绩' },
  eligibility: { icon: '🪪', text: '参赛资格' }
}
const ACTION_META = {
  submit: { tag: 'o', text: '提交申诉' }, accept: { tag: 'b', text: '受理立案' },
  reject: { tag: 'r', text: '驳回' }, withdraw: { tag: 'gray', text: '撤案' },
  uphold: { tag: 'g', text: '复核改判' }
}

const counts = computed(() => {
  const c = { pending: 0, reviewing: 0, upheld: 0, rejected: 0, withdrawn: 0 }
  store.appeals.forEach(a => { c[a.status] = (c[a.status] || 0) + 1 })
  return c
})

/* ---------- 提交申诉 ---------- */
const form = reactive({ target_type: 'match', target_id: null, unit_id: null, reason: '', contact: '', evidence: '' })
function resetForm() { form.target_id = null; form.reason = ''; form.contact = ''; form.evidence = '' }

// 可申诉对象：球类=已完赛非取消场次；田径=已录入成绩；资格=其它单位已通过报名
const appealableMatches = computed(() => store.matches
  .filter(m => m.status === 'finished' && m.teamA && m.teamB)
  .sort((a, b) => b.id - a.id))
const appealableEntries = computed(() => store.entries
  .filter(e => e.mark != null)
  .sort((a, b) => a.rank - b.rank))
const appealableRegs = computed(() => store.registrations
  .filter(r => r.status === 'approved' && r.unit_id !== Number(form.unit_id))
  .sort((a, b) => b.id - a.id))
const matchLabel = m => {
  const sp = store.sports.find(s => s.id === m.sport_id)?.name || ''
  return `${sp} · ${m.stage}${m.group_name ? '·' + m.group_name : ''} ${m.teamA.name} ${m.score_a}:${m.score_b} ${m.teamB.name}`
}
async function submit() {
  if (!form.unit_id) return showToast('⚠️ 请选择申诉单位')
  if (!form.target_id) return showToast('⚠️ 请选择申诉对象')
  if (!form.reason.trim()) return showToast('⚠️ 请填写申诉理由')
  try {
    const r = await store.submitAppeal({
      target_type: form.target_type, target_id: Number(form.target_id), unit_id: Number(form.unit_id),
      reason: form.reason.trim(), contact: form.contact.trim(), evidence: form.evidence.trim()
    })
    showToast(`✅ 申诉已提交（编号 ${r.code}），等待组委会受理`)
    resetForm()
  } catch (e) { showToast('⚠️ ' + e.message) }
}

/* ---------- 列表与筛选 ---------- */
const statusFilter = ref('all')
const list = computed(() => store.appeals.filter(a => statusFilter.value === 'all' || a.status === statusFilter.value))
const unitColor = uid => store.unitOfUid(uid)?.color || '#ccc'
const unitName = uid => store.unitOfUid(uid)?.name || '单位#' + uid
const targetBrief = a => {
  const t = a.target
  if (!t) return '（对象已不存在）'
  if (a.target_type === 'match') return matchLabel(t)
  if (a.target_type === 'track') return `${a.sport?.name} · ${t.aname} ${t.mark}s · 第${t.rank}名`
  return `${a.sport?.name} · ${TYPE_META.eligibility.icon}「${t.name}」（${t.target_unit}）`
}

/* ---------- 组委会操作 ---------- */
const reviewer = ref('仲裁委员会')
const acting = ref(null)         // 当前展开操作面板的申诉 id
const panelMode = ref('')         // reject / uphold
const note = ref('')
// 改判输入
const sa = ref(0), sb = ref(0), ta = ref(null), tb = ref(null), mark = ref(null)

function openPanel(a, mode) {
  acting.value = a.id; panelMode.value = mode; note.value = ''
  if (mode === 'uphold' && a.target_type === 'match' && a.target) {
    sa.value = a.target.score_a ?? 0; sb.value = a.target.score_b ?? 0
    ta.value = a.target.tb_a ?? null; tb.value = a.target.tb_b ?? null
  }
  if (mode === 'uphold' && a.target_type === 'track' && a.target) mark.value = a.target.mark
}
function closePanel() { acting.value = null; panelMode.value = ''; note.value = '' }

const isKOAppeal = a => ['半决赛', '决赛', '季军'].includes(a.target?.stage)
const needTB = computed(() => {
  const a = store.appeals.find(x => x.id === acting.value)
  return panelMode.value === 'uphold' && a?.target_type === 'match' && isKOAppeal(a) && sa.value === sb.value
})

async function accept(a) {
  try { await store.acceptAppeal(a.id, reviewer.value); showToast(`✅ 已受理 ${a.code}，进入复核`) }
  catch (e) { showToast('⚠️ ' + e.message) }
}
async function reject(a) {
  if (!note.value.trim()) return showToast('⚠️ 驳回必须填写复核意见')
  try { await store.rejectAppeal(a.id, note.value.trim(), reviewer.value); showToast(`✅ 已驳回 ${a.code}`); closePanel() }
  catch (e) { showToast('⚠️ ' + e.message) }
}
async function withdraw(a) {
  try { await store.withdrawAppeal(a.id, note.value.trim()); showToast(`✅ 已撤案 ${a.code}`); closePanel() }
  catch (e) { showToast('⚠️ ' + e.message) }
}
async function uphold(a) {
  if (!note.value.trim()) return showToast('⚠️ 改判必须填写复核意见')
  const payload = { reviewer: reviewer.value, note: note.value.trim() }
  if (a.target_type === 'match') {
    payload.score_a = sa.value; payload.score_b = sb.value
    if (needTB.value) {
      if (!Number.isInteger(ta.value) || !Number.isInteger(tb.value) || ta.value < 0 || tb.value < 0 || ta.value === tb.value) {
        return showToast('⚠️ 淘汰赛平分需录入有效的决胜比分，且不能再次持平')
      }
      payload.tb_a = ta.value; payload.tb_b = tb.value
    }
  } else if (a.target_type === 'track') {
    const v = Number(mark.value)
    if (!Number.isFinite(v) || v <= 0) return showToast('⚠️ 改判成绩需为大于 0 的秒数')
    payload.mark = v
  }
  try {
    const r = await store.upholdAppeal(a.id, payload)
    showToast(`✅ ${a.code} 改判完成：${impactBrief(r.impact)}`)
    closePanel()
  } catch (e) { showToast('⚠️ ' + e.message) }
}

const impactBrief = im => {
  if (!im) return ''
  const p = []
  if (im.resolution === 'revoked') p.push(`资格已撤销（弃权 ${im.walkover || 0} · 取消 ${im.voided || 0} 场）`)
  else p.push('比分/成绩已回写')
  const rep = (im.replays || []).length + (im.replacements || 0)
  if (rep) p.push(`淘汰赛递补/重赛 ${im.cascade || rep} 场`)
  if (im.medal_changes?.length) p.push(`奖牌变动 ${im.medal_changes.length} 个单位`)
  return p.join('，')
}
const medalDeltaText = d => [
  d.gold ? `金${d.gold > 0 ? '+' : ''}${d.gold}` : null,
  d.silver ? `银${d.silver > 0 ? '+' : ''}${d.silver}` : null,
  d.bronze ? `铜${d.bronze > 0 ? '+' : ''}${d.bronze}` : null
].filter(Boolean).join(' ')
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>⚖️ 赛事申诉复核</h2><div class="sub">参赛单位提交异议 · 组委会受理复核 · 改判自动回写比分/成绩与积分奖牌，联动资格撤销、淘汰赛递补重赛，全程留痕</div></div>
      <div v-if="toast" class="toast">{{ toast }}</div>
    </div>

    <!-- 统计卡 -->
    <div class="grid" style="grid-template-columns:repeat(5,1fr)">
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ff7a2f,#ffb27e)"></span><span class="ic">📨</span><b>{{ counts.pending }}</b><em>待受理</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#2f9bff,#79c4ff)"></span><span class="ic">🔍</span><b>{{ counts.reviewing }}</b><em>复核中</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#22c15e,#7edda4)"></span><span class="ic">✅</span><b>{{ counts.upheld }}</b><em>改判结案</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#dd5b5b,#f0a1a1)"></span><span class="ic">🚫</span><b>{{ counts.rejected }}</b><em>驳回</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#90a4ae,#c3ccd6)"></span><span class="ic">📁</span><b>{{ store.appeals.length }}</b><em>申诉总数</em></div>
    </div>

    <div class="grid g2 mt">
      <!-- 提交申诉 -->
      <div class="card">
        <div class="caption">📝 提交异议 <span class="hint">参赛单位就赛果/成绩/资格发起申诉</span></div>
        <div class="pad">
          <div class="form-row">
            <label>申诉单位</label>
            <select v-model.number="form.unit_id">
              <option :value="null" disabled>选择参赛单位</option>
              <option v-for="u in store.units" :key="u.id" :value="u.id">{{ u.name }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>申诉类型</label>
            <div class="filters">
              <button v-for="(m, key) in TYPE_META" :key="key" class="chip" :class="{ on: form.target_type === key }" @click="form.target_type = key; form.target_id = null">
                {{ m.icon }} {{ m.text }}
              </button>
            </div>
          </div>
          <div class="form-row">
            <label>申诉对象</label>
            <select v-model.number="form.target_id">
              <option :value="null" disabled>
                {{ form.target_type === 'match' ? '选择已完赛场次' : form.target_type === 'track' ? '选择田径成绩' : '选择被申诉资格' }}
              </option>
              <option v-if="form.target_type === 'match'" v-for="m in appealableMatches" :key="'m'+m.id" :value="m.id">{{ matchLabel(m) }}</option>
              <option v-if="form.target_type === 'track'" v-for="e in appealableEntries" :key="'e'+e.id" :value="e.id">
                {{ store.sports.find(s=>s.id===e.sport_id)?.name }} · {{ e.aname }}（{{ e.unit }}）{{ e.mark }}s · 第{{ e.rank }}名
              </option>
              <option v-if="form.target_type === 'eligibility'" v-for="r in appealableRegs" :key="'r'+r.id" :value="r.id">
                {{ r.sport }} · {{ r.kind === 'team' ? '队伍' : '运动员' }}「{{ r.name }}」· {{ r.unit }}
              </option>
            </select>
          </div>
          <div v-if="!form.unit_id" class="hint" style="margin:-4px 0 10px 88px">请先选择申诉单位后加载可申诉对象</div>
          <div class="form-row" style="align-items:flex-start">
            <label style="margin-top:7px">申诉理由</label>
            <textarea v-model="form.reason" rows="3" placeholder="详细描述异议事项，如误判、计时偏差、资格存疑等" style="flex:1;resize:vertical"></textarea>
          </div>
          <div class="form-row">
            <label>联系人</label>
            <input v-model="form.contact" placeholder="领队/教练（选填）">
          </div>
          <div class="form-row">
            <label>佐证材料</label>
            <input v-model="form.evidence" placeholder="录像、记录表、证明材料说明（选填）">
          </div>
          <div class="row mt8" style="justify-content:flex-end">
            <button class="btn ghost sm" @click="resetForm">清空</button>
            <button class="btn primary" @click="submit">📨 提交申诉</button>
          </div>
        </div>
      </div>

      <!-- 复核规则 -->
      <div class="card">
        <div class="caption">ℹ️ 复核规则与改判联动</div>
        <div class="pad rules">
          <p><span class="tag o">待受理</span> 单位提交后立案，组委会需先 <b>受理</b> 进入 <span class="tag b">复核中</span>。</p>
          <p>· 受理后可 <b>驳回</b>（必填复核意见）或 <b>复核改判</b>；申诉单位也可主动撤案。</p>
          <p>· <b>🏀 比分改判</b>：回写比分与胜方 → 积分榜全量重建；</p>
          <p style="padding-left:14px">— 小组/循环：按新积分排名 <b>重新递补半决赛</b>，已生成的决赛/季军回退待赛重赛；</p>
          <p style="padding-left:14px">— 半决赛：按新胜/负方同步决赛与季军对阵，对阵变化的场次 <b>回退重赛</b>；</p>
          <p style="padding-left:14px">— 重赛场次保留原执法名单，已解除场次自动联动排班。</p>
          <p>· <b>🏃 成绩改判</b>：回写计时成绩并 <b>全量重排名次</b>，金/银/铜重新结算。</p>
          <p>· <b>🪪 资格改判</b>：撤销参赛资格 → 未赛判弃权 3:0、已赛取消成绩、<b>淘汰赛顺位递补</b>、田径删除成绩重排名。</p>
          <p>· 每次改判均在 <b>单事务</b> 内完成（比分/成绩→积分→淘汰赛→奖牌），失败整体回滚，重复提交幂等；全过程写入审计。</p>
        </div>
      </div>
    </div>

    <!-- 申诉列表 -->
    <div class="card mt">
      <div class="caption">
        <span>🗂️ 申诉案卷 <span class="hint">共 {{ list.length }} 件</span></span>
        <div class="filters">
          <button class="chip" :class="{ on: statusFilter === 'all' }" @click="statusFilter = 'all'">全部</button>
          <button v-for="(meta, key) in STATUS_META" :key="key" class="chip" :class="{ on: statusFilter === key }" @click="statusFilter = key">{{ meta.text }}</button>
        </div>
      </div>
      <div class="pad" style="display:flex;flex-direction:column;gap:12px">
        <div v-for="a in list" :key="a.id" class="acard" :class="a.status">
          <!-- 头部 -->
          <div class="mheader">
            <span>
              <b class="mono" style="color:var(--accent)">{{ a.code }}</b>
              <span class="tag b" style="margin-left:8px">{{ TYPE_META[a.target_type].icon }} {{ TYPE_META[a.target_type].text }}</span>
              <span class="badge" style="margin-left:8px"><span class="dot" :style="{ background: unitColor(a.unit_id) }"></span>{{ a.unit?.name }}</span>
            </span>
            <span class="tag" :class="STATUS_META[a.status].tag">{{ STATUS_META[a.status].text }}</span>
          </div>

          <!-- 对象与理由 -->
          <div class="obj-line">🎯 <b>{{ targetBrief(a) }}</b></div>
          <div class="reason-line">💬 {{ a.reason }}</div>
          <div class="meta-line">
            <span v-if="a.contact">联系人：{{ a.contact }}</span>
            <span v-if="a.evidence">📎 {{ a.evidence }}</span>
            <span>提交于 {{ a.submitted_at }}</span>
            <span v-if="a.reviewer">经办：{{ a.reviewer }}</span>
          </div>

          <!-- 改判影响 -->
          <div v-if="a.status === 'upheld' && a.impact" class="impact-box">
            <div class="imp-title">⚙️ 改判已执行（{{ a.reviewed_at }}）</div>
            <div v-for="(c, i) in a.impact.corrected" :key="'c'+i" class="imp-row">
              <span class="tag g">回写</span>
              <template v-if="c.from && c.to">{{ c.athlete || c.stage || '' }} <b class="mono">{{ c.from }}</b> → <b class="mono">{{ c.to }}</b></template>
              <template v-else>撤销「{{ c.name }}」参赛资格 · 弃权 {{ a.impact.walkover || 0 }} 场 · 取消成绩 {{ a.impact.voided || 0 }} 场 · 田径成绩 {{ a.impact.entries || 0 }} 条</template>
            </div>
            <div v-if="a.impact.replays?.length" class="imp-row">
              <span class="tag b">重赛/递补</span>
              <span v-for="(r, i) in a.impact.replays" :key="'r'+i">「{{ r.title }}」回退待赛<span v-if="i < a.impact.replays.length - 1">；</span></span>
            </div>
            <div v-if="a.impact.replacements && !a.impact.replays?.length" class="imp-row">
              <span class="tag b">递补</span> 半决赛按新排名替换 {{ a.impact.replacements }} 场
            </div>
            <div v-if="a.impact.medal_changes?.length" class="imp-row">
              <span class="tag y">奖牌</span>
              <span v-for="(d, i) in a.impact.medal_changes" :key="'md'+i" class="badge" style="margin-right:12px">
                <span class="dot" :style="{ background: unitColor(d.unit_id) }"></span>{{ unitName(d.unit_id) }}
                <b :style="{ color: d.gold || d.silver || d.bronze ? '#c98a00' : '#e5484d' }">{{ medalDeltaText(d) }}</b>
              </span>
            </div>
            <div v-if="a.impact.standings_changes?.length" class="imp-row">
              <span class="tag gray">积分</span>
              <span v-for="(s, i) in a.impact.standings_changes.slice(0, 6)" :key="'s'+i" class="stand-chip">
                {{ s.name }} {{ s.points_from }}→<b>{{ s.points_to }}</b>分<span v-if="s.rank_from"> · 名次 {{ s.rank_from || '—' }}→{{ s.rank_to || '—' }}</span><span v-if="i < Math.min(5, a.impact.standings_changes.length - 1)">、</span>
              </span>
              <span v-if="a.impact.standings_changes.length > 6"> 等 {{ a.impact.standings_changes.length }} 队</span>
            </div>
          </div>
          <div v-if="a.review_note && a.status === 'rejected'" class="impact-box reject">
            <div class="imp-title">🚫 驳回意见（{{ a.reviewed_at }} · {{ a.reviewer }}）</div>
            <div>{{ a.review_note }}</div>
          </div>

          <!-- 操作区 -->
          <div class="row mt8" style="justify-content:flex-end;gap:6px;flex-wrap:wrap">
            <template v-if="a.status === 'pending'">
              <button class="btn primary sm" @click="accept(a)">✅ 受理复核</button>
              <button class="btn sm" style="background:#e8f2ff;color:var(--accent3)" @click="openPanel(a, 'withdraw')">↩️ 单位撤案</button>
              <button class="btn ghost sm" @click="openPanel(a, 'reject')">⛔ 驳回</button>
            </template>
            <template v-else-if="a.status === 'reviewing'">
              <button class="btn green sm" @click="openPanel(a, 'uphold')">⚙️ 复核改判</button>
              <button class="btn sm" style="background:#e8f2ff;color:var(--accent3)" @click="openPanel(a, 'withdraw')">↩️ 单位撤案</button>
              <button class="btn ghost sm" @click="openPanel(a, 'reject')">⛔ 驳回</button>
            </template>
          </div>

          <!-- 操作面板 -->
          <div v-if="acting === a.id" class="act-panel">
            <!-- 改判输入 -->
            <template v-if="panelMode === 'uphold'">
              <div v-if="a.target_type === 'match'" class="corr-box">
                <div class="corr-title">改判比分：{{ a.target?.teamA?.name }} VS {{ a.target?.teamB?.name }}</div>
                <div class="row" style="gap:6px;flex-wrap:wrap">
                  {{ a.target?.teamA?.name }}
                  <input v-model.number="sa" type="number" min="0" class="score-in" style="width:60px"> :
                  <input v-model.number="sb" type="number" min="0" class="score-in" style="width:60px">
                  {{ a.target?.teamB?.name }}
                </div>
                <div v-if="needTB" class="tbrow">
                  ⚔️ 平分决胜（加时/点球）：
                  <input v-model.number="ta" type="number" min="0" class="score-in" style="width:54px"> :
                  <input v-model.number="tb" type="number" min="0" class="score-in" style="width:54px">
                </div>
              </div>
              <div v-else-if="a.target_type === 'track'" class="corr-box">
                <div class="corr-title">改判成绩：{{ a.target?.aname }}（原 {{ a.target?.mark }}s · 第{{ a.target?.rank }}名）</div>
                <div class="row" style="gap:6px">
                  复核成绩 <input v-model.number="mark" type="number" step="0.01" min="0.01" class="score-in" style="width:90px"> 秒，提交后全量重排名次与奖牌
                </div>
              </div>
              <div v-else class="corr-box">
                <div class="corr-title">🪪 复核确认资格违规</div>
                <div class="hint">撤销后将级联：未赛判弃权、已赛取消成绩、淘汰赛顺位递补、积分与奖牌重算。</div>
              </div>
            </template>
            <input v-model="note" class="note-input" :placeholder="panelMode === 'reject' ? '驳回复核意见（必填）' : panelMode === 'uphold' ? '复核改判意见（必填，写入审计）' : '撤案说明（选填）'">
            <div class="row" style="gap:6px;flex-shrink:0">
              <button class="btn ghost sm" @click="closePanel">取消</button>
              <button v-if="panelMode === 'reject'" class="btn sm" style="background:#ffecec;color:#e5484d" @click="reject(a)">确认驳回</button>
              <button v-else-if="panelMode === 'withdraw'" class="btn sm" style="background:#e8f2ff;color:var(--accent3)" @click="withdraw(a)">确认撤案</button>
              <button v-else class="btn green sm" @click="uphold(a)">确认改判并回写</button>
            </div>
          </div>

          <!-- 审计时间线 -->
          <div class="timeline">
            <div v-for="l in a.logs" :key="l.id" class="tl-item">
              <span class="tag" :class="ACTION_META[l.action].tag">{{ ACTION_META[l.action].text }}</span>
              <span class="tl-detail">{{ l.detail }}</span>
              <span class="tl-time">{{ l.operator }} · {{ l.created_at }}</span>
            </div>
          </div>
        </div>
        <div v-if="!list.length" class="empty">暂无申诉记录</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.form-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.form-row label { width: 72px; flex-shrink: 0; font-size: 12px; color: var(--muted); font-weight: 700; }
.form-row select, .form-row input, .form-row textarea { flex: 1; }
.rules p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.8; color: var(--ink); }
.acard { border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; background: #fff; box-shadow: var(--shadow-sm); border-left: 4px solid var(--line); }
.acard.pending { border-left-color: var(--accent); }
.acard.reviewing { border-left-color: var(--accent3); }
.acard.upheld { border-left-color: var(--accent2); background: linear-gradient(180deg, #f6fdf8, #fff); }
.acard.rejected { border-left-color: #e5484d; }
.acard.withdrawn { border-left-color: #c3ccd6; opacity: .92; }
.obj-line { font-size: 14px; margin-top: 8px; }
.reason-line { font-size: 13px; margin-top: 5px; color: var(--ink); }
.meta-line { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--muted); margin-top: 6px; }
.impact-box { margin-top: 10px; padding: 10px 12px; background: #f2fbf5; border: 1px solid #c9eed3; border-radius: 10px; font-size: 12.5px; display: flex; flex-direction: column; gap: 6px; }
.impact-box.reject { background: #fff5f5; border-color: #f3c9cb; }
.imp-title { font-weight: 800; font-size: 12px; color: var(--accent2); }
.impact-box.reject .imp-title { color: #e5484d; }
.imp-row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.stand-chip { color: var(--muted); font-size: 12px; }
.act-panel { margin-top: 10px; padding: 12px; background: var(--bg2); border-radius: 12px; display: flex; flex-direction: column; gap: 10px; }
.note-input { width: 100%; }
.corr-box { background: #fff; border: 1px dashed var(--accent); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.corr-title { font-weight: 800; font-size: 13px; }
.score-in { font-weight: 800; font-size: 15px; text-align: center; }
.tbrow { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.timeline { margin-top: 10px; padding-top: 9px; border-top: 1px dashed var(--line); display: flex; flex-direction: column; gap: 6px; }
.tl-item { display: flex; align-items: baseline; gap: 8px; font-size: 12px; flex-wrap: wrap; }
.tl-detail { flex: 1; min-width: 200px; color: var(--ink); }
.tl-time { color: var(--muted); font-size: 11px; white-space: nowrap; }
</style>
