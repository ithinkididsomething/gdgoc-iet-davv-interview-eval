export type Role = 'judge' | 'admin';

export interface Vertical {
  id: string;
  key: string;
  name: string;
  worksheet: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  login_id?: string | null;
  display_name?: string;
  vertical_ids?: string[];
  panel_ids?: string[];
  shift_restrictions?: string[];
  password_reset_at?: string | null;
}

export interface Panel {
  id: string;
  name: string;
  is_active: boolean;
  expected_evaluations: number;
  created_at: string;
  vertical_id?: string | null;
  shift?: string;
  panel_number?: number | null;
  description?: string;
}

export interface PanelCodeMeta {
  id: string;
  panel_id: string;
  label: string;
  is_active: boolean;
  max_attempts: number;
  failed_attempts: number;
  locked_until: string | null;
  expires_at: string | null;
  created_at: string;
  rotated_at: string | null;
  code_preview: string; // short non-reversible display hint, e.g. "••••ABCD"
}

export interface TaskLink {
  label: string;
  url: string;
}

export interface Candidate {
  id: string;
  full_name: string;
  branch: string;
  application_id: string | null;
  panel_id: string;
  interview_status: 'pending' | 'in_progress' | 'completed' | 'no_show';
  shortlisting_status: 'pending' | 'shortlisted' | 'waitlisted' | 'rejected';
  notes: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  // addendum: expanded applicant profile (workbook columns)
  vertical_id?: string | null;
  shift?: string | null;
  priority?: number | null;
  email?: string | null;
  roll_number?: string | null;
  linkedin_url?: string | null;
  github_url?: string | null;
  team_message?: string | null;
  remarks?: string | null;
  task_links?: TaskLink[];
  external_profiles?: TaskLink[];
  source_extra?: Record<string, unknown>;
  source_key?: string | null;
  source_sheet?: string | null;
  source_row?: number | null;
  source_updated_at?: string | null;
  imported_at?: string | null;
  last_synced_at?: string | null;
}

export interface Round {
  id: string;
  name: string;
  is_open: boolean;
  allow_edit_after_submit: boolean;
  closes_at: string | null;
}

export interface Criterion {
  id: string;
  round_id: string;
  name: string;
  description: string;
  min_score: number;
  max_score: number;
  weight: number;
  sort_order: number;
  is_active: boolean;
}

export interface CriterionScore {
  criterion_id: string;
  score: number;
  feedback?: string;
}

export interface Evaluation {
  id: string;
  candidate_id: string;
  judge_id: string;
  panel_id: string;
  round_id: string;
  status: 'submitted' | 'withdrawn';
  overall_score: number | null;
  feedback: string;
  preferred_vertical_id: string | null;
  version: number;
  client_created_at: string | null;
  submitted_at: string;
  updated_at: string;
}

export interface EvaluationWithScores extends Evaluation {
  scores: CriterionScore[];
  judge_name?: string;
  candidate_name?: string;
  round_name?: string;
}

export interface JudgeRating {
  judge_id: string;
  judge_name: string;
  score: number | null;
  evaluation_id: string;
  submitted_at: string;
  version: number;
}

export interface ResultRow {
  candidate_id: string;
  full_name: string;
  branch: string;
  application_id: string | null;
  roll_number?: string;
  panel_id: string;
  panel_name: string;
  expected_evaluations: number;
  vertical_id?: string | null;
  vertical_name?: string | null;
  shift?: string;
  priority?: number | null;
  interview_status: string;
  shortlisting_status: string;
  evaluation_status: 'not_started' | 'in_progress' | 'complete';
  is_provisional?: boolean;
  evaluation_count: number;
  average_score: number | null;
  judge_ratings: JudgeRating[];
  archived_at: string | null;
}

export interface CandidateFilters {
  search?: string;
  branch?: string;
  panelId?: string;
  verticalId?: string;
  shift?: string;
  priority?: number;
  interviewStatus?: string;
  shortlistingStatus?: string;
  evaluationStatus?: string;
  sort?: 'name' | 'branch' | 'average' | 'created' | 'priority' | 'roll';
  order?: 'asc' | 'desc';
  includeArchived?: boolean;
}

export interface CandidateScope {
  admin: boolean;
  judgeId?: string;
  panelIds?: string[];
}

export interface SubmitEvaluationInput {
  id: string; // client-generated UUID — idempotency key
  candidate_id: string;
  round_id: string;
  feedback: string;
  overall_score?: number | null; // used when round has no active criteria
  scores: Record<string, number>; // criterion_id -> score
  criterion_feedbacks?: Record<string, string>; // criterion_id -> written feedback
  preferred_vertical_id?: string | null;
  client_created_at?: string | null;
}

export type SubmitOutcome =
  | { status: 'ok'; evaluation: EvaluationWithScores; idempotent?: boolean }
  | { status: 'duplicate'; existing: Evaluation }
  | { status: 'conflict'; reason: string; server?: Evaluation }
  | { status: 'error'; message: string; details?: Record<string, string> };

export interface ImportRowResult {
  row: number;
  message: string;
}

export interface ImportResult {
  imported: number;
  skipped_duplicates: number;
  errors: ImportRowResult[];
}

/** A parsed workbook row ready for the upsert layer. */
export interface ImportedApplicant {
  sourceSheet: string;
  sourceRow: number;
  sourceKey: string;
  keyMethod: 'roll' | 'email' | 'name';
  full_name: string;
  roll_number: string;
  email: string;
  branch: string;
  panel: string;
  shift: string;
  priority: number | null;
  linkedin_url: string;
  github_url: string;
  team_message: string;
  remarks: string;
  task_links: TaskLink[];
  external_profiles: TaskLink[];
  source_extra: Record<string, unknown>;
}

export interface ImportApplicantsResult {
  created: number;
  updated: number;
  skipped_duplicates: number;
  errors: { row: number; sheet: string; reason: string }[];
  /** rows whose source identity matched but conflicting core values were kept */
  conflicts: { row: number; sheet: string; field: string; kept: string; incoming: string }[];
}

export interface SpreadsheetSyncItem {
  id: string;
  direction: 'to_sheet' | 'from_sheet';
  entity_type: 'applicant' | 'evaluation';
  entity_id: string;
  worksheet: string;
  row_key: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'in_flight' | 'done' | 'failed' | 'conflict';
  attempts: number;
  last_error: string;
  conflict: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface SpreadsheetConnection {
  id: string;
  kind: 'google_sheets' | 'excel_upload';
  spreadsheet_id: string;
  title: string;
  header_row: number;
  is_active: boolean;
  last_sync_at: string | null;
  last_sync_status: 'never' | 'ok' | 'error';
  last_sync_error: string;
  sheet_revision: string;
}

export type VerifyOutcome =
  | { status: 'ok'; panel: Panel }
  | { status: 'invalid' }
  | { status: 'locked'; retry_at: string }
  | { status: 'panel_inactive' };

export interface AuditEntry {
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, unknown>;
}

/**
 * Persistence boundary. SupabaseStore is used in production; MemoryStore powers
 * automated tests with identical semantics (constraints included).
 */
export interface Store {
  getProfile(id: string): Promise<Profile | null>;
  getProfilesByIds(ids: string[]): Promise<Profile[]>;
  listProfiles(role?: Role): Promise<Profile[]>;
  createProfile(input: { id: string; email: string; full_name: string; role: Role }): Promise<Profile>;
  setProfileRole(userId: string, role: Role): Promise<Profile | null>;
  setProfileActive(userId: string, isActive: boolean): Promise<Profile | null>;
  /** Removes a profile and everything that cascades from it (failed registrations). */
  deleteProfile(userId: string): Promise<void>;

  // --- addendum: verticals ---
  listVerticals(onlyActive?: boolean): Promise<Vertical[]>;
  getVertical(id: string): Promise<Vertical | null>;
  createVertical(input: { key: string; name: string; worksheet?: string | null; sort_order?: number }): Promise<Vertical>;
  updateVertical(
    id: string,
    patch: Partial<{ name: string; worksheet: string | null; is_active: boolean; sort_order: number }>,
  ): Promise<Vertical | null>;

  listPanels(): Promise<Panel[]>;
  getPanel(id: string): Promise<Panel | null>;
  createPanel(input: { name: string; expected_evaluations: number }): Promise<Panel>;
  updatePanel(
    id: string,
    patch: { name?: string; is_active?: boolean; expected_evaluations?: number },
  ): Promise<Panel | null>;
  /** Permanently deletes a panel with its codes, memberships, candidates and evaluations. */
  deletePanel(id: string): Promise<boolean>;
  listMyPanels(judgeId: string): Promise<Panel[]>;

  createPanelCode(input: {
    panel_id: string;
    code_hash: string;
    label: string;
    preview: string;
    expires_at?: string | null;
  }): Promise<PanelCodeMeta>;
  rotatePanelCode(input: {
    panel_id: string;
    code_hash: string;
    label: string;
    preview: string;
    expires_at?: string | null;
  }): Promise<PanelCodeMeta>; // deactivates previous active codes, inserts new
  setPanelCodeActive(codeId: string, isActive: boolean): Promise<PanelCodeMeta | null>;
  listPanelCodes(panelId: string): Promise<PanelCodeMeta[]>;

  /** Validates a hashed code, handles attempt counting/locking, creates membership. */
  verifyPanelCode(input: { code_hash: string; judge_id: string; lockout_minutes: number }): Promise<VerifyOutcome>;
  /** Increment a code's failure counter; lock it when attempts are exhausted. */
  recordFailedCodeAttempt(codeId: string, maxAttempts: number, lockoutMinutes: number): Promise<string | null>;
  addPanelMember(panelId: string, judgeId: string, assignedBy: string | null): Promise<void>;
  removePanelMember(panelId: string, judgeId: string): Promise<boolean>;
  listPanelMembers(panelId: string): Promise<{ judge_id: string; judge_name: string; verified_at: string | null }[]>;
  listAllPanelMembers(): Promise<
    { panel_id: string; judge_id: string; judge_name: string; verified_at: string | null }[]
  >;

  listCandidates(scope: CandidateScope, filters: CandidateFilters): Promise<Candidate[]>;
  getCandidate(id: string, scope: CandidateScope): Promise<Candidate | null>;
  createCandidate(
    input: { full_name: string; branch: string; application_id: string | null; panel_id: string },
    actorId: string,
  ): Promise<Candidate>;
  updateCandidate(
    id: string,
    patch: Partial<Omit<Candidate, 'id'>>,
  ): Promise<Candidate | null>;
  archiveCandidate(id: string, archived: boolean): Promise<Candidate | null>;
  bulkCreateCandidates(
    rows: { full_name: string; branch: string; application_id: string | null; panel_id: string }[],
    actorId: string,
  ): Promise<ImportResult>;

  // --- addendum: workbook import with stable identity ---
  /** Upsert parsed applicants. Matching order: (source_sheet, source_key),
   *  then application_id/roll_number, then email. Existing rows are updated
   *  field-by-field (never wiped); returns per-row outcomes. */
  importApplicants(
    rows: ImportedApplicant[],
    actorId: string,
  ): Promise<ImportApplicantsResult>;

  // --- addendum: spreadsheet sync queue ---
  enqueueSpreadsheetSync(item: {
    direction: 'to_sheet' | 'from_sheet';
    entity_type: 'applicant' | 'evaluation';
    entity_id: string;
    worksheet: string;
    row_key: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  claimSpreadsheetSync(limit: number): Promise<SpreadsheetSyncItem[]>;
  completeSpreadsheetSync(id: string, status: 'done' | 'failed' | 'conflict' | 'pending', detail: {
    error?: string;
    conflict?: Record<string, unknown>;
    attempts?: number;
  }): Promise<void>;
  listSpreadsheetSync(status?: string): Promise<SpreadsheetSyncItem[]>;
  getSpreadsheetConnection(): Promise<SpreadsheetConnection | null>;
  saveSpreadsheetConnection(patch: Partial<SpreadsheetConnection>): Promise<SpreadsheetConnection>;
  logSpreadsheetSync(entry: {
    connection_id: string | null;
    direction: string;
    operation: string;
    row_key: string;
    status: 'ok' | 'error' | 'conflict';
    detail: string;
    actor_id: string | null;
  }): Promise<void>;

  listRounds(): Promise<Round[]>;
  getRound(id: string): Promise<Round | null>;
  createRound(input: { name: string; is_open: boolean; allow_edit_after_submit: boolean; closes_at: string | null }): Promise<Round>;
  updateRound(
    id: string,
    patch: Partial<{ name: string; is_open: boolean; allow_edit_after_submit: boolean; closes_at: string | null }>,
  ): Promise<Round | null>;
  /** Hard-delete a round (criteria cascade). Evaluations block it unless force is set. */
  deleteRound(id: string, force?: boolean): Promise<{ deleted: boolean; evaluations: number }>;

  listCriteria(roundId: string): Promise<Criterion[]>;
  createCriterion(input: Omit<Criterion, 'id' | 'created_at'>): Promise<Criterion>;
  updateCriterion(id: string, patch: Partial<Criterion>): Promise<Criterion | null>;
  /** Hard-delete a criterion. Recorded scores block it unless force is set. */
  deleteCriterion(id: string, force?: boolean): Promise<{ deleted: boolean; scores: number }>;

  getEvaluation(id: string): Promise<EvaluationWithScores | null>;
  getOfficialEvaluation(judgeId: string, candidateId: string, roundId: string): Promise<EvaluationWithScores | null>;
  listEvaluations(filter: {
    admin: boolean;
    judgeId?: string;
    candidateId?: string;
    panelIds?: string[];
  }): Promise<EvaluationWithScores[]>;

  /** Applies duplicate/idempotency rules; writes scores; returns outcome. */
  submitEvaluation(
    judgeId: string,
    input: SubmitEvaluationInput,
    computed: { overall_score: number | null; scores: CriterionScore[] },
    opts: { replaceExisting: boolean },
  ): Promise<SubmitOutcome>;

  updateEvaluation(
    id: string,
    judgeId: string,
  patch: {
    feedback: string;
    overall_score: number | null;
    scores: CriterionScore[];
    preferred_vertical_id: string | null;
  },
): Promise<SubmitOutcome>;

  results(scope: CandidateScope, filters: CandidateFilters): Promise<ResultRow[]>;

  audit(entry: AuditEntry): Promise<void>;
}
