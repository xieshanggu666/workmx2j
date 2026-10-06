<script setup>
import { ref, computed } from 'vue'
import { useEventStore } from '@/store/event'
import OverviewView from '@/components/OverviewView.vue'
import ScheduleView from '@/components/ScheduleView.vue'
import ScoreView from '@/components/ScoreView.vue'
import BracketView from '@/components/BracketView.vue'
import RegistrationView from '@/components/RegistrationView.vue'
import AppealView from '@/components/AppealView.vue'
import AccessView from '@/components/AccessView.vue'
import IncidentView from '@/components/IncidentView.vue'
import TeamView from '@/components/TeamView.vue'
import VenueView from '@/components/VenueView.vue'
import MedalView from '@/components/MedalView.vue'
import ReportsView from '@/components/ReportsView.vue'

const store = useEventStore()
store.init()

const navs = [
  ['overview', '🏟️', '赛事总览'], ['schedule', '🗓️', '赛程编排'], ['score', '⚡', '成绩录入'],
  ['bracket', '🧩', '对阵积分'], ['registration', '📝', '报名审核'], ['appeal', '⚖️', '申诉复核'],
  ['incident', '🚑', '安全事件'],
  ['access', '🪪', '证件核验'], ['team', '👥', '队伍运动员'],
  ['venue', '📍', '场地裁判'], ['medal', '🥇', '奖牌榜'], ['reports', '📊', '报表中心']
]
const view = ref('overview')
const cur = { overview: OverviewView, schedule: ScheduleView, score: ScoreView, bracket: BracketView, registration: RegistrationView, appeal: AppealView, incident: IncidentView, access: AccessView, team: TeamView, venue: VenueView, medal: MedalView, reports: ReportsView }
// 待受理 + 复核中 = 申诉待办
const appealTodo = computed(() => (store.overview?.appeals?.pending || 0) + (store.overview?.appeals?.reviewing || 0))
// 入场核验异常 = 今日拦截 + 强制放行（审计待办）
const accessTodo = computed(() => (store.overview?.access?.today_deny || 0) + (store.overview?.access?.today_forced || 0))
// 安全事件待办 = 待分级 + 待结案（组委会动作）；处置中单独计数提示
const incidentTodo = computed(() => (store.overview?.incidents?.pending || 0) + (store.overview?.incidents?.resolved || 0))
</script>

<template>
  <div class="layout">
    <aside class="side">
      <div class="brand">
        <div class="logo">🏅</div>
        <div>青春杯<span>运动会</span><small>赛事编排与成绩管理</small></div>
      </div>
      <nav class="nav">
        <button v-for="(n, i) in navs" :key="n[0]" :class="{ active: view === n[0] }" @click="view = n[0]">
          <span class="em">{{ n[1] }}</span>{{ n[2] }}
          <span v-if="n[0] === 'appeal' && appealTodo" class="nav-badge">{{ appealTodo }}</span>
          <span v-else-if="n[0] === 'incident' && incidentTodo" class="nav-badge" style="background:#b3186e">{{ incidentTodo }}</span>
          <span v-else-if="n[0] === 'access' && accessTodo" class="nav-badge" style="background:#e5484d">{{ accessTodo }}</span>
        </button>
      </nav>
      <div class="side-foot">
        🏁 <b>轻量运动会</b>：循环 / 小组+淘汰 / 单项成绩<br />
        成绩录入自动更新积分与奖牌
      </div>
    </aside>
    <main class="main">
      <component :is="cur[view]" />
    </main>
  </div>
</template>