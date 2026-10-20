import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { meanOrNull } from '../lib/scoring.js';
import type {
  AuditEntry,
  Candidate,
  CandidateFilters,
  CandidateScope,
  Criterion,
  CriterionScore,
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
  Store,
  SubmitEvaluationInput,
  SubmitOutcome,
  VerifyOutcome,
  Vertical,
  SpreadsheetConnection,
  SpreadsheetSyncItem,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function unwrap<T>(res: { data: T; error: any }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message ?? res.error}`);
  return res.data as T;
}

export class SupabaseStore implements Store {
  private sb: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.sb = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  // ---- profiles ----------------------------------------------------------
  async getProfile(id: string): Promise<Profile | null> {
    const { data, error } = await this.sb.from('profiles').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`getProfile: ${error.message}`);
    return data as Profile | null;
  }
  async getProfilesByIds(ids: string[]): Promise<Profile[]> {
    if (ids.length === 0) return [];
    return unwrap(
      await this.sb.from('profiles').select('*').in('id', ids),
      'getProfilesByIds',
    ) as Profile[];
  }
  async listProfiles(role?: Role): Promise<Profile[]> {
    let q = this.sb.from('profiles').select('*').order('created_at', { ascending: true });
    if (role) q = q.eq('role', role);
    return unwrap(await q, 'listProfiles') as Profile[];
  }
  async createProfile(input: { id: string; email: string; full_name: string; role: Role }): Promise<Profile> {
    return unwrap(
      await this.sb
        .from('profiles')
        .insert({ ...input, is_active: true })
        .select('*')
        .single(),
      'createProfile',
    ) as Profile;
  }
  async setProfileRole(userId: string, role: Role): Promise<Profile | null> {
    const { data, error } = await this.sb
      .from('profiles')
      .update({ role })
      .eq('id', userId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`setProfileRole: ${error.message}`);
    return data as Profile | null;
  }
  async setProfileActive(userId: string, isActive: boolean): Promise<Profile | null> {
    const { data, error } = await this.sb
      .from('profiles')
      .update({ is_active: isActive })
      .eq('id', userId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`setProfileActive: ${error.message}`);
    return data as Profile | null;
  }
  async deleteProfile(userId: string): Promise<void> {
    // audit_events.actor_id has no ON DELETE CASCADE — clear it first.
    const { error: auditErr } = await this.sb.from('audit_events').delete().eq('actor_id', userId);
    if (auditErr) throw new Error(`deleteProfile(audit): ${auditErr.message}`);
    const { error } = await this.sb.from('profiles').delete().eq('id', userId);
    if (error) throw new Error(`deleteProfile: ${error.message}`);
  }

  // ---- panels ------------------------------------------------------------
  async listPanels(): Promise<Panel[]> {
    return unwrap(await this.sb.from('panels').select('*').order('name'), 'listPanels') as Panel[];
  }
  async getPanel(id: string): Promise<Panel | null> {
    const { data, error } = await this.sb.from('panels').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`getPanel: ${error.message}`);
    return data as Panel | null;
  }
  async createPanel(input: { name: string; expected_evaluations?: number }): Promise<Panel> {
    return unwrap(
      await this.sb
        .from('panels')
        .insert({ name: input.name, expected_evaluations: 0 })
        .select('*')
        .single(),
      'createPanel',
    ) as Panel;
  }
  async updatePanel(
    id: string,
    patch: { name?: string; is_active?: boolean; expected_evaluations?: number },
  ): Promise<Panel | null> {
    const update: { name?: string; is_active?: boolean } = {};
    if (patch.name !== undefined) update.name = patch.name;
    if (patch.is_active !== undefined) update.is_active = patch.is_active;
    if (Object.keys(update).length === 0) return this.getPanel(id);
    const { data, error } = await this.sb
      .from('panels')
      .update(update)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`updatePanel: ${error.message}`);
    return data as Panel | null;
  }
  /** Permanently deletes a panel with its codes, memberships, candidates and evaluations. */
  async deletePanel(id: string): Promise<boolean> {
    const existing = await this.getPanel(id);
    if (!existing) return false;
    // Evaluations reference both the panel and its candidates; criterion scores
    // cascade from evaluations.
    const evaluations = await this.sb.from('evaluations').delete().eq('panel_id', id);
    if (evaluations.error) throw new Error(`deletePanel(evaluations): ${evaluations.error.message}`);
    const candidates = await this.sb.from('candidates').delete().eq('panel_id', id);
    if (candidates.error) throw new Error(`deletePanel(candidates): ${candidates.error.message}`);
    // Codes and memberships cascade from the panel itself.
    const panel = await this.sb.from('panels').delete().eq('id', id);
    if (panel.error) throw new Error(`deletePanel(panels): ${panel.error.message}`);
    return true;
  }
  async listMyPanels(judgeId: string): Promise<Panel[]> {
    const rows = (await unwrap(
      await this.sb
        .from('panel_members')
        .select('panels(*)')
        .eq('judge_id', judgeId),
      'listMyPanels',
    )) as unknown as any[] | null;
    return (rows ?? []).map((row: any) => row.panels as Panel).filter(Boolean);
  }

  // ---- panel codes -------------------------------------------------------
  async createPanelCode(input: {
    panel_id: string;
    code_hash: string;
    label: string;
    preview: string;
    expires_at?: string | null;
  }): Promise<PanelCodeMeta> {
    const row = unwrap(
      await this.sb
        .from('panel_codes')
        .insert({
          panel_id: input.panel_id,
          code_hash: input.code_hash,
          label: input.label,
          preview: input.preview,
          expires_at: input.expires_at ?? null,
        })
        .select('*')
        .single(),
      'createPanelCode',
    ) as any;
    return this.toCodeMeta(row);
  }
  async rotatePanelCode(input: {
    panel_id: string;
    code_hash: string;
    label: string;
    preview: string;
    expires_at?: string | null;
  }): Promise<PanelCodeMeta> {
    await this.sb
      .from('panel_codes')
      .update({ is_active: false, rotated_at: new Date().toISOString() })
      .eq('panel_id', input.panel_id)
      .eq('is_active', true);
    const row = unwrap(
      await this.sb
        .from('panel_codes')
        .insert({
          panel_id: input.panel_id,
          code_hash: input.code_hash,
          label: input.label,
          preview: input.preview,
          expires_at: input.expires_at ?? null,
        })
        .select('*')
        .single(),
      'rotatePanelCode',
    ) as any;
    return this.toCodeMeta(row);
  }
  async setPanelCodeActive(codeId: string, isActive: boolean): Promise<PanelCodeMeta | null> {
    const { data, error } = await this.sb
      .from('panel_codes')
      .update({ is_active: isActive, rotated_at: isActive ? null : new Date().toISOString() })
      .eq('id', codeId)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`setPanelCodeActive: ${error.message}`);
    return data ? this.toCodeMeta(data as any) : null;
  }
  async listPanelCodes(panelId: string): Promise<PanelCodeMeta[]> {
    const rows = unwrap(
      await this.sb
        .from('panel_codes')
        .select('*')
        .eq('panel_id', panelId)
        .order('created_at', { ascending: false }),
      'listPanelCodes',
    ) as any[];
    return rows.map((r) => this.toCodeMeta(r));
  }
  private toCodeMeta(row: any): PanelCodeMeta {
    return {
      id: row.id,
      panel_id: row.panel_id,
      label: row.label ?? '',
      is_active: row.is_active,
      max_attempts: row.max_attempts,
      failed_attempts: row.failed_attempts,
      locked_until: row.locked_until,
      expires_at: row.expires_at,
      created_at: row.created_at,
      rotated_at: row.rotated_at,
      code_preview: row.preview ?? '',
    };
  }

  async verifyPanelCode(input: {
    code_hash: string;
    judge_id: string;
    lockout_minutes: number;
  }): Promise<VerifyOutcome> {
    const { data: rows, error } = await this.sb
      .from('panel_codes')
      .select('*, panels(*)')
      .eq('code_hash', input.code_hash)
      .eq('is_active', true);
    if (error) throw new Error(`verifyPanelCode: ${error.message}`);
    const now = Date.now();
    const list = (rows ?? []).filter(
      (r: any) => !r.expires_at || new Date(r.expires_at).getTime() > now,
    );
    if (list.length === 0) return { status: 'invalid' };
    const code = list[0] as any;
    if (code.locked_until && new Date(code.locked_until).getTime() > now) {
      return { status: 'locked', retry_at: code.locked_until };
    }
    const panel = code.panels as Panel | null;
    if (!panel) return { status: 'invalid' };
    if (!panel.is_active) {
      const lockedUntil = await this.recordFailedCodeAttempt(
        code.id,
        code.max_attempts ?? 5,
        input.lockout_minutes,
      );
      if (lockedUntil) return { status: 'locked', retry_at: lockedUntil };
      return { status: 'panel_inactive' };
    }
    await this.sb
      .from('panel_codes')
      .update({ failed_attempts: 0, locked_until: null })
      .eq('id', code.id);
    const { error: memberErr } = await this.sb.from('panel_members').upsert(
      {
        panel_id: panel.id,
        judge_id: input.judge_id,
        verified_at: new Date().toISOString(),
      },
      { onConflict: 'panel_id,judge_id', ignoreDuplicates: true },
    );
    if (memberErr) throw new Error(`verifyPanelCode membership: ${memberErr.message}`);
    return { status: 'ok', panel };
  }

  /** Record a failed verification attempt; lock the code when attempts are exhausted. */
  async recordFailedCodeAttempt(codeId: string, maxAttempts: number, lockoutMinutes: number): Promise<string | null> {
    const { data: code, error } = await this.sb
      .from('panel_codes')
      .select('failed_attempts')
      .eq('id', codeId)
      .single();
    if (error) return null;
    const attempts = (code.failed_attempts ?? 0) + 1;
    let lockedUntil: string | null = null;
    if (attempts >= maxAttempts) {
      lockedUntil = new Date(Date.now() + lockoutMinutes * 60_000).toISOString();
    }
    await this.sb
      .from('panel_codes')
      .update({ failed_attempts: attempts, locked_until: lockedUntil })
      .eq('id', codeId);
    return lockedUntil;
  }

  async addPanelMember(panelId: string, judgeId: string, assignedBy: string | null): Promise<void> {
    const { error } = await this.sb.from('panel_members').upsert(
      { panel_id: panelId, judge_id: judgeId, assigned_by: assignedBy },
      { onConflict: 'panel_id,judge_id', ignoreDuplicates: true },
    );
    if (error) throw new Error(`addPanelMember: ${error.message}`);
  }
  async removePanelMember(panelId: string, judgeId: string): Promise<boolean> {
    const { data, error } = await this.sb
      .from('panel_members')
      .delete()
      .eq('panel_id', panelId)
      .eq('judge_id', judgeId)
      .select('judge_id');
    if (error) throw new Error(`removePanelMember: ${error.message}`);
    return (data?.length ?? 0) > 0;
  }
  async listPanelMembers(panelId: string): Promise<{ judge_id: string; judge_name: string; verified_at: string | null }[]> {
    const rows = unwrap(
      await this.sb
        .from('panel_members')
        .select('judge_id, verified_at, judge:profiles!panel_members_judge_id_fkey(full_name)')
        .eq('panel_id', panelId),
      'listPanelMembers',
    ) as any[];
    return rows.map((r) => ({
      judge_id: r.judge_id,
      judge_name: (r.judge as any)?.full_name ?? '',
      verified_at: r.verified_at,
    }));
  }
  async listAllPanelMembers(): Promise<
    { panel_id: string; judge_id: string; judge_name: string; verified_at: string | null }[]
  > {
    const rows = unwrap(
      await this.sb
        .from('panel_members')
        .select('panel_id, judge_id, verified_at, judge:profiles!panel_members_judge_id_fkey(full_name)'),
      'listAllPanelMembers',
    ) as any[];
    return rows.map((r) => ({
      panel_id: r.panel_id,
      judge_id: r.judge_id,
      judge_name: (r.judge as any)?.full_name ?? '',
      verified_at: r.verified_at,
    }));
  }

  // ---- candidates --------------------------------------------------------
  private scopeFilter(q: any, scope: CandidateScope) {
    if (!scope.admin) {
      q = q.in('panel_id', scope.panelIds ?? []);
    }
    return q;
  }
  async listCandidates(scope: CandidateScope, filters: CandidateFilters): Promise<Candidate[]> {
    let q = this.sb.from('candidate_results').select('*');
    q = this.scopeFilter(q, scope);
    if (!filters.includeArchived) q = q.is('archived_at', null);
    if (filters.panelId) q = q.eq('panel_id', filters.panelId);
    if (filters.verticalId) q = q.eq('vertical_id', filters.verticalId);
    if (filters.shift) q = q.eq('shift', filters.shift);
    if (filters.priority !== undefined) q = q.eq('priority', filters.priority);
    if (filters.interviewStatus) q = q.eq('interview_status', filters.interviewStatus);
    if (filters.shortlistingStatus) q = q.eq('shortlisting_status', filters.shortlistingStatus);
    if (filters.evaluationStatus) q = q.eq('evaluation_status', filters.evaluationStatus);
    if (filters.branch) q = q.ilike('branch', `%${filters.branch}%`);
    if (filters.search) {
      const s = `%${filters.search}%`;
      q = q.or(`full_name.ilike.${s},application_id.ilike.${s},roll_number.ilike.${s}`);
    }
    const asc = filters.order !== 'desc';
    switch (filters.sort) {
      case 'branch':
        q = q.order('branch', { ascending: asc }).order('full_name', { ascending: true });
        break;
      case 'priority':
        q = q.order('priority', { ascending: asc, nullsFirst: false }).order('full_name', { ascending: true });
        break;
      case 'roll':
        q = q.order('roll_number', { ascending: asc }).order('full_name', { ascending: true });
        break;
      case 'average':
        q = q.order('average_score', { ascending: asc, nullsFirst: false }).order('full_name', { ascending: true });
        break;
      case 'created':
        q = q.order('candidate_id', { ascending: asc });
        break;
      default:
        q = q.order('full_name', { ascending: asc });
    }
    const rows = unwrap(await q, 'listCandidates') as any[];
    return rows.map((r) => this.toCandidate(r, scope.admin));
  }
  private toCandidate(r: any, admin: boolean): Candidate {
    return {
      id: r.candidate_id ?? r.id,
      full_name: r.full_name,
      branch: r.branch ?? '',
      application_id: r.application_id ?? null,
      panel_id: r.panel_id,
      interview_status: r.interview_status,
      shortlisting_status: r.shortlisting_status,
      notes: admin ? (r.notes ?? '') : '',
      archived_at: r.archived_at ?? null,
      created_at: r.created_at ?? '',
      updated_at: r.updated_at ?? '',
      vertical_id: r.vertical_id ?? null,
      shift: r.shift ?? '',
      priority: r.priority ?? null,
      email: r.email ?? null,
      roll_number: r.roll_number ?? null,
      linkedin_url: r.linkedin_url ?? null,
      github_url: r.github_url ?? null,
      team_message: r.team_message ?? null,
      remarks: r.remarks ?? null,
      task_links: r.task_links ?? [],
      external_profiles: r.external_profiles ?? [],
      source_extra: r.source_extra ?? null,
      source_key: r.source_key ?? null,
      source_sheet: r.source_sheet ?? null,
      source_row: r.source_row ?? null,
      source_updated_at: r.source_updated_at ?? null,
      imported_at: r.imported_at ?? null,
      last_synced_at: r.last_synced_at ?? null,
    };
  }
  async getCandidate(id: string, scope: CandidateScope): Promise<Candidate | null> {
    let q = this.sb.from('candidates').select('*').eq('id', id);
    q = this.scopeFilter(q, scope);
    const { data, error } = await q.maybeSingle();
    if (error) throw new Error(`getCandidate: ${error.message}`);
    return data ? this.toCandidate(data, scope.admin) : null;
  }
  async createCandidate(
    input: { full_name: string; branch: string; application_id: string | null; panel_id: string },
    actorId: string,
  ): Promise<Candidate> {
    if (input.application_id) {
      const { data: dup } = await this.sb
        .from('candidates')
        .select('id')
        .eq('application_id', input.application_id)
        .eq('panel_id', input.panel_id)
        .maybeSingle();
      if (dup) throw new Error('application_id already exists for this panel');
    }
    return unwrap(
      await this.sb
        .from('candidates')
        .insert({ ...input, application_id: input.application_id || null, created_by: actorId })
        .select('*')
        .single(),
      'createCandidate',
    ) as unknown as Candidate;
  }
  async updateCandidate(id: string, patch: Record<string, unknown>): Promise<Candidate | null> {
    const { data, error } = await this.sb
      .from('candidates')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`updateCandidate: ${error.message}`);
    return (data as Candidate) ?? null;
  }
  async archiveCandidate(id: string, archived: boolean): Promise<Candidate | null> {
    return this.updateCandidate(id, { archived_at: archived ? new Date().toISOString() : null });
  }
  async bulkCreateCandidates(
    rows: { full_name: string; branch: string; application_id: string | null; panel_id: string }[],
    actorId: string,
  ): Promise<ImportResult> {
    const result: ImportResult = { imported: 0, skipped_duplicates: 0, errors: [] };
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row.full_name) {
        result.errors.push({ row: i + 2, message: 'full_name is required' });
        continue;
      }
      const panel = await this.getPanel(row.panel_id);
      if (!panel) {
        result.errors.push({ row: i + 2, message: `Panel not found for row` });
        continue;
      }
      if (row.application_id) {
        const dupKey = `${row.application_id}::${row.panel_id}`;
        const { data: dup } = await this.sb
          .from('candidates')
          .select('id')
          .eq('application_id', row.application_id)
          .eq('panel_id', row.panel_id)
          .maybeSingle();
        if (dup || seen.has(dupKey)) {
          result.skipped_duplicates += 1;
          continue;
        }
        seen.add(dupKey);
      }
      try {
        await this.createCandidate(row, actorId);
        result.imported += 1;
      } catch (e: any) {
        if (String(e?.message ?? e).includes('23505') || String(e?.message ?? e).toLowerCase().includes('duplicate')) {
          result.skipped_duplicates += 1;
        } else {
          result.errors.push({ row: i + 2, message: String(e?.message ?? e) });
        }
      }
    }
    return result;
  }

  // ---- rounds & criteria ---------------------------------------------------
  async listRounds(): Promise<Round[]> {
    return unwrap(await this.sb.from('evaluation_rounds').select('*'), 'listRounds') as Round[];
  }
  async getRound(id: string): Promise<Round | null> {
    const { data, error } = await this.sb
      .from('evaluation_rounds')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) throw new Error(`getRound: ${error.message}`);
    return data as Round | null;
  }
  async createRound(input: {
    name: string;
    is_open: boolean;
    allow_edit_after_submit: boolean;
    closes_at: string | null;
  }): Promise<Round> {
    return unwrap(
      await this.sb.from('evaluation_rounds').insert(input).select('*').single(),
      'createRound',
    ) as Round;
  }
  async updateRound(id: string, patch: Record<string, unknown>): Promise<Round | null> {
    const { data, error } = await this.sb
      .from('evaluation_rounds')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`updateRound: ${error.message}`);
    return (data as Round) ?? null;
  }
  async deleteRound(id: string, force = false): Promise<{ deleted: boolean; evaluations: number }> {
    const existing = await this.sb.from('evaluation_rounds').select('id').eq('id', id).maybeSingle();
    if (existing.error) throw new Error(`deleteRound: ${existing.error.message}`);
    if (!existing.data) return { deleted: false, evaluations: 0 };
    const counted = await this.sb
      .from('evaluations')
      .select('id', { count: 'exact', head: true })
      .eq('round_id', id);
    if (counted.error) throw new Error(`deleteRound(evaluations): ${counted.error.message}`);
    const evaluations = counted.count ?? 0;
    if (evaluations > 0 && !force) return { deleted: false, evaluations };
    if (evaluations > 0) {
      const deleted = await this.sb.from('evaluations').delete().eq('round_id', id);
      if (deleted.error) throw new Error(`deleteRound(evaluations): ${deleted.error.message}`);
    }
    const { error } = await this.sb.from('evaluation_rounds').delete().eq('id', id);
    if (error) throw new Error(`deleteRound: ${error.message}`);
    return { deleted: true, evaluations };
  }

  async listCriteria(roundId: string): Promise<Criterion[]> {
    return unwrap(
      await this.sb
        .from('criteria')
        .select('*')
        .eq('round_id', roundId)
        .order('sort_order'),
      'listCriteria',
    ) as Criterion[];
  }
  async createCriterion(input: Omit<Criterion, 'id' | 'created_at'>): Promise<Criterion> {
    return unwrap(
      await this.sb.from('criteria').insert(input).select('*').single(),
      'createCriterion',
    ) as Criterion;
  }
  async updateCriterion(id: string, patch: Partial<Criterion>): Promise<Criterion | null> {
    const { data, error } = await this.sb
      .from('criteria')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`updateCriterion: ${error.message}`);
    return (data as Criterion) ?? null;
  }

  async deleteCriterion(id: string, force = false): Promise<{ deleted: boolean; scores: number }> {
    const existing = await this.sb.from('criteria').select('id').eq('id', id).maybeSingle();
    if (existing.error) throw new Error(`deleteCriterion: ${existing.error.message}`);
    if (!existing.data) return { deleted: false, scores: 0 };
    const counted = await this.sb
      .from('criterion_scores')
      .select('evaluation_id', { count: 'exact', head: true })
      .eq('criterion_id', id);
    if (counted.error) throw new Error(`deleteCriterion(scores): ${counted.error.message}`);
    const scores = counted.count ?? 0;
    if (scores > 0 && !force) return { deleted: false, scores };
    const { error } = await this.sb.from('criteria').delete().eq('id', id);
    if (error) throw new Error(`deleteCriterion: ${error.message}`);
    return { deleted: true, scores };
  }

  // ---- evaluations ---------------------------------------------------------
  async getEvaluation(id: string): Promise<EvaluationWithScores | null> {
    const { data: e, error } = await this.sb.from('evaluations').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`getEvaluation: ${error.message}`);
    if (!e) return null;
    const scores = unwrap(
      await this.sb.from('criterion_scores').select('*').eq('evaluation_id', id),
      'getEvaluation scores',
    ) as any[];
    const judge = await this.getProfile((e as any).judge_id);
    return {
      ...(e as any),
      scores: scores.map((s) => ({
        criterion_id: s.criterion_id,
        score: Number(s.score),
        feedback: s.feedback ?? undefined,
      })),
      judge_name: judge?.full_name,
    };
  }
  async deleteEvaluation(id: string): Promise<EvaluationWithScores | null> {
    const existing = await this.getEvaluation(id);
    if (!existing) return null;
    const scores = await this.sb.from('criterion_scores').delete().eq('evaluation_id', id);
    if (scores.error) throw new Error(`deleteEvaluation(scores): ${scores.error.message}`);
    const { error } = await this.sb.from('evaluations').delete().eq('id', id);
    if (error) throw new Error(`deleteEvaluation: ${error.message}`);
    return existing;
  }
  async getOfficialEvaluation(
    judgeId: string,
    candidateId: string,
    roundId: string,
  ): Promise<EvaluationWithScores | null> {
    const { data, error } = await this.sb
      .from('evaluations')
      .select('id')
      .eq('judge_id', judgeId)
      .eq('candidate_id', candidateId)
      .eq('round_id', roundId)
      .eq('status', 'submitted')
      .maybeSingle();
    if (error) throw new Error(`getOfficialEvaluation: ${error.message}`);
    if (!data) return null;
    return this.getEvaluation((data as any).id);
  }
  async listEvaluations(filter: {
    admin: boolean;
    judgeId?: string;
    candidateId?: string;
    panelIds?: string[];
  }): Promise<EvaluationWithScores[]> {
    let q = this.sb.from('evaluations').select('*');
    if (filter.judgeId) q = q.eq('judge_id', filter.judgeId);
    if (filter.candidateId) q = q.eq('candidate_id', filter.candidateId);
    if (!filter.admin && filter.panelIds) q = q.in('panel_id', filter.panelIds);
    q = q.order('submitted_at', { ascending: false }).limit(1000);
    const rows = unwrap(await q, 'listEvaluations') as any[];
    const out: EvaluationWithScores[] = [];
    for (const r of rows.slice(0, 200)) {
      const full = await this.getEvaluation(r.id);
      if (full) out.push(full);
    }
    if (out.length === 0) return out;
    const candidateIds = [...new Set(out.map((e) => e.candidate_id))];
    const roundIds = [...new Set(out.map((e) => e.round_id))];
    const [candidates, rounds] = await Promise.all([
      this.sb.from('candidates').select('id, full_name').in('id', candidateIds),
      this.sb.from('evaluation_rounds').select('id, name').in('id', roundIds),
    ]);
    const candidateNames = new Map(
      (unwrap(candidates, 'listEvaluations candidates') as any[]).map((c) => [c.id, c.full_name]),
    );
    const roundNames = new Map(
      (unwrap(rounds, 'listEvaluations rounds') as any[]).map((r) => [r.id, r.name]),
    );
    for (const e of out) {
      e.candidate_name = candidateNames.get(e.candidate_id) ?? undefined;
      e.round_name = roundNames.get(e.round_id) ?? undefined;
    }
    return out;
  }

  async submitEvaluation(
    judgeId: string,
    input: SubmitEvaluationInput,
    computed: { overall_score: number | null; scores: CriterionScore[] },
    opts: { replaceExisting: boolean },
  ): Promise<SubmitOutcome> {
    // Idempotency: same client-generated id already stored for this judge.
    const { data: sameId } = await this.sb
      .from('evaluations')
      .select('*')
      .eq('id', input.id)
      .maybeSingle();
    if (sameId) {
      if ((sameId as any).judge_id !== judgeId) {
        return { status: 'error', message: 'Evaluation ID already used' };
      }
      const existing = await this.getEvaluation(input.id);
      if (!existing) return { status: 'error', message: 'Evaluation lookup failed' };
      const sorted = (xs: { criterion_id: string; score: number }[]) =>
        [...xs].sort((a, b) => a.criterion_id.localeCompare(b.criterion_id));
      const samePayload =
        existing.feedback === input.feedback &&
        Number(existing.overall_score) === Number(computed.overall_score) &&
        JSON.stringify(sorted(existing.scores)) === JSON.stringify(sorted(computed.scores));
      if (samePayload) return { status: 'ok', evaluation: existing, idempotent: true };
      const round = await this.getRound(input.round_id);
      if (opts.replaceExisting && round?.allow_edit_after_submit) {
        return this.updateEvaluation(input.id, judgeId, {
          feedback: input.feedback,
          overall_score: computed.overall_score,
          scores: computed.scores,
          preferred_vertical_id:
            input.preferred_vertical_id === undefined ? existing.preferred_vertical_id : input.preferred_vertical_id,
        });
      }
      return { status: 'ok', evaluation: existing, idempotent: true };
    }
    const { data: cand } = await this.sb
      .from('candidates')
      .select('id, panel_id, archived_at')
      .eq('id', input.candidate_id)
      .maybeSingle();
    if (!cand || (cand as any).archived_at) {
      return { status: 'error', message: 'Candidate not found' };
    }
    const round = await this.getRound(input.round_id);
    if (!round) return { status: 'error', message: 'Round not found' };

    const official = await this.getOfficialEvaluation(judgeId, input.candidate_id, input.round_id);
    if (official) {
      if (opts.replaceExisting && round.allow_edit_after_submit) {
        return this.updateEvaluation(official.id, judgeId, {
          feedback: input.feedback,
          overall_score: computed.overall_score,
          scores: computed.scores,
          preferred_vertical_id:
            input.preferred_vertical_id === undefined
              ? official.preferred_vertical_id
              : input.preferred_vertical_id,
        });
      }
      return { status: 'duplicate', existing: official };
    }

    const { error } = await this.sb.from('evaluations').insert({
      id: input.id,
      candidate_id: input.candidate_id,
      judge_id: judgeId,
      panel_id: (cand as any).panel_id,
      round_id: input.round_id,
      status: 'submitted',
      overall_score: computed.overall_score,
      feedback: input.feedback,
      preferred_vertical_id: input.preferred_vertical_id ?? null,
      client_created_at: input.client_created_at ?? null,
    });
    if (error) {
      // Unique violation from a concurrent insert — surface as duplicate.
      if (error.code === '23505') {
        const existing = await this.getOfficialEvaluation(judgeId, input.candidate_id, input.round_id);
        if (existing) return { status: 'duplicate', existing };
      }
      return { status: 'error', message: error.message };
    }
    if (computed.scores.length > 0) {
      const { error: scoreErr } = await this.sb.from('criterion_scores').insert(
        computed.scores.map((s) => ({
          evaluation_id: input.id,
          criterion_id: s.criterion_id,
          score: s.score,
          feedback: s.feedback ?? '',
        })),
      );
      if (scoreErr) return { status: 'error', message: `Failed to save scores: ${scoreErr.message}` };
    }
    const saved = await this.getEvaluation(input.id);
    return saved ? { status: 'ok', evaluation: saved } : { status: 'error', message: 'Save verification failed' };
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
    const existing = await this.getEvaluation(id);
    if (!existing) return { status: 'error', message: 'Evaluation not found' };
    if (existing.judge_id !== judgeId) return { status: 'error', message: 'Not your evaluation' };
    const { error } = await this.sb
      .from('evaluations')
      .update({
        feedback: patch.feedback,
        overall_score: patch.overall_score,
        preferred_vertical_id: patch.preferred_vertical_id,
        version: existing.version + 1,
      })
      .eq('id', id)
      .eq('version', existing.version); // optimistic lock
    if (error) return { status: 'error', message: error.message };
    await this.sb.from('criterion_scores').delete().eq('evaluation_id', id);
    if (patch.scores.length > 0) {
      await this.sb.from('criterion_scores').insert(
        patch.scores.map((s) => ({
          evaluation_id: id,
          criterion_id: s.criterion_id,
          score: s.score,
          feedback: s.feedback ?? '',
        })),
      );
    }
    const saved = await this.getEvaluation(id);
    return saved ? { status: 'ok', evaluation: saved } : { status: 'error', message: 'Update verification failed' };
  }

  async results(scope: CandidateScope, filters: CandidateFilters): Promise<ResultRow[]> {
    let q = this.sb.from('candidate_results').select('*');
    q = this.scopeFilter(q, scope);
    if (!filters.includeArchived) q = q.is('archived_at', null);
    if (filters.panelId) q = q.eq('panel_id', filters.panelId);
    if (filters.verticalId) q = q.eq('vertical_id', filters.verticalId);
    if (filters.shift) q = q.eq('shift', filters.shift);
    if (filters.priority !== undefined) q = q.eq('priority', filters.priority);
    if (filters.interviewStatus) q = q.eq('interview_status', filters.interviewStatus);
    if (filters.shortlistingStatus) q = q.eq('shortlisting_status', filters.shortlistingStatus);
    if (filters.evaluationStatus) q = q.eq('evaluation_status', filters.evaluationStatus);
    if (filters.branch) q = q.ilike('branch', `%${filters.branch}%`);
    if (filters.search) {
      const s = `%${filters.search}%`;
      q = q.or(`full_name.ilike.${s},application_id.ilike.${s},roll_number.ilike.${s}`);
    }
    const asc = filters.order !== 'desc';
    switch (filters.sort) {
      case 'branch':
        q = q.order('branch', { ascending: asc }).order('full_name', { ascending: true });
        break;
      case 'priority':
        q = q.order('priority', { ascending: asc, nullsFirst: false }).order('full_name', { ascending: true });
        break;
      case 'roll':
        q = q.order('roll_number', { ascending: asc }).order('full_name', { ascending: true });
        break;
      case 'average':
        q = q.order('average_score', { ascending: asc, nullsFirst: false }).order('full_name', { ascending: true });
        break;
      case 'created':
        q = q.order('candidate_id', { ascending: asc });
        break;
      default:
        q = q.order('full_name', { ascending: asc });
    }
    const rows = unwrap(await q, 'results') as any[];
    return rows.map((r) => ({
      candidate_id: r.candidate_id,
      full_name: r.full_name,
      branch: r.branch ?? '',
      application_id: r.application_id ?? null,
      roll_number: r.roll_number ?? '',
      panel_id: r.panel_id,
      panel_name: r.panel_name ?? '',
      expected_evaluations: r.expected_evaluations ?? 1,
      vertical_id: r.vertical_id ?? null,
      vertical_name: r.vertical_name ?? null,
      shift: r.shift ?? '',
      priority: r.priority ?? null,
      interview_status: r.interview_status,
      shortlisting_status: r.shortlisting_status,
      evaluation_status: r.evaluation_status,
      is_provisional: r.is_provisional ?? r.evaluation_status === 'in_progress',
      evaluation_count: r.evaluation_count ?? 0,
      average_score: r.average_score === null || r.average_score === undefined ? null : Number(r.average_score),
      archived_at: r.archived_at ?? null,
      judge_ratings: (r.judge_ratings ?? []).map((jr: any) => ({
        ...jr,
        score: jr.score === null ? null : Number(jr.score),
      })),
    }));
  }

  async audit(entry: AuditEntry): Promise<void> {
    await this.sb.from('audit_events').insert({
      actor_id: entry.actor_id,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      details: entry.details,
    });
  }

  // ---- addendum: verticals ------------------------------------------------
  async listVerticals(onlyActive = false): Promise<Vertical[]> {
    let q = this.sb.from('verticals').select('*').order('sort_order');
    if (onlyActive) q = q.eq('is_active', true);
    return unwrap(await q, 'listVerticals') as Vertical[];
  }
  async getVertical(id: string): Promise<Vertical | null> {
    const { data, error } = await this.sb.from('verticals').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`getVertical: ${error.message}`);
    return data as Vertical | null;
  }
  async createVertical(input: { key: string; name: string; worksheet?: string | null; sort_order?: number }): Promise<Vertical> {
    return unwrap(
      await this.sb
        .from('verticals')
        .insert({ key: input.key, name: input.name, worksheet: input.worksheet ?? null, sort_order: input.sort_order ?? null })
        .select('*')
        .single(),
      'createVertical',
    ) as Vertical;
  }
  async updateVertical(
    id: string,
    patch: Partial<{ name: string; worksheet: string | null; is_active: boolean; sort_order: number }>,
  ): Promise<Vertical | null> {
    const { data, error } = await this.sb.from('verticals').update(patch).eq('id', id).select('*').maybeSingle();
    if (error) throw new Error(`updateVertical: ${error.message}`);
    return data as Vertical | null;
  }

  // ---- addendum: workbook import -----------------------------------------
  async importApplicants(rows: ImportedApplicant[], actorId: string): Promise<ImportApplicantsResult> {
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
      const verticalId = await this.verticalIdForSheet(row.sourceSheet);
      const panelId = await this.resolvePanelForImport(row.panel, row.shift);
      // 1) exact (sheet, key) match
      let match = await this.sb
        .from('candidates')
        .select('*')
        .eq('source_sheet', row.sourceSheet)
        .eq('source_key', row.sourceKey)
        .maybeSingle();
      let existing = match.data ?? null;
      // 2) roll number / application_id — scoped to the same sheet so an
      // applicant who applied to multiple verticals is kept once per vertical.
      if (!existing && row.roll_number) {
        const m2 = await this.sb
          .from('candidates')
          .select('*')
          .eq('source_sheet', row.sourceSheet)
          .or(`application_id.eq.${row.roll_number},roll_number.eq.${row.roll_number}`)
          .limit(1)
          .maybeSingle();
        existing = m2.data ?? null;
      }
      // 3) email — same sheet only (never collapse across verticals).
      if (!existing && row.email) {
        const m3 = await this.sb
          .from('candidates')
          .select('*')
          .eq('source_sheet', row.sourceSheet)
          .eq('email', row.email)
          .limit(1)
          .maybeSingle();
        existing = m3.data ?? null;
      }

      if (!existing) {
        const { error } = await this.sb.from('candidates').insert({
          full_name: row.full_name,
          branch: row.branch,
          application_id: row.roll_number || null,
          panel_id: panelId,
          interview_status: 'pending',
          shortlisting_status: 'pending',
          notes: '',
          archived_at: null,
          created_by: actorId,
          vertical_id: verticalId,
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
          last_synced_at: new Date().toISOString(),
        });
        if (error) {
          result.errors.push({ row: row.sourceRow, sheet: row.sourceSheet, reason: error.message });
          continue;
        }
        result.created += 1;
        continue;
      }

      const patch: Record<string, unknown> = {};
      const pick = (cur: string | null | undefined, incoming: string): string =>
        incoming && incoming.trim() ? incoming : (cur ?? '');
      const beforeName = existing.full_name ?? '';
      const afterName = pick(beforeName, row.full_name);
      if (afterName !== beforeName) patch.full_name = afterName;      const afterBranch = pick(existing.branch ?? '', row.branch);
      if (afterBranch !== (existing.branch ?? '')) patch.branch = afterBranch;
      if (row.roll_number) {
        patch.roll_number = row.roll_number;
        patch.application_id = row.roll_number;
      }
      const afterEmail = pick(existing.email ?? '', row.email);
      if (afterEmail !== (existing.email ?? '')) patch.email = afterEmail;
      const afterShift = pick(existing.shift ?? '', row.shift);
      if (afterShift !== (existing.shift ?? '')) patch.shift = afterShift;
      if (row.priority !== null) patch.priority = row.priority;
      const afterLi = pick(existing.linkedin_url ?? '', row.linkedin_url);
      if (afterLi !== (existing.linkedin_url ?? '')) patch.linkedin_url = afterLi;
      const afterGh = pick(existing.github_url ?? '', row.github_url);
      if (afterGh !== (existing.github_url ?? '')) patch.github_url = afterGh;
      const afterMsg = pick(existing.team_message ?? '', row.team_message);
      if (afterMsg !== (existing.team_message ?? '')) patch.team_message = afterMsg;
      const afterRemarks = pick(existing.remarks ?? '', row.remarks);
      if (afterRemarks !== (existing.remarks ?? '')) patch.remarks = afterRemarks;
      if (row.task_links.length) patch.task_links = row.task_links;
      if (row.external_profiles.length) patch.external_profiles = row.external_profiles;
      if (row.source_extra && Object.keys(row.source_extra).length) {
        patch.source_extra = { ...(existing.source_extra ?? {}), ...row.source_extra };
      }
      if (!existing.source_key) patch.source_key = row.sourceKey;
      if (!existing.source_sheet) patch.source_sheet = row.sourceSheet;
      patch.source_row = row.sourceRow;
      patch.last_synced_at = new Date().toISOString();

      if (patch.full_name && beforeName && patch.full_name !== beforeName) {
        result.conflicts.push({
          row: row.sourceRow,
          sheet: row.sourceSheet,
          field: 'full_name',
          kept: afterName,
          incoming: row.full_name,
        });
      }
      if (Object.keys(patch).length > 0) {
        const { error } = await this.sb.from('candidates').update(patch).eq('id', existing.id);
        if (error) {
          result.errors.push({ row: row.sourceRow, sheet: row.sourceSheet, reason: error.message });
          continue;
        }
      }
      result.updated += 1;
    }
    return result;
  }

  private async verticalIdForSheet(sheetName: string): Promise<string | null> {
    const { data } = await this.sb.from('verticals').select('*');
    const norm = sheetName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    for (const v of (data ?? []) as Vertical[]) {
      if (v.worksheet && v.worksheet.toLowerCase() === sheetName.toLowerCase()) return v.id;
      if (v.key === norm || v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') === norm) return v.id;
    }
    return null;
  }

  private async resolvePanelForImport(panelName: string, shift: string): Promise<string> {
    const name = (panelName || '').trim();
    if (name) {
      const { data } = await this.sb.from('panels').select('*').ilike('name', name).limit(1).maybeSingle();
      if (data) return data.id;
      const created = unwrap(
        await this.sb
          .from('panels')
          .insert({ name, is_active: true, expected_evaluations: 0, shift: shift || null })
          .select('*')
          .single(),
        'resolvePanelForImport',
      ) as Panel;
      return created.id;
    }
    const { data } = await this.sb.from('panels').select('*').eq('name', 'Imported').limit(1).maybeSingle();
    if (data) return data.id;
    const created = unwrap(
      await this.sb
        .from('panels')
        .insert({ name: 'Imported', is_active: true, expected_evaluations: 0 })
        .select('*')
        .single(),
      'resolvePanelForImport',
    ) as Panel;
    return created.id;
  }

  // ---- addendum: spreadsheet sync queue ----------------------------------
  async enqueueSpreadsheetSync(item: {
    direction: 'to_sheet' | 'from_sheet';
    entity_type: 'applicant' | 'evaluation';
    entity_id: string;
    worksheet: string;
    row_key: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    // One queue row per entity (unique index), regardless of its previous
    // status: a finished/failed row is re-armed with the latest payload.
    // Upsert avoids the select-then-insert race when several judges submit for
    // the same candidate at the same moment.
    const { error } = await this.sb.from('spreadsheet_sync_queue').upsert(
      {
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
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'direction,entity_type,entity_id' },
    );
    if (error) throw new Error(`enqueueSpreadsheetSync: ${error.message}`);
  }
  async claimSpreadsheetSync(limit: number): Promise<SpreadsheetSyncItem[]> {
    const stale = new Date(Date.now() - 60_000).toISOString();
    const { data, error } = await this.sb
      .from('spreadsheet_sync_queue')
      .select('*')
      .or(`status.eq.pending,and(status.eq.in_flight,updated_at.lt.${stale})`)
      .order('created_at')
      .limit(limit);
    if (error) throw new Error(`claimSpreadsheetSync: ${error.message}`);
    const rows = (data ?? []) as SpreadsheetSyncItem[];
    if (rows.length === 0) return [];
    // Two concurrent drains can select the same candidates; only the update
    // that still matches the expected status actually owns each row.
    const now = new Date().toISOString();
    const claimed: SpreadsheetSyncItem[] = [];
    const pendingIds = rows.filter((r) => r.status === 'pending').map((r) => r.id);
    const staleIds = rows.filter((r) => r.status === 'in_flight').map((r) => r.id);
    if (pendingIds.length) {
      const { data: c, error: cErr } = await this.sb
        .from('spreadsheet_sync_queue')
        .update({ status: 'in_flight', updated_at: now })
        .in('id', pendingIds)
        .eq('status', 'pending')
        .select('*');
      if (cErr) throw new Error(`claimSpreadsheetSync: ${cErr.message}`);
      claimed.push(...((c ?? []) as SpreadsheetSyncItem[]));
    }
    if (staleIds.length) {
      const { data: c, error: cErr } = await this.sb
        .from('spreadsheet_sync_queue')
        .update({ status: 'in_flight', updated_at: now })
        .in('id', staleIds)
        .eq('status', 'in_flight')
        .lt('updated_at', stale)
        .select('*');
      if (cErr) throw new Error(`claimSpreadsheetSync: ${cErr.message}`);
      claimed.push(...((c ?? []) as SpreadsheetSyncItem[]));
    }
    return claimed;
  }
  async completeSpreadsheetSync(
    id: string,
    status: 'done' | 'failed' | 'conflict' | 'pending',
    detail: { error?: string; conflict?: Record<string, unknown>; attempts?: number },
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      status,
      last_error: detail.error ?? '',
      conflict: detail.conflict ?? null,
      updated_at: new Date().toISOString(),
    };
    if (detail.attempts !== undefined) patch.attempts = detail.attempts;
    if (status === 'done') patch.payload = {};
    // A newer evaluation may have re-armed this row (pending) while the write
    // was in flight; never mark that newer payload as done.
    const { error } = await this.sb
      .from('spreadsheet_sync_queue')
      .update(patch)
      .eq('id', id)
      .eq('status', 'in_flight');
    if (error) throw new Error(`completeSpreadsheetSync: ${error.message}`);
  }
  async listSpreadsheetSync(status?: string): Promise<SpreadsheetSyncItem[]> {
    let q = this.sb.from('spreadsheet_sync_queue').select('*').order('created_at');
    if (status) q = q.eq('status', status);
    return unwrap(await q, 'listSpreadsheetSync') as SpreadsheetSyncItem[];
  }
  async getSpreadsheetConnection(): Promise<SpreadsheetConnection | null> {
    const { data, error } = await this.sb.from('spreadsheet_connections').select('*').limit(1).maybeSingle();
    if (error) throw new Error(`getSpreadsheetConnection: ${error.message}`);
    return data as SpreadsheetConnection | null;
  }
  async saveSpreadsheetConnection(patch: Partial<SpreadsheetConnection>): Promise<SpreadsheetConnection> {
    const existing = await this.getSpreadsheetConnection();
    if (existing) {
      const { data, error } = await this.sb
        .from('spreadsheet_connections')
        .update(patch)
        .eq('id', existing.id)
        .select('*')
        .single();
      if (error) throw new Error(`saveSpreadsheetConnection: ${error.message}`);
      return data as SpreadsheetConnection;
    }
    const { data, error } = await this.sb
      .from('spreadsheet_connections')
      .insert({
        kind: patch.kind ?? 'google_sheets',
        spreadsheet_id: patch.spreadsheet_id ?? '',
        title: patch.title ?? '',
        header_row: patch.header_row ?? 1,
        is_active: patch.is_active ?? true,
        last_sync_status: patch.last_sync_status ?? 'never',
        last_sync_error: patch.last_sync_error ?? '',
        sheet_revision: patch.sheet_revision ?? '',
      })
      .select('*')
      .single();
    if (error) throw new Error(`saveSpreadsheetConnection: ${error.message}`);
    return data as SpreadsheetConnection;
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
    const { error } = await this.sb.from('spreadsheet_sync_log').insert(entry);
    if (error) throw new Error(`logSpreadsheetSync: ${error.message}`);
  }
}

export const mean = meanOrNull;
