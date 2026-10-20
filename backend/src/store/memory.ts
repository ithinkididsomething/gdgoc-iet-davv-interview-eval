import { randomUUID } from 'node:crypto';
import { meanOrNull, round2 } from '../lib/scoring.js';
import type {
  AuditEntry,
  Candidate,
  CandidateFilters,
  CandidateScope,
  Criterion,
  CriterionScore,
  Evaluation,
  EvaluationWithScores,
  ImportApplicantsResult,
  ImportedApplicant,
  ImportResult,
  Panel,
  PanelCodeMeta,
  Profile,
  ResultRow,
  Round,
  Role,
  SpreadsheetConnection,
  SpreadsheetSyncItem,
  Store,
  SubmitEvaluationInput,
  SubmitOutcome,
  Vertical,
  VerifyOutcome,
} from './types.js';

/**
 * In-memory implementation of the Store contract with the same uniqueness and
 * policy semantics as the Supabase implementation. Used by automated tests.
 */
export class MemoryStore implements Store {
  profiles = new Map<string, Profile>();
  panels = new Map<string, Panel>();
  panelCodes = new Map<string, PanelCodeMeta & { code_hash: string }>();
  panelMembers: { panel_id: string; judge_id: string; verified_at: string | null }[] = [];
  candidates = new Map<string, Candidate>();
  rounds = new Map<string, Round>();
  criteria = new Map<string, Criterion>();
  evaluations = new Map<string, Evaluation>();
  criterionScores = new Map<string, CriterionScore[]>();
  audits: AuditEntry[] = [];
  verticals = new Map<string, Vertical>();
  syncQueue = new Map<string, SpreadsheetSyncItem>();
  syncLog: {
    connection_id: string | null;
    direction: string;
    operation: string;
    row_key: string;
    status: 'ok' | 'error' | 'conflict';
    detail: string;
    actor_id: string | null;
    created_at: string;
  }[] = [];
  spreadsheetConnection: SpreadsheetConnection | null = null;

  private now() {
    return new Date().toISOString();
  }

  async getProfile(id: string): Promise<Profile | null> {
    return this.profiles.get(id) ?? null;
  }
  async getProfilesByIds(ids: string[]): Promise<Profile[]> {
    return ids.map((id) => this.profiles.get(id)).filter((p): p is Profile => !!p);
  }
  async listProfiles(role?: Role): Promise<Profile[]> {
    const all = [...this.profiles.values()].filter((p) => (role ? p.role === role : true));
    return all.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async createProfile(input: { id: string; email: string; full_name: string; role: Role }): Promise<Profile> {
    if (this.profiles.has(input.id)) throw new Error('Profile already exists');
    const p: Profile = { ...input, is_active: true, created_at: this.now() };
    this.profiles.set(p.id, p);
    return p;
  }
  async setProfileRole(userId: string, role: Role): Promise<Profile | null> {
    const p = this.profiles.get(userId);
    if (!p) return null;
    p.role = role;
    return p;
  }
  async setProfileActive(userId: string, isActive: boolean): Promise<Profile | null> {
    const p = this.profiles.get(userId);
    if (!p) return null;
    p.is_active = isActive;
    return p;
  }
  async deleteProfile(userId: string): Promise<void> {
    this.profiles.delete(userId);
    this.panelMembers = this.panelMembers.filter((m) => m.judge_id !== userId);
  }

  async listPanels(): Promise<Panel[]> {
    return [...this.panels.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async getPanel(id: string): Promise<Panel | null> {
    return this.panels.get(id) ?? null;
  }
  async createPanel(input: { name: string; expected_evaluations?: number }): Promise<Panel> {
    if ([...this.panels.values()].some((p) => p.name === input.name)) {
      throw new Error('Panel name already exists');
    }
    const p: Panel = {
      id: randomUUID(),
      created_at: this.now(),
      is_active: true,
      name: input.name,
      expected_evaluations: 0,
    };
    this.panels.set(p.id, p);
    return p;
  }
  async updatePanel(
    id: string,
    patch: { name?: string; is_active?: boolean; expected_evaluations?: number },
  ): Promise<Panel | null> {
    const p = this.panels.get(id);
    if (!p) return null;
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.is_active !== undefined) p.is_active = patch.is_active;
    p.expected_evaluations = this.panelMembers.filter((m) => m.panel_id === id).length;
    return p;
  }
  async deletePanel(id: string): Promise<boolean> {
    if (!this.panels.has(id)) return false;
    for (const [evaluationId, evaluation] of this.evaluations) {
      if (evaluation.panel_id !== id) continue;
      this.evaluations.delete(evaluationId);
      this.criterionScores.delete(evaluationId);
    }
    for (const [candidateId, candidate] of this.candidates) {
      if (candidate.panel_id === id) this.candidates.delete(candidateId);
    }
    for (const [codeId, code] of this.panelCodes) {
      if (code.panel_id === id) this.panelCodes.delete(codeId);
    }
    this.panelMembers = this.panelMembers.filter((m) => m.panel_id !== id);
    this.panels.delete(id);
    return true;
  }
  async listMyPanels(judgeId: string): Promise<Panel[]> {
    const ids = this.panelMembers.filter((m) => m.judge_id === judgeId).map((m) => m.panel_id);
    return (await Promise.all(ids.map((id) => this.getPanel(id)))).filter((p): p is Panel => !!p);
  }

  async createPanelCode(input: {
    panel_id: string;
    code_hash: string;
    label: string;
    preview: string;
    expires_at?: string | null;
  }): Promise<PanelCodeMeta> {
    const row: PanelCodeMeta & { code_hash: string } = {
      id: randomUUID(),
      panel_id: input.panel_id,
      code_hash: input.code_hash,
      label: input.label,
      code_preview: input.preview,
      is_active: true,
      max_attempts: 5,
      failed_attempts: 0,
      locked_until: null,
      expires_at: input.expires_at ?? null,
      created_at: this.now(),
      rotated_at: null,
    };
    this.panelCodes.set(row.id, row);
    return this.toCodeMeta(row);
  }
  async rotatePanelCode(input: {
    panel_id: string;
    code_hash: string;
    label: string;
    preview: string;
    expires_at?: string | null;
  }): Promise<PanelCodeMeta> {
    for (const c of this.panelCodes.values()) {
      if (c.panel_id === input.panel_id && c.is_active) {
        c.is_active = false;
        c.rotated_at = this.now();
      }
    }
    return this.createPanelCode(input);
  }
  async setPanelCodeActive(codeId: string, isActive: boolean): Promise<PanelCodeMeta | null> {
    const c = this.panelCodes.get(codeId);
    if (!c) return null;
    c.is_active = isActive;
    if (!isActive) c.rotated_at = this.now();
    return this.toCodeMeta(c);
  }
  async listPanelCodes(panelId: string): Promise<PanelCodeMeta[]> {
    return [...this.panelCodes.values()]
      .filter((c) => c.panel_id === panelId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((c) => this.toCodeMeta(c));
  }
  private toCodeMeta(c: PanelCodeMeta & { code_hash: string }): PanelCodeMeta {
    const { code_hash: _h, ...meta } = c;
    return { ...meta };
  }

  /** Increment a code's failure counter; lock it when attempts are exhausted. */
  async recordFailedCodeAttempt(codeId: string, maxAttempts: number, lockoutMinutes: number): Promise<string | null> {
    const c = this.panelCodes.get(codeId);
    if (!c) return null;
    c.failed_attempts += 1;
    if (c.failed_attempts >= maxAttempts) {
      c.locked_until = new Date(Date.now() + lockoutMinutes * 60_000).toISOString();
    }
    return c.locked_until;
  }

  async addPanelMember(panelId: string, judgeId: string, assignedBy: string | null): Promise<void> {
    if (!this.panelMembers.some((m) => m.panel_id === panelId && m.judge_id === judgeId)) {
      this.panelMembers.push({ panel_id: panelId, judge_id: judgeId, verified_at: null });
    }
    const panel = this.panels.get(panelId);
    if (panel) {
      panel.expected_evaluations = this.panelMembers.filter((m) => m.panel_id === panelId).length;
    }
    void assignedBy;
  }
  async removePanelMember(panelId: string, judgeId: string): Promise<boolean> {
    const before = this.panelMembers.length;
    this.panelMembers = this.panelMembers.filter(
      (m) => !(m.panel_id === panelId && m.judge_id === judgeId),
    );
    const panel = this.panels.get(panelId);
    if (panel) {
      panel.expected_evaluations = this.panelMembers.filter((m) => m.panel_id === panelId).length;
    }
    return this.panelMembers.length < before;
  }
  async listPanelMembers(panelId: string): Promise<{ judge_id: string; judge_name: string; verified_at: string | null }[]> {
    return this.panelMembers
      .filter((m) => m.panel_id === panelId)
      .map((m) => ({
        judge_id: m.judge_id,
        judge_name: this.profiles.get(m.judge_id)?.full_name ?? '',
        verified_at: m.verified_at,
      }));
  }

  async listAllPanelMembers(): Promise<
    { panel_id: string; judge_id: string; judge_name: string; verified_at: string | null }[]
  > {
    return this.panelMembers.map((m) => ({
      panel_id: m.panel_id,
      judge_id: m.judge_id,
      judge_name: this.profiles.get(m.judge_id)?.full_name ?? '',
      verified_at: m.verified_at,
    }));
  }

  async verifyPanelCode(input: {
    code_hash: string;
    judge_id: string;
    lockout_minutes: number;
  }): Promise<VerifyOutcome> {
    const active = [...this.panelCodes.values()].filter((c) => c.is_active);
    const matches = active.filter((c) => c.code_hash === input.code_hash);
    const now = Date.now();
    if (matches.length === 0) return { status: 'invalid' };
    const live = matches.filter((c) => !c.expires_at || new Date(c.expires_at).getTime() > now);
    if (live.length === 0) {
      // Hash matched but every matching code is expired — count the failed attempt.
      for (const c of matches) await this.recordFailedCodeAttempt(c.id, c.max_attempts, input.lockout_minutes);
      return { status: 'invalid' };
    }
    const candidateCode = live[0];
    if (candidateCode.locked_until && new Date(candidateCode.locked_until).getTime() > now) {
      return { status: 'locked', retry_at: candidateCode.locked_until };
    }
    const panel = this.panels.get(candidateCode.panel_id);
    if (!panel) return { status: 'invalid' };
    if (!panel.is_active) {
      const lockedUntil = await this.recordFailedCodeAttempt(
        candidateCode.id,
        candidateCode.max_attempts,
        input.lockout_minutes,
      );
      if (lockedUntil) return { status: 'locked', retry_at: lockedUntil };
      return { status: 'panel_inactive' };
    }
    candidateCode.failed_attempts = 0;
    candidateCode.locked_until = null;
    if (!this.panelMembers.some((m) => m.panel_id === panel.id && m.judge_id === input.judge_id)) {
      this.panelMembers.push({
        panel_id: panel.id,
        judge_id: input.judge_id,
        verified_at: this.now(),
      });
    }
    return { status: 'ok', panel };
  }

  async listCandidates(scope: CandidateScope, filters: CandidateFilters): Promise<Candidate[]> {
    let rows = [...this.candidates.values()].filter((c) => {
      if (!scope.admin && !(scope.panelIds ?? []).includes(c.panel_id)) return false;
      if (!filters.includeArchived && c.archived_at) return false;
      if (filters.panelId && c.panel_id !== filters.panelId) return false;
      if (filters.verticalId && c.vertical_id !== filters.verticalId) return false;
      if (filters.shift !== undefined && filters.shift !== '' && (c.shift ?? '') !== filters.shift) return false;
      if (filters.priority !== undefined && c.priority !== filters.priority) return false;
      if (filters.branch && !c.branch.toLowerCase().includes(filters.branch.toLowerCase())) return false;
      if (filters.interviewStatus && c.interview_status !== filters.interviewStatus) return false;
      if (filters.shortlistingStatus && c.shortlisting_status !== filters.shortlistingStatus) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        const hay = `${c.full_name} ${c.application_id ?? ''} ${c.roll_number ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (filters.evaluationStatus) {
      const results = await this.results(scope, { includeArchived: true });
      const byId = new Map(results.map((r) => [r.candidate_id, r.evaluation_status]));
      rows = rows.filter((c) => byId.get(c.id) === filters.evaluationStatus);
    }
    const order = filters.order === 'desc' ? -1 : 1;
    const averages = new Map<string, number | null>();
    if (filters.sort === 'average') {
      const results = await this.results(scope, { includeArchived: true });
      for (const r of results) averages.set(r.candidate_id, r.average_score);
    }
    rows.sort((a, b) => {
      let cmp = 0;
      switch (filters.sort) {
        case 'branch':
          cmp = a.branch.localeCompare(b.branch);
          break;
        case 'priority':
          cmp = (a.priority ?? 999) - (b.priority ?? 999);
          break;
        case 'roll':
          cmp = (a.roll_number ?? '').localeCompare(b.roll_number ?? '');
          break;
        case 'average': {
          const av = averages.get(a.id) ?? -1;
          const bv = averages.get(b.id) ?? -1;
          cmp = av - bv;
          break;
        }
        case 'created':
          cmp = a.created_at.localeCompare(b.created_at);
          break;
        default:
          cmp = a.full_name.localeCompare(b.full_name);
      }
      if (cmp === 0) cmp = a.full_name.localeCompare(b.full_name);
      return cmp * order;
    });
    return rows.map((c) => (scope.admin ? c : { ...c, notes: '' }));
  }
  async getCandidate(id: string, scope: CandidateScope): Promise<Candidate | null> {
    const c = this.candidates.get(id);
    if (!c) return null;
    if (!scope.admin && !(scope.panelIds ?? []).includes(c.panel_id)) return null;
    return scope.admin ? c : { ...c, notes: '' };
  }
  async createCandidate(
    input: { full_name: string; branch: string; application_id: string | null; panel_id: string },
    actorId: string,
  ): Promise<Candidate> {
    if (
      input.application_id &&
      [...this.candidates.values()].some(
        (c) => c.application_id === input.application_id && c.panel_id === input.panel_id,
      )
    ) {
      throw new Error('application_id already exists');
    }
    const c: Candidate = {
      id: randomUUID(),
      interview_status: 'pending',
      shortlisting_status: 'pending',
      notes: '',
      archived_at: null,
      created_at: this.now(),
      updated_at: this.now(),
      ...input,
      application_id: input.application_id || null,
    };
    void actorId;
    this.candidates.set(c.id, c);
    return c;
  }
  async updateCandidate(id: string, patch: Partial<Omit<Candidate, 'id'>>): Promise<Candidate | null> {
    const c = this.candidates.get(id);
    if (!c) return null;
    Object.assign(c, patch, { updated_at: this.now() });
    return c;
  }
  async archiveCandidate(id: string, archived: boolean): Promise<Candidate | null> {
    const c = this.candidates.get(id);
    if (!c) return null;
    c.archived_at = archived ? this.now() : null;
    c.updated_at = this.now();
    return c;
  }
  async bulkCreateCandidates(
    rows: { full_name: string; branch: string; application_id: string | null; panel_id: string }[],
    _actorId: string,
  ): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped_duplicates: 0, errors: [] };
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row.full_name) {
        result.errors.push({ row: i + 2, message: 'full_name is required' });
        continue;
      }
      if (!this.panels.has(row.panel_id)) {
        result.errors.push({ row: i + 2, message: 'Panel not found' });
        continue;
      }
      if (row.application_id) {
        const dupKey = `${row.application_id}::${row.panel_id}`;
        if (
          seen.has(dupKey) ||
          [...this.candidates.values()].some(
            (c) => c.application_id === row.application_id && c.panel_id === row.panel_id,
          )
        ) {
          result.skipped_duplicates += 1;
          continue;
        }
        seen.add(dupKey);
      }
      await this.createCandidate(row, _actorId);
      result.imported += 1;
    }
    return result;
  }

  async listRounds(): Promise<Round[]> {
    return [...this.rounds.values()];
  }
  async getRound(id: string): Promise<Round | null> {
    return this.rounds.get(id) ?? null;
  }
  async createRound(input: {
    name: string;
    is_open: boolean;
    allow_edit_after_submit: boolean;
    closes_at: string | null;
  }): Promise<Round> {
    const r: Round = { id: randomUUID(), ...input };
    this.rounds.set(r.id, r);
    return r;
  }
  async updateRound(
    id: string,
    patch: Partial<{ name: string; is_open: boolean; allow_edit_after_submit: boolean; closes_at: string | null }>,
  ): Promise<Round | null> {
    const r = this.rounds.get(id);
    if (!r) return null;
    Object.assign(r, patch);
    return r;
  }

  async deleteRound(id: string, force = false): Promise<{ deleted: boolean; evaluations: number }> {
    if (!this.rounds.has(id)) return { deleted: false, evaluations: 0 };
    const evaluations = [...this.evaluations.values()].filter((e) => e.round_id === id);
    if (evaluations.length > 0 && !force) return { deleted: false, evaluations: evaluations.length };
    for (const e of evaluations) {
      this.evaluations.delete(e.id);
      this.criterionScores.delete(e.id);
    }
    for (const [criterionId, criterion] of this.criteria) {
      if (criterion.round_id === id) this.criteria.delete(criterionId);
    }
    this.rounds.delete(id);
    return { deleted: true, evaluations: evaluations.length };
  }

  async listCriteria(roundId: string): Promise<Criterion[]> {
    return [...this.criteria.values()]
      .filter((c) => c.round_id === roundId)
      .sort((a, b) => a.sort_order - b.sort_order);
  }
  async createCriterion(input: Omit<Criterion, 'id' | 'created_at'>): Promise<Criterion> {
    const c: Criterion = { id: randomUUID(), ...input };
    this.criteria.set(c.id, c);
    return c;
  }
  async updateCriterion(id: string, patch: Partial<Criterion>): Promise<Criterion | null> {
    const c = this.criteria.get(id);
    if (!c) return null;
    Object.assign(c, patch);
    return c;
  }

  async deleteCriterion(id: string, force = false): Promise<{ deleted: boolean; scores: number }> {
    if (!this.criteria.has(id)) return { deleted: false, scores: 0 };
    let scores = 0;
    for (const list of this.criterionScores.values()) {
      scores += list.filter((s) => s.criterion_id === id).length;
    }
    if (scores > 0 && !force) return { deleted: false, scores };
    if (scores > 0) {
      for (const [evaluationId, list] of this.criterionScores) {
        this.criterionScores.set(evaluationId, list.filter((s) => s.criterion_id !== id));
      }
    }
    this.criteria.delete(id);
    return { deleted: true, scores };
  }

  async getEvaluation(id: string): Promise<EvaluationWithScores | null> {
    const e = this.evaluations.get(id);
    if (!e) return null;
    return this.withScores(e);
  }
  async deleteEvaluation(id: string): Promise<EvaluationWithScores | null> {
    const e = this.evaluations.get(id);
    if (!e) return null;
    const full = await this.withScores(e);
    this.evaluations.delete(id);
    this.criterionScores.delete(id);
    return full;
  }
  async getOfficialEvaluation(
    judgeId: string,
    candidateId: string,
    roundId: string,
  ): Promise<EvaluationWithScores | null> {
    for (const e of this.evaluations.values()) {
      if (
        e.judge_id === judgeId &&
        e.candidate_id === candidateId &&
        e.round_id === roundId &&
        e.status === 'submitted'
      ) {
        return this.withScores(e);
      }
    }
    return null;
  }
  async listEvaluations(filter: {
    admin: boolean;
    judgeId?: string;
    candidateId?: string;
    panelIds?: string[];
  }): Promise<EvaluationWithScores[]> {
    const out: EvaluationWithScores[] = [];
    for (const e of this.evaluations.values()) {
      if (!filter.admin) {
        if (filter.judgeId && e.judge_id !== filter.judgeId) continue;
        if (filter.panelIds && !filter.panelIds.includes(e.panel_id)) continue;
      } else if (filter.judgeId && e.judge_id !== filter.judgeId) continue;
      if (filter.candidateId && e.candidate_id !== filter.candidateId) continue;
      out.push(await this.withScores(e));
    }
    return out.sort((a, b) => b.submitted_at.localeCompare(a.submitted_at));
  }

  async submitEvaluation(
    judgeId: string,
    input: SubmitEvaluationInput,
    computed: { overall_score: number | null; scores: CriterionScore[] },
    opts: { replaceExisting: boolean },
  ): Promise<SubmitOutcome> {
    if (this.evaluations.has(input.id)) {
      const existing = this.evaluations.get(input.id)!;
      if (existing.judge_id !== judgeId) {
        return { status: 'error', message: 'Evaluation ID already used' };
      }
      const samePayload =
        existing.feedback === input.feedback &&
        existing.overall_score === computed.overall_score &&
        existing.preferred_vertical_id === (input.preferred_vertical_id ?? null) &&
        JSON.stringify([...(this.criterionScores.get(input.id) ?? [])].sort((a, b) => a.criterion_id.localeCompare(b.criterion_id))) ===
          JSON.stringify([...computed.scores].sort((a, b) => a.criterion_id.localeCompare(b.criterion_id)));
      if (samePayload) {
        return { status: 'ok', evaluation: await this.withScores(existing), idempotent: true };
      }
      // Same client id, different payload: an offline edit of a synced item.
      const round = this.rounds.get(input.round_id);
      if (opts.replaceExisting && round?.allow_edit_after_submit) {
        existing.feedback = input.feedback;
        existing.overall_score = computed.overall_score;
        existing.preferred_vertical_id = input.preferred_vertical_id ?? null;
        existing.version += 1;
        existing.updated_at = this.now();
        this.criterionScores.set(existing.id, computed.scores);
        return { status: 'ok', evaluation: await this.withScores(existing) };
      }
      // Never silently overwrite: keep the server copy, report idempotent.
      return { status: 'ok', evaluation: await this.withScores(existing), idempotent: true };
    }
    const candidate = this.candidates.get(input.candidate_id);
    if (!candidate || candidate.archived_at) {
      return { status: 'error', message: 'Candidate not found' };
    }
    const round = this.rounds.get(input.round_id);
    if (!round) return { status: 'error', message: 'Round not found' };
    const official = await this.getOfficialEvaluation(judgeId, input.candidate_id, input.round_id);
    if (official) {
      if (opts.replaceExisting && round.allow_edit_after_submit) {
        official.feedback = input.feedback;
        official.overall_score = computed.overall_score;
        official.preferred_vertical_id = input.preferred_vertical_id ?? null;
        official.version += 1;
        official.updated_at = this.now();
        this.criterionScores.set(official.id, computed.scores);
        return { status: 'ok', evaluation: await this.withScores(official) };
      }
      return { status: 'duplicate', existing: official };
    }
    const e: Evaluation = {
      id: input.id,
      candidate_id: input.candidate_id,
      judge_id: judgeId,
      panel_id: candidate.panel_id,
      round_id: input.round_id,
      status: 'submitted',
      overall_score: computed.overall_score,
      feedback: input.feedback,
      preferred_vertical_id: input.preferred_vertical_id ?? null,
      version: 1,
      client_created_at: input.client_created_at ?? null,
      submitted_at: this.now(),
      updated_at: this.now(),
    };
    this.evaluations.set(e.id, e);
    this.criterionScores.set(e.id, computed.scores);
    return { status: 'ok', evaluation: await this.withScores(e) };
  }

  async updateEvaluation(
    id: string,
    judgeId: string,
    patch: {
      feedback: string;
      overall_score: number | null;
      scores: CriterionScore[];
      preferred_vertical_id: string | null;
    },
  ): Promise<SubmitOutcome> {
    const e = this.evaluations.get(id);
    if (!e) return { status: 'error', message: 'Evaluation not found' };
    if (e.judge_id !== judgeId) return { status: 'error', message: 'Not your evaluation' };
    e.feedback = patch.feedback;
    e.overall_score = patch.overall_score;
    e.preferred_vertical_id = patch.preferred_vertical_id;
    e.version += 1;
    e.updated_at = this.now();
    this.criterionScores.set(e.id, patch.scores);
    return { status: 'ok', evaluation: await this.withScores(e) };
  }

  async results(scope: CandidateScope, filters: CandidateFilters): Promise<ResultRow[]> {
    const all = [...this.candidates.values()].filter((c) => {
      if (!scope.admin && !(scope.panelIds ?? []).includes(c.panel_id)) return false;
      if (!filters.includeArchived && c.archived_at) return false;
      if (filters.panelId && c.panel_id !== filters.panelId) return false;
      if (filters.verticalId && c.vertical_id !== filters.verticalId) return false;
      if (filters.shift !== undefined && filters.shift !== '' && (c.shift ?? '') !== filters.shift) return false;
      if (filters.priority !== undefined && c.priority !== filters.priority) return false;
      if (filters.branch && !c.branch.toLowerCase().includes(filters.branch.toLowerCase())) return false;
      if (filters.interviewStatus && c.interview_status !== filters.interviewStatus) return false;
      if (filters.shortlistingStatus && c.shortlisting_status !== filters.shortlistingStatus) return false;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!`${c.full_name} ${c.application_id ?? ''} ${c.roll_number ?? ''}`.toLowerCase().includes(q)) return false;
      }
      return true;
    });
    const rows: ResultRow[] = [];
    for (const c of all) {
      const submitted = [...this.evaluations.values()].filter(
        (e) => e.candidate_id === c.id && e.status === 'submitted',
      );
      const panel = this.panels.get(c.panel_id)!;
      const scores = submitted.map((e) => e.overall_score).filter((s): s is number => s !== null);
      const count = submitted.length;
      const expected = this.panelMembers.filter((m) => m.panel_id === c.panel_id).length;
      const vertical = c.vertical_id ? this.verticals.get(c.vertical_id) : null;
      rows.push({
        candidate_id: c.id,
        full_name: c.full_name,
        branch: c.branch,
        application_id: c.application_id,
        roll_number: c.roll_number ?? '',
        panel_id: c.panel_id,
        panel_name: panel?.name ?? '',
        expected_evaluations: expected,
        vertical_id: c.vertical_id ?? null,
        vertical_name: vertical?.name ?? null,
        shift: c.shift ?? '',
        priority: c.priority ?? null,
        interview_status: c.interview_status,
        shortlisting_status: c.shortlisting_status,
        evaluation_count: count,
        average_score: meanOrNull(scores),
        evaluation_status: count === 0 ? 'not_started' : count < expected ? 'in_progress' : 'complete',
        is_provisional: count < expected,
        archived_at: c.archived_at,
        judge_ratings: submitted.map((e) => ({
          judge_id: e.judge_id,
          judge_name: this.profiles.get(e.judge_id)?.full_name ?? '',
          score: e.overall_score,
          evaluation_id: e.id,
          submitted_at: e.submitted_at,
          version: e.version,
        })),
      });
    }
    const order = filters.order === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      let cmp = 0;
      switch (filters.sort) {
        case 'branch':
          cmp = a.branch.localeCompare(b.branch);
          break;
        case 'priority':
          cmp = (a.priority ?? 999) - (b.priority ?? 999);
          break;
        case 'roll':
          cmp = (a.roll_number ?? '').localeCompare(b.roll_number ?? '');
          break;
        case 'average':
          cmp = (a.average_score ?? -1) - (b.average_score ?? -1);
          break;
        case 'created':
          cmp = a.candidate_id.localeCompare(b.candidate_id);
          break;
        default:
          cmp = a.full_name.localeCompare(b.full_name);
      }
      if (cmp === 0) cmp = a.full_name.localeCompare(b.full_name);
      return cmp * order;
    });
    return rows;
  }

  // --- addendum: verticals ---
  async listVerticals(onlyActive = false): Promise<Vertical[]> {
    return [...this.verticals.values()]
      .filter((v) => (onlyActive ? v.is_active : true))
      .sort((a, b) => a.sort_order - b.sort_order);
  }
  async getVertical(id: string): Promise<Vertical | null> {
    return this.verticals.get(id) ?? null;
  }
  async createVertical(input: { key: string; name: string; worksheet?: string | null; sort_order?: number }): Promise<Vertical> {
    if ([...this.verticals.values()].some((v) => v.key === input.key)) throw new Error('Vertical key already exists');
    const v: Vertical = {
      id: randomUUID(),
      key: input.key,
      name: input.name,
      worksheet: input.worksheet ?? null,
      is_active: true,
      sort_order: input.sort_order ?? this.verticals.size + 1,
    };
    this.verticals.set(v.id, v);
    return v;
  }
  async updateVertical(
    id: string,
    patch: Partial<{ name: string; worksheet: string | null; is_active: boolean; sort_order: number }>,
  ): Promise<Vertical | null> {
    const v = this.verticals.get(id);
    if (!v) return null;
    Object.assign(v, patch);
    return v;
  }

  // --- addendum: workbook import with stable identity ---
  async importApplicants(rows: ImportedApplicant[], _actorId: string): Promise<ImportApplicantsResult> {
    const result: ImportApplicantsResult = { created: 0, updated: 0, skipped_duplicates: 0, errors: [], conflicts: [] };
    const seen = new Set<string>();
    for (const row of rows) {
      const sheetKey = `${row.sourceSheet}::${row.sourceKey}`;
      if (seen.has(sheetKey)) {
        result.skipped_duplicates += 1;
        continue;
      }
      seen.add(sheetKey);
      if (!row.full_name) {
        result.errors.push({ row: row.sourceRow, sheet: row.sourceSheet, reason: 'missing applicant name' });
        continue;
      }
      // 1) exact (sheet, key) match
      let existing =
        [...this.candidates.values()].find(
          (c) => c.source_sheet === row.sourceSheet && c.source_key === row.sourceKey,
        ) ?? null;
      // 2) roll number / application_id — same sheet only, so an applicant
      // who applied to multiple verticals is kept once per vertical.
      if (!existing && row.roll_number) {
        existing =
          [...this.candidates.values()].find(
            (c) =>
              c.source_sheet === row.sourceSheet &&
              (c.roll_number || c.application_id || '').toUpperCase() === row.roll_number.toUpperCase(),
          ) ?? null;
      }
      // 3) email — same sheet only (never collapse across verticals).
      if (!existing && row.email) {
        existing =
          [...this.candidates.values()].find(
            (c) => c.source_sheet === row.sourceSheet && c.email?.toLowerCase() === row.email.toLowerCase(),
          ) ?? null;
      }

      if (!existing) {
        const panelId = this.resolvePanelForImport(row.panel, row.shift);
        const c: Candidate = {
          id: randomUUID(),
          full_name: row.full_name,
          branch: row.branch,
          application_id: row.roll_number || null,
          panel_id: panelId,
          interview_status: 'pending',
          shortlisting_status: 'pending',
          notes: '',
          archived_at: null,
          created_at: this.now(),
          updated_at: this.now(),
          vertical_id: this.verticalIdForSheet(row.sourceSheet),
          shift: row.shift,
          priority: row.priority,
          email: row.email,
          roll_number: row.roll_number,
          linkedin_url: row.linkedin_url,
          github_url: row.github_url,
          team_message: row.team_message,
          remarks: row.remarks,
          task_links: row.task_links,
          external_profiles: row.external_profiles,
          source_extra: row.source_extra,
          source_key: row.sourceKey,
          source_sheet: row.sourceSheet,
          source_row: row.sourceRow,
          last_synced_at: this.now(),
        };
        this.candidates.set(c.id, c);
        result.created += 1;
        continue;
      }
      // Update in place: only fill/overwrite from non-empty incoming values so
      // existing information is never wiped by a sparse re-import.
      const patchEmpty = (cur: string | null | undefined, incoming: string): string =>
        incoming && incoming.trim() ? incoming : (cur ?? '');
      const before = { ...existing };
      existing.full_name = patchEmpty(existing.full_name, row.full_name);
      existing.branch = patchEmpty(existing.branch, row.branch);
      if (row.roll_number) {
        existing.roll_number = row.roll_number;
        existing.application_id = row.roll_number;
      }
      existing.email = patchEmpty(existing.email, row.email);
      existing.shift = patchEmpty(existing.shift, row.shift);
      if (row.priority !== null) existing.priority = row.priority;
      existing.linkedin_url = patchEmpty(existing.linkedin_url, row.linkedin_url);
      existing.github_url = patchEmpty(existing.github_url, row.github_url);
      existing.team_message = patchEmpty(existing.team_message, row.team_message);
      existing.remarks = patchEmpty(existing.remarks, row.remarks);
      if (row.task_links.length) existing.task_links = row.task_links;
      if (row.external_profiles.length) existing.external_profiles = row.external_profiles;
      if (row.source_extra && Object.keys(row.source_extra).length) {
        existing.source_extra = { ...(existing.source_extra ?? {}), ...row.source_extra };
      }
      existing.source_key = existing.source_key ?? row.sourceKey;
      existing.source_sheet = existing.source_sheet ?? row.sourceSheet;
      existing.source_row = row.sourceRow;
      existing.updated_at = this.now();
      existing.last_synced_at = this.now();
      if (before.full_name !== existing.full_name) {
        result.conflicts.push({
          row: row.sourceRow,
          sheet: row.sourceSheet,
          field: 'full_name',
          kept: existing.full_name,
          incoming: row.full_name,
        });
      }
      result.updated += 1;
    }
    return result;
  }

  private verticalIdForSheet(sheetName: string): string | null {
    const norm = sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    for (const v of this.verticals.values()) {
      if (v.worksheet && v.worksheet.toLowerCase() === sheetName.toLowerCase()) return v.id;
      if (v.key === norm || v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === norm) return v.id;
    }
    return null;
  }

  private resolvePanelForImport(panelName: string, shift: string): string {
    const name = (panelName || '').trim();
    if (name) {
      const found = [...this.panels.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
      if (found) return found.id;
      const created: Panel = {
        id: randomUUID(),
        name,
        is_active: true,
        expected_evaluations: 0,
        created_at: this.now(),
        shift: shift || '',
      };
      this.panels.set(created.id, created);
      return created.id;
    }
    const fallbackName = 'Imported';
    const found = [...this.panels.values()].find((p) => p.name === fallbackName);
    if (found) return found.id;
    const created: Panel = {
      id: randomUUID(),
      name: fallbackName,
      is_active: true,
      expected_evaluations: 0,
      created_at: this.now(),
    };
    this.panels.set(created.id, created);
    return created.id;
  }

  // --- addendum: spreadsheet sync queue ---
  async enqueueSpreadsheetSync(item: {
    direction: 'to_sheet' | 'from_sheet';
    entity_type: 'applicant' | 'evaluation';
    entity_id: string;
    worksheet: string;
    row_key: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    for (const q of this.syncQueue.values()) {
      if (q.direction === item.direction && q.entity_type === item.entity_type && q.entity_id === item.entity_id) {
        // coalesce: latest payload wins, reset to pending
        q.payload = item.payload;
        q.worksheet = item.worksheet;
        q.row_key = item.row_key;
        q.status = 'pending';
        q.updated_at = this.now();
        return;
      }
    }
    const row: SpreadsheetSyncItem = {
      id: randomUUID(),
      direction: item.direction,
      entity_type: item.entity_type,
      entity_id: item.entity_id,
      worksheet: item.worksheet,
      row_key: item.row_key,
      payload: item.payload,
      status: 'pending',
      attempts: 0,
      last_error: '',
      conflict: null,
      created_at: this.now(),
      updated_at: this.now(),
    };
    this.syncQueue.set(row.id, row);
  }
  async claimSpreadsheetSync(limit: number): Promise<SpreadsheetSyncItem[]> {
    const now = Date.now();
    const claimed: SpreadsheetSyncItem[] = [];
    for (const q of this.syncQueue.values()) {
      if (claimed.length >= limit) break;
      if (q.status === 'pending') {
        q.status = 'in_flight';
        q.updated_at = this.now();
        claimed.push({ ...q });
      } else if (q.status === 'in_flight' && new Date(q.updated_at).getTime() + 60_000 < now) {
        // stale lease
        q.updated_at = this.now();
        claimed.push({ ...q });
      }
    }
    return claimed;
  }
  async completeSpreadsheetSync(
    id: string,
    status: 'done' | 'failed' | 'conflict' | 'pending',
    detail: { error?: string; conflict?: Record<string, unknown>; attempts?: number },
  ): Promise<void> {
    const q = this.syncQueue.get(id);
    if (!q) return;
    q.status = status;
    if (detail.attempts !== undefined) q.attempts = detail.attempts;
    q.last_error = detail.error ?? '';
    q.conflict = detail.conflict ?? null;
    q.updated_at = this.now();
    if (status === 'done') {
      // keep the row for a short audit trail but mark it done; retries re-enqueue
      q.payload = {};
    }
  }
  async listSpreadsheetSync(status?: string): Promise<SpreadsheetSyncItem[]> {
    return [...this.syncQueue.values()]
      .filter((q) => (status ? q.status === status : true))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  async getSpreadsheetConnection(): Promise<SpreadsheetConnection | null> {
    return this.spreadsheetConnection;
  }
  async saveSpreadsheetConnection(patch: Partial<SpreadsheetConnection>): Promise<SpreadsheetConnection> {
    const cur = this.spreadsheetConnection;
    const next: SpreadsheetConnection = {
      id: cur?.id ?? randomUUID(),
      kind: patch.kind ?? cur?.kind ?? 'google_sheets',
      spreadsheet_id: patch.spreadsheet_id ?? cur?.spreadsheet_id ?? '',
      title: patch.title ?? cur?.title ?? '',
      header_row: patch.header_row ?? cur?.header_row ?? 1,
      is_active: patch.is_active ?? cur?.is_active ?? true,
      last_sync_at: patch.last_sync_at ?? cur?.last_sync_at ?? null,
      last_sync_status: patch.last_sync_status ?? cur?.last_sync_status ?? 'never',
      last_sync_error: patch.last_sync_error ?? cur?.last_sync_error ?? '',
      sheet_revision: patch.sheet_revision ?? cur?.sheet_revision ?? '',
    };
    this.spreadsheetConnection = next;
    return next;
  }
  async logSpreadsheetSync(entry: {
    connection_id: string | null;
    direction: string;
    operation: string;
    row_key: string;
    status: 'ok' | 'error' | 'conflict';
    detail: string;
    actor_id: string | null;
  }): Promise<void> {
    this.syncLog.push({ ...entry, created_at: this.now() });
  }

  async audit(entry: AuditEntry): Promise<void> {
    this.audits.push(entry);
  }

  private async withScores(e: Evaluation): Promise<EvaluationWithScores> {
    return {
      ...e,
      scores: this.criterionScores.get(e.id) ?? [],
      judge_name: this.profiles.get(e.judge_id)?.full_name,
      candidate_name: this.candidates.get(e.candidate_id)?.full_name,
      round_name: this.rounds.get(e.round_id)?.name,
    };
  }
}

export const round2Export = round2;
