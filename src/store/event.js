import { defineStore } from 'pinia'

const j = (p, o) => fetch(p, o).then(async r => {
  const data = await r.json().catch(() => ({}))
  if (!r.ok) {
    const e = new Error(data.error || '请求失败')
    e.status = r.status
    e.code = data.code
    e.conflicts = data.conflicts
    throw e
  }
  return data
})

export const useEventStore = defineStore('event', {
  state: () => ({
    sports: [], teams: [], units: [], venues: [], referees: [],
    athletes: [], matches: [], entries: [], medals: [], overview: null,
    standings: {}, registrations: [], quota: [], loaded: false,
    assignments: [], assignmentLogs: [], conflicts: null, workload: [], appeals: [],
    incidents: [],
    badges: [], staff: [], checkins: [], accessLogs: [], matchAccess: []
  }),
  getters: {
    teamOf: s => id => s.teams.find(t => t.id === id),
    unitOfUid: s => id => s.units.find(u => u.id === id),
    // 场次 -> 在派执法安排
    crewOf: s => mid => s.assignments.filter(a => a.match_id === mid),
    chiefOf: s => mid => s.assignments.find(a => a.match_id === mid && a.role === 'chief')
  },
  actions: {
    async init() {
      const [sports, teams, units, venues, referees, athletes, matches, entries, medals, overview, registrations, quota, assignments, logs, conflicts, workload, appeals, badges, staff, checkins, accessLogs, matchAccess] = await Promise.all([
        j('/api/sports'), j('/api/teams'), j('/api/units'), j('/api/venues'), j('/api/referees'),
        j('/api/athletes'), j('/api/matches'), j('/api/entries'), j('/api/medals'), j('/api/overview'),
        j('/api/registrations'), j('/api/quota'),
        j('/api/assignments'), j('/api/assignment-logs?limit=80'), j('/api/conflicts'), j('/api/referee-workload'),
        j('/api/appeals'), j('/api/incidents'),
        j('/api/badges'), j('/api/staff'), j('/api/access/checkins?limit=120'), j('/api/access/logs?limit=120'),
        j('/api/access/matches?status=scheduled')
      ])
      Object.assign(this, { sports, teams, units, venues, referees, athletes, matches, entries, medals, overview, registrations, quota, assignments, assignmentLogs: logs, conflicts, workload, appeals, incidents, badges, staff, checkins, accessLogs, matchAccess })
      const st = {}
      for (const s of sports) st[s.id] = await j('/api/standings/' + s.id)
      this.standings = st
      this.loaded = true
    },
    async refresh() {
      const [matches, entries, medals, overview, registrations, quota, teams, athletes, assignments, logs, conflicts, workload, referees, appeals, badges, staff, checkins, accessLogs, matchAccess] = await Promise.all([
        j('/api/matches'), j('/api/entries'), j('/api/medals'), j('/api/overview'),
        j('/api/registrations'), j('/api/quota'), j('/api/teams'), j('/api/athletes'),
        j('/api/assignments'), j('/api/assignment-logs?limit=80'), j('/api/conflicts'), j('/api/referee-workload'), j('/api/referees'),
        j('/api/appeals'), j('/api/incidents'),
        j('/api/badges'), j('/api/staff'), j('/api/access/checkins?limit=120'), j('/api/access/logs?limit=120'),
        j('/api/access/matches?status=scheduled')
      ])
      Object.assign(this, { matches, entries, medals, overview, registrations, quota, teams, athletes, assignments, assignmentLogs: logs, conflicts, workload, referees, appeals, incidents, badges, staff, checkins, accessLogs, matchAccess })
      const st = {}
      for (const s of this.sports) st[s.id] = await j('/api/standings/' + s.id)
      this.standings = st
    },
    async score(mid, sa, sb, tbA = null, tbB = null) {
      const r = await j('/api/matches/' + mid + '/score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ score_a: sa, score_b: sb, tb_a: tbA, tb_b: tbB }) })
      if (r && r.error) throw new Error(r.error)
      await this.refresh()
      return r
    },
    async genKO(sid) { const r = await j('/api/ko/' + sid, { method: 'POST' }); await this.refresh(); return r.msg },
    async saveTrack(sid, list) { await j('/api/track/' + sid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) }); await this.refresh() },
    async submitRegistration(payload) { const r = await j('/api/registrations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async approveRegistration(id) { const r = await j('/api/registrations/' + id + '/approve', { method: 'POST' }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async rejectRegistration(id, note) { const r = await j('/api/registrations/' + id + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async withdrawRegistration(id, note) { const r = await j('/api/registrations/' + id + '/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async revokeRegistration(id, note) { const r = await j('/api/registrations/' + id + '/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    // —— 裁判排班与场地协同 ——
    async assignReferee(payload) { const r = await j('/api/assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async autoAssign() { const r = await j('/api/assignments/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); await this.refresh(); return r },
    async releaseAssignment(id, reason) { const r = await j('/api/assignments/' + id + '/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    async reassignAssignment(id, payload) { const r = await j('/api/assignments/' + id + '/reassign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async changeSchedule(id, payload) { const r = await j('/api/matches/' + id + '/schedule', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async addReferee(payload) { const r = await j('/api/referees', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); if (r.error) throw new Error(r.error); await this.refresh(); return r },
    // —— 赛事申诉复核 ——
    async submitAppeal(payload) { const r = await j('/api/appeals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async acceptAppeal(id, reviewer) { const r = await j('/api/appeals/' + id + '/accept', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewer }) }); await this.refresh(); return r },
    async rejectAppeal(id, note, reviewer) { const r = await j('/api/appeals/' + id + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note, reviewer }) }); await this.refresh(); return r },
    async withdrawAppeal(id, note) { const r = await j('/api/appeals/' + id + '/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) }); await this.refresh(); return r },
    async upholdAppeal(id, payload) { const r = await j('/api/appeals/' + id + '/uphold', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    // —— 赛事安全事件处置 ——
    async reportIncident(payload) { const r = await j('/api/incidents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async triageIncident(id, payload) { const r = await j('/api/incidents/' + id + '/triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async progressIncident(id, payload) { const r = await j('/api/incidents/' + id + '/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async incidentBlockBadge(id, payload) { const r = await j('/api/incidents/' + id + '/badges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async incidentReleaseBadge(id, linkId, payload) { const r = await j('/api/incidents/' + id + '/badges/' + linkId + '/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async incidentPause(id, payload) { const r = await j('/api/incidents/' + id + '/pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async incidentResume(id, payload) { const r = await j('/api/incidents/' + id + '/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async incidentReschedule(id, payload) { const r = await j('/api/incidents/' + id + '/reschedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async resolveIncident(id, payload) { const r = await j('/api/incidents/' + id + '/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async reopenIncident(id, payload) { const r = await j('/api/incidents/' + id + '/reopen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async closeIncident(id, payload) { const r = await j('/api/incidents/' + id + '/close', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    // —— 赛事证件与入场核验 ——
    async verifyAccess(payload) { const r = await j('/api/access/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async blockBadge(id, reason) { const r = await j('/api/badges/' + id + '/block', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); await this.refresh(); return r },
    async unblockBadge(id, reason) { const r = await j('/api/badges/' + id + '/unblock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); await this.refresh(); return r },
    async syncBadges(operator) { const r = await j('/api/badges/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operator }) }); await this.refresh(); return r },
    async addStaff(payload) { const r = await j('/api/staff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); await this.refresh(); return r },
    async reset() { await j('/api/reset'); await this.init() }
  }
})
