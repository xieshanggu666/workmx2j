<script setup>
import { computed } from 'vue'
import { useEventStore } from '@/store/event'

const store = useEventStore()
const ov = computed(() => store.overview || {})

const tot = computed(() => store.sports.length)
const doneTotal = computed(() => ov.value.finishedMatches || 0)
const prog = computed(() => tot.value ? Math.round((doneTotal.value / Math.max(1, doneTotal.value + (ov.value.pendingMatches || 0))) * 100) : 0)

const appealStatus = { pending: 'o', reviewing: 'b', upheld: 'g', rejected: 'r', withdrawn: 'gray' }
const appealStatusText = { pending: '待受理', reviewing: '复核中', upheld: '已改判', rejected: '已驳回', withdrawn: '已撤案' }
const appealList = computed(() => store.appeals.filter(a => ['pending', 'reviewing'].includes(a.status)).slice(0, 4))
function appealBrief(a) {
  const t = a.target
  if (!t) return '（对象已不存在）'
  if (a.target_type === 'match') return `${t.teamA?.name} ${t.score_a}:${t.score_b} ${t.teamB?.name}`
  if (a.target_type === 'track') return `${t.aname} ${t.mark}s（第${t.rank}名）`
  return `「${t.name}」的参赛资格`
}

const INC_STATUS = { pending: 'o', handling: 'r', resolved: 'y', closed: 'g' }
const INC_STATUS_TEXT = { pending: '待分级', handling: '处置中', resolved: '待结案', closed: '已结案' }
const INC_CAT = { injury: '🩺 伤病急救', security: '🚨 治安事件', dispute: '🥊 冲突纠纷', facility: '🛠️ 场地器材', weather: '🌩️ 天气突发', other: '📌 其他' }
const incidentList = computed(() => store.incidents.filter(i => i.status !== 'closed').slice(0, 4))
</script>

<template>
  <div v-if="store.loaded">
    <div class="page-h">
      <div><h2>🏟️ 赛事总览</h2><div class="sub">第 3 届青春杯运动会 · 实时赛况与进度</div></div>
      <div class="row">
        <button class="btn ghost sm" @click="store.refresh">🔄 刷新</button>
      </div>
    </div>

    <div class="grid" style="grid-template-columns:repeat(5,1fr)">
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ff7a2f,#ffb27e)"></span><span class="ic">🏅</span><b>{{ tot }}</b><em>比赛项目</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#2f9bff,#79c4ff)"></span><span class="ic">🗓️</span><b>{{ doneTotal }}</b><em>已完赛场次</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#dd5b5b,#f0a1a1)"></span><span class="ic">⏳</span><b>{{ ov.pendingMatches || 0 }}</b><em>待赛预约</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#ffb92b,#ffd98a)"></span><span class="ic">🧑‍⚖️</span><b>{{ ov.crewCoverage ? ov.crewCoverage.slots_filled + '/' + ov.crewCoverage.slots_need : '—' }}</b><em>执法席位覆盖（已完赛+待赛{{ ov.crewCoverage ? '：' + ov.crewCoverage.pct + '%' : '' }}）</em></div>
      <div class="card stat"><span class="bar" style="background:linear-gradient(90deg,#22c15e,#7edda4)"></span><span class="ic">⛳</span><b>{{ prog }}%</b><em>整体完成度</em></div>
    </div>

    <!-- 证件入场核验速览 -->
    <div class="card mt" v-if="ov.access">
      <div class="caption">🪪 赛事证件与入场核验 <span class="hint">有效证件 {{ ov.access.badges_active }} · 今日放行 {{ ov.access.today_pass }} · 拦截 {{ ov.access.today_deny }} · 强制放行 {{ ov.access.today_forced }} · 重复核验 {{ ov.access.today_duplicate }}</span></div>
      <div class="pad">
        <div class="grid g4" style="gap:12px">
          <div class="mini-stat"><span>🟢 双方到场准备</span><b class="mono">{{ (ov.access.scheduled_matches - ov.access.matches_not_ready) }}/{{ ov.access.scheduled_matches }} 场</b><div class="hbar"><i :style="{ width: (ov.access.scheduled_matches ? Math.round((ov.access.scheduled_matches - ov.access.matches_not_ready) / ov.access.scheduled_matches * 100) : 100) + '%', background: 'var(--accent2)' }"></i></div></div>
          <div class="mini-stat"><span>🧑‍⚖️ 执法到岗</span><b class="mono">{{ ov.access.crew_ready }}/{{ ov.access.crew_total }} 席</b><div class="hbar"><i :style="{ width: (ov.access.crew_total ? Math.round(ov.access.crew_ready / ov.access.crew_total * 100) : 100) + '%', background: 'var(--accent3)' }"></i></div></div>
          <div class="mini-stat"><span>🪪 停用/暂扣证件</span><b class="mono" :style="{ color: ov.access.badges_blocked ? '#e5484d' : 'var(--accent2)' }">{{ ov.access.badges_blocked }}</b><div class="hbar"><i :style="{ width: ov.access.badges_blocked ? '100%' : '0%', background: '#e5484d' }"></i></div></div>
          <div class="mini-stat"><span>⚠️ 今日异常（拦截+强制）</span><b class="mono" :style="{ color: ov.access.today_deny + ov.access.today_forced ? '#c98a00' : 'var(--accent2)' }">{{ ov.access.today_deny + ov.access.today_forced }}</b><div class="hbar"><i :style="{ width: (ov.access.today_deny + ov.access.today_forced) ? '100%' : '0%', background: 'var(--gold)' }"></i></div></div>
        </div>
      </div>
    </div>

    <!-- 申诉复核速览 -->
    <div class="card mt" v-if="ov.appeals">
      <div class="caption">⚖️ 赛事申诉复核 <span class="hint">待受理 {{ ov.appeals.pending }} · 复核中 {{ ov.appeals.reviewing }} · 已改判 {{ ov.appeals.upheld }} / 共 {{ ov.appeals.total }} 件</span></div>
      <div class="pad" style="display:flex;flex-direction:column;gap:10px">
        <div v-if="!appealList.length" class="empty" style="padding:14px">暂无申诉记录</div>
        <div v-for="a in appealList" :key="a.id" class="mcard">
          <div class="mheader">
            <span><b class="mono" style="color:var(--accent)">{{ a.code }}</b> · {{ a.sport?.name }}</span>
            <span class="tag" :class="appealStatus[a.status]">{{ appealStatusText[a.status] }}</span>
          </div>
          <div class="mrow">
            <span class="t"><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(a.unit_id)?.color }"></span>{{ a.unit?.name }}</span> 对 <b>{{ appealBrief(a) }}</b> 提出异议</span>
          </div>
          <div class="ph" style="font-size:12px;margin-top:2px">💬 {{ a.reason }}</div>
        </div>
      </div>
    </div>

    <!-- 安全事件速览 -->
    <div class="card mt" v-if="ov.incidents">
      <div class="caption">🚑 赛事安全事件处置 <span class="hint">待分级 {{ ov.incidents.pending }} · 处置中 {{ ov.incidents.handling }} · 待结案 {{ ov.incidents.resolved }} · 暂停中场次 {{ ov.incidents.paused_matches }} · 事件暂扣证件 {{ ov.incidents.blocked_by_incident }}</span></div>
      <div class="pad" style="display:flex;flex-direction:column;gap:10px">
        <div class="row" style="gap:10px;flex-wrap:wrap;margin-bottom:2px">
          <span v-if="ov.incidents.major_open" class="tag r">🔴 未结重大事件 {{ ov.incidents.major_open }}</span>
          <span v-if="ov.incidents.general_open" class="tag y">🟠 未结较大事件 {{ ov.incidents.general_open }}</span>
          <span class="tag gray">四方协同：医疗 · 安保 · 裁判 · 组委会</span>
        </div>
        <div v-if="!incidentList.length" class="empty" style="padding:14px">暂无未结安全事件</div>
        <div v-for="i in incidentList" :key="i.id" class="mcard" :class="{ major: i.severity === 'major' }">
          <div class="mheader">
            <span><b class="mono" style="color:var(--accent3)">{{ i.code }}</b> · {{ INC_CAT[i.category] }}<span v-if="i.severity === 'major'" class="tag r" style="margin-left:6px">重大</span></span>
            <span class="tag" :class="INC_STATUS[i.status]">{{ INC_STATUS_TEXT[i.status] }}</span>
          </div>
          <div class="ph" style="font-size:12.5px;margin-top:2px">💬 {{ i.description }}</div>
          <div class="mrow">
            <span class="t ph" style="font-size:11.5px">
              <span v-if="i.venue">📍 {{ i.venue.name }}</span>
              <span v-if="(i.match_links || []).length" style="margin-left:8px">🏟️ 关联 {{ i.match_links.length }} 场{{ i.match_links.length > 1 ? '：' + i.match_links.slice(0, 2).map(m => (m.teamA?.name || '待定') + 'VS' + (m.teamB?.name || '待定')).join('、') + (i.match_links.length > 2 ? ' 等' : '') : ' ' + (i.match?.teamA?.name || '') + 'VS' + (i.match?.teamB?.name || '') }}</span>
            </span>
            <span class="row" style="gap:4px">
              <span v-if="i.impact?.badges_blocked" class="tag r">🪪 暂扣 {{ i.impact.badges_blocked }}</span>
              <span v-if="store.matches.filter(m => m.pause_incident_id === i.id && m.is_paused).length" class="tag r">⏸️ 暂停 {{ store.matches.filter(m => m.pause_incident_id === i.id && m.is_paused).length }} 场</span>
              <span v-else-if="i.impact?.matches_rescheduled" class="tag y">📅 改期 {{ i.impact.matches_rescheduled }} 场</span>
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="grid g2 mt">
      <!-- 项目进度 -->
      <div class="card">
        <div class="caption">📋 各项目赛程进度 <span class="hint">完成场次 / 总场次</span></div>
        <div class="pad" style="display:flex;flex-direction:column;gap:16px">
          <div v-for="s in ov.sportDone" :key="s.id">
            <div class="row spread" style="margin-bottom:7px">
              <span class="badge">{{ s.name }}</span>
              <span class="tag" :class="s.done >= s.total ? 'g' : 'o'">{{ s.done }}/{{ s.total }} · {{ s.done >= s.total ? '收官' : '进行中' }}</span>
            </div>
            <div class="hbar"><i :style="{ width: (s.total ? (s.done / s.total) * 100 : 0) + '%', background: s.done >= s.total ? 'var(--accent2)' : 'var(--accent)' }"></i></div>
          </div>
        </div>
      </div>
      <!-- 最新赛果 -->
      <div class="card">
        <div class="caption">🏁 最近完赛/待赛场次</div>
        <div class="pad" style="display:flex;flex-direction:column;gap:10px">
          <div v-for="m in ov.recent" :key="m.id" class="mcard" :class="{ done: m.status === 'finished' }">
            <div class="mheader"><span>{{ m.teamA?.name }} · {{ m.stage }}{{ m.group_name || '' }}</span><span>⚽ {{ m.venue?.name }}</span></div>
            <div class="mrow">
              <span class="t"><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.teamA?.unit_id)?.color }"></span>{{ m.teamA?.name || '待定' }}</span></span>
              <span class="score-chip ph" v-if="m.status==='scheduled'">— : —</span>
              <span class="score-chip ph" v-else-if="m.status==='void'">已取消</span>
              <span class="score-chip" v-else>{{ m.score_a }} : {{ m.score_b }}<template v-if="m.tb_a != null">（决胜 {{ m.tb_a }}:{{ m.tb_b }}）</template></span>
              <span class="t" style="text-align:right"><span class="badge">{{ m.teamB?.name || '待定' }}<span class="dot" :style="{ background: store.unitOfUid(m.teamB?.unit_id)?.color }"></span></span></span>
            </div>
            <div v-if="m.note" class="note-line">📝 {{ m.note }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 奖牌速览 -->
    <div class="card mt">
      <div class="caption">🥇 奖牌榜速览</div>
      <div class="pad">
        <table>
          <thead><tr><th>#</th><th>参赛单位</th><th>🏅 金</th><th>🥈 银</th><th>🥉 铜</th><th>总数</th></tr></thead>
          <tbody>
            <tr v-for="(m, i) in store.medals.slice(0, 4)" :key="m.unit_id">
              <td><b>{{ i + 1 }}</b></td>
              <td><span class="badge"><span class="dot" :style="{ background: store.unitOfUid(m.unit_id)?.color }"></span>{{ m.name }}</span></td>
              <td class="mono" style="color:var(--gold);font-weight:800">{{ m.gold }}</td>
              <td class="mono">{{ m.silver }}</td>
              <td class="mono">{{ m.bronze }}</td>
              <td class="mono"><b>{{ m.gold + m.silver + m.bronze }}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-line { font-size: 12px; color: var(--muted); margin-top: 6px; padding: 5px 9px; background: var(--bg2); border-radius: 8px; }
.mini-stat { background: var(--bg2); border-radius: 12px; padding: 11px 14px; display: flex; flex-direction: column; gap: 6px; }
.mini-stat span { font-size: 12px; color: var(--muted); font-weight: 600; }
.mini-stat b { font-size: 17px; }
.mcard.major { border-color: #f0a1c5; box-shadow: 0 0 0 2px rgba(179,24,110,.1), var(--shadow-sm); }
</style>