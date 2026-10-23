import { columnIndex, ensureTab, findRowByKey, readTab, spreadsheetUrl, writeBatch, appendRows, isConfigured, listTabs, parseSheetLink, overwriteTab, sanitizeTabTitle, SheetsUnavailableError } from '../sheets/googleSheets.js';
import type { SheetsConnectionConfig } from '../sheets/googleSheets.js';
import { COLUMN_ALIASES, looksLikeResultsExport, normalizeHeader } from '../importer/columns.js';
import type { AppConfig } from '../../config.js';
import type {
  Store,
  ResultRow,
  Candidate,
  EvaluationWithScores,
  SpreadsheetSyncItem,
} from '../../store/types.js';

/**
 * Two-way spreadsheet sync.
 *
 * - from_sheet: read applicant tabs (mapped by vertical.worksheet) and run the
 *   same upsert as a workbook import.
 * - to_sheet:   push evaluation rows for the queue (applicant status + scores).
 * - Everything goes through the durable sync_queue with retry + conflict rows;
 *   a failure never blocks an offline submission — the queue drains later.
 */

export interface SyncRunSummary {
  pulled: { worksheet: string; created: number; updated: number; skipped: number; errors: number }[];
  pushed: { id: string; status: 'done' | 'failed' | 'conflict' | 'pending'; detail?: string }[];
  skipped: string[];
  connection_ok: boolean;
  error?: string;
}

const APPLICANT_KEY_ALIASES = ['roll_number', 'application_id', 'applicant_id', 'email', 'full_name', 'applicant_name'];

function sheetsConfig(store: Store, config: AppConfig): { credentialsJson: string; spreadsheetId: string } | null {
  if (!config.googleSheetsCredentials) return null;
  // store-configured id wins over env default
  return { credentialsJson: config.googleSheetsCredentials, spreadsheetId: config.defaultSpreadsheetId };
}

/**
 * A vertical's worksheet may be a tab name or a Google Sheets link. Links can
 * point at a different spreadsheet/tab (`#gid=…`), so resolve them to the
 * actual tab title before reading or writing.
 */
async function resolveWorksheet(
  cfg: SheetsConnectionConfig,
  worksheet: string,
): Promise<{ reference: SheetsConnectionConfig; tabTitle: string }> {
  const ref = parseSheetLink(worksheet);
  if (!ref.spreadsheetId) return { reference: cfg, tabTitle: worksheet };
  const reference = { credentialsJson: cfg.credentialsJson, spreadsheetId: ref.spreadsheetId };
  const tabs = await listTabs(reference);
  const tab = (ref.gid !== null ? tabs.find((t) => t.sheetId === ref.gid) : undefined) ?? tabs[0];
  if (!tab) throw new SheetsUnavailableError(`spreadsheet ${ref.spreadsheetId} has no tabs`);
  return { reference, tabTitle: tab.title };
}

export async function pullFromSheets(store: Store, config: AppConfig, actorId: string): Promise<SyncRunSummary> {
  const summary: SyncRunSummary = { pulled: [], pushed: [], skipped: [], connection_ok: false };
  const cfg = sheetsConfig(store, config);
  const connection = await store.getSpreadsheetConnection();
  const spreadsheetId = connection?.spreadsheet_id || cfg?.spreadsheetId || '';
  if (!cfg || !spreadsheetId) {
    summary.error = 'Google Sheets credentials or spreadsheet ID not configured';
    return summary;
  }
  const effective = { credentialsJson: cfg.credentialsJson, spreadsheetId };
  summary.connection_ok = true;
  const verticals = await store.listVerticals();
  for (const v of verticals) {
    if (!v.worksheet) {
      summary.skipped.push(`vertical "${v.key}" has no worksheet mapped`);
      continue;
    }
    let tab = v.worksheet;
    try {
      const resolved = await resolveWorksheet(effective, v.worksheet);
      tab = resolved.tabTitle;
      const { values, revision } = await readTab(resolved.reference, tab);
      if (values.length < 2) {
        summary.pulled.push({ worksheet: tab, created: 0, updated: 0, skipped: 0, errors: 0 });
        continue;
      }
      const headers = (values[0] ?? []).map((h) => String(h ?? '').trim());
      if (looksLikeResultsExport(headers)) {
        summary.skipped.push(`worksheet "${tab}" is a results export, not applicant data`);
        continue;
      }
      const mapped: Record<string, number> = {};
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        const idx = columnIndex(headers, [field, ...aliases.map((a) => a.toLowerCase())]);
        if (idx !== null) mapped[field] = idx;
      }
      const keyCol = columnIndex(headers, APPLICANT_KEY_ALIASES);
      if (mapped.full_name === undefined || keyCol === null) {
        summary.skipped.push(`worksheet "${tab}" has no name/key column`);
        continue;
      }
      const rows = [];
      for (let i = 1; i < values.length; i++) {
        const row = values[i] ?? [];
        const cell = (f: string): string => {
          const idx = mapped[f];
          return idx === undefined ? '' : String(row[idx] ?? '').trim();
        };
        const full_name = cell('full_name');
        const key = String(row[keyCol] ?? '').trim();
        if (!full_name && !key) continue;
        const extra: Record<string, unknown> = {};
        headers.forEach((h, ci) => {
          const known = Object.values(mapped).includes(ci) || ci === keyCol;
          const norm = normalizeHeader(h);
          if (!known && norm) {
            const v2 = row[ci];
            if (v2 !== undefined && v2 !== null && String(v2).trim() !== '') extra[h] = String(v2).trim();
          }
        });
        rows.push({
          sourceSheet: tab,
          sourceRow: i + 1,
          sourceKey: key || full_name.toUpperCase(),
          keyMethod: (key ? 'roll' : 'name') as 'roll' | 'email' | 'name',
          full_name,
          roll_number: cell('roll_number') || cell('application_id'),
          email: cell('email'),
          branch: cell('branch'),
          panel: cell('panel'),
          shift: cell('shift') || v.key,
          priority: Number(cell('priority')) || null,
          linkedin_url: cell('linkedin_url'),
          github_url: cell('github_url'),
          team_message: cell('team_message'),
          remarks: cell('remarks'),
          task_links: [],
          external_profiles: [],
          source_extra: extra,
        });
      }
      const result = await store.importApplicants(rows, actorId);
      summary.pulled.push({
        worksheet: tab,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped_duplicates,
        errors: result.errors.length,
      });
      await store.logSpreadsheetSync({
        connection_id: connection?.id ?? null,
        direction: 'from_sheet',
        operation: 'pull',
        row_key: tab,
        status: result.errors.length ? 'conflict' : 'ok',
        detail: `created=${result.created} updated=${result.updated} errors=${result.errors.length} revision=${revision}`,
        actor_id: actorId,
      });
    } catch (e) {
      const msg = e instanceof SheetsUnavailableError ? e.message : String((e as Error).message ?? e);
      summary.skipped.push(`worksheet "${tab}": ${msg}`);
      await store.logSpreadsheetSync({
        connection_id: connection?.id ?? null,
        direction: 'from_sheet',
        operation: 'pull',
        row_key: tab,
        status: 'error',
        detail: msg,
        actor_id: actorId,
      });
    }
  }
  return summary;
}

/**
 * Every judge's recommended vertical for a candidate, e.g.
 * "Technical (Parth), Design (Yash)". Ordered oldest-first for stable output.
 */
function preferredVerticalLabels(
  evaluations: EvaluationWithScores[],
  verticalNames: Map<string, string>,
): Map<string, string[]> {
  const preferences = new Map<string, string[]>();
  for (const e of [...evaluations].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
    if (!e.preferred_vertical_id) continue;
    const name = verticalNames.get(e.preferred_vertical_id);
    if (!name) continue;
    const label = e.judge_name ? `${name} (${e.judge_name})` : name;
    const list = preferences.get(e.candidate_id) ?? [];
    list.push(label);
    preferences.set(e.candidate_id, list);
  }
  return preferences;
}

/** Every judge's written remark for a candidate, labelled and newest-last. */
function judgeRemarks(evaluations: EvaluationWithScores[]): Map<string, string[]> {
  const remarks = new Map<string, string[]>();
  for (const e of [...evaluations].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at))) {
    const text = (e.feedback ?? '').trim();
    if (!text) continue;
    const label = e.judge_name ? `${e.judge_name}: ${text}` : text;
    const list = remarks.get(e.candidate_id) ?? [];
    list.push(label);
    remarks.set(e.candidate_id, list);
  }
  return remarks;
}

/** Columns M-T: the evaluation block shared by exports and queue pushes. */
function evaluationValues(
  row: ResultRow | undefined,
  preferences: string[],
  remarks: string[],
): unknown[] {
  if (!row) return ['', '', '', '', '', '', preferences.join(', '), remarks.join('\n')];
  const judgeCount = row.judge_ratings.length;
  const individualScores = row.judge_ratings.map((j) => (j.score === null ? '' : Number(j.score)));
  return [
    row.evaluation_count,
    row.expected_evaluations,
    row.is_provisional ? 'provisional' : row.evaluation_status,
    individualScores.join(' | '),
    row.average_score === null ? '' : row.average_score,
    judgeCount,
    preferences.join(', '),
    remarks.join('\n'),
  ];
}

/** Build one sheet row for an evaluation queue item. */
function evaluationRow(
  item: SpreadsheetSyncItem,
  results: Map<string, ResultRow>,
  preferences: Map<string, string[]>,
  remarks: Map<string, string[]>,
): unknown[] | null {
  const row = results.get(item.entity_id);
  if (!row) return null;
  return [
    row.roll_number || row.application_id || '',
    row.full_name,
    row.vertical_name ?? '',
    row.shift ?? '',
    row.branch,
    row.panel_name,
    ...evaluationValues(
      row,
      preferences.get(item.entity_id) ?? [],
      remarks.get(item.entity_id) ?? [],
    ),
  ];
}

const EVAL_HEADER = [
  'roll_number',
  'applicant_name',
  'vertical',
  'shift',
  'branch',
  'panel',
  'evaluations_received',
  'evaluations_expected',
  'completion',
  'individual_scores',
  'final_average',
  'judge_count',
  'preferred_vertical_interview',
  'judge_remarks_interview',
];

interface PushPlan {
  reference: SheetsConnectionConfig;
  tab: string;
  keyCol: number;
  nameCol: number;
  scoreCols: (number | null)[];
  headers: unknown[];
  values: unknown[][];
  updates: { range: string; values: unknown[][] }[];
  appends: unknown[][];
  items: SpreadsheetSyncItem[];
}

function planFor(
  plans: Map<string, PushPlan>,
  resolved: { reference: SheetsConnectionConfig; tabTitle: string },
  values: unknown[][],
): PushPlan | null {
  const key = `${resolved.reference.spreadsheetId}|${resolved.tabTitle}`;
  const existing = plans.get(key);
  if (existing) return existing;
  const headers = (values[0] ?? []).map((h) => String(h ?? ''));
  const keyCol = columnIndex(headers, APPLICANT_KEY_ALIASES);
  const nameCol = columnIndex(headers, ['full_name', 'applicant_name', 'name']);
  if (keyCol === null || nameCol === null) return null;
  const plan: PushPlan = {
    reference: resolved.reference,
    tab: resolved.tabTitle,
    keyCol,
    nameCol,
    scoreCols: EVAL_HEADER.map((h) => columnIndex(headers, [h])),
    headers,
    values,
    updates: [],
    appends: [],
    items: [],
  };
  plans.set(key, plan);
  return plan;
}

function contiguousUpdates(
  plan: PushPlan,
  rowNumber: number,
  row: unknown[],
): { range: string; values: unknown[][] }[] {
  const cells: { col: number; value: unknown }[] = [];
  for (let i = 0; i < EVAL_HEADER.length; i++) {
    const col = plan.scoreCols[i];
    if (col === null) continue;
    cells.push({ col, value: row[i] });
  }
  cells.sort((a, b) => a.col - b.col);
  const updates: { range: string; values: unknown[][] }[] = [];
  const tab = plan.tab.replace(/'/g, "''");
  for (let start = 0; start < cells.length; ) {
    let end = start;
    while (end + 1 < cells.length && cells[end + 1].col === cells[end].col + 1) end++;
    updates.push({
      range: `'${tab}'!${colLetter(cells[start].col)}${rowNumber}`,
      values: [cells.slice(start, end + 1).map((c) => c.value)],
    });
    start = end + 1;
  }
  return updates;
}

function appendedRow(plan: PushPlan, row: unknown[]): unknown[] {
  const values = new Array(plan.headers.length).fill('');
  for (let i = 0; i < EVAL_HEADER.length; i++) {
    const col = plan.scoreCols[i];
    if (col !== null) values[col] = row[i];
  }
  values[plan.keyCol] = row[0];
  values[plan.nameCol] = row[1];
  return values;
}

export async function pushToSheets(store: Store, config: AppConfig, actorId: string): Promise<SyncRunSummary> {
  const summary: SyncRunSummary = { pulled: [], pushed: [], skipped: [], connection_ok: false };
  const cfg = sheetsConfig(store, config);
  const connection = await store.getSpreadsheetConnection();
  const spreadsheetId = connection?.spreadsheet_id || cfg?.spreadsheetId || '';
  if (!cfg || !spreadsheetId) {
    summary.error = 'Google Sheets credentials or spreadsheet ID not configured';
    const pending = await store.listSpreadsheetSync('pending');
    for (const item of pending) {
      await store.completeSpreadsheetSync(item.id, 'failed', { error: summary.error });
      summary.pushed.push({ id: item.id, status: 'failed', detail: summary.error });
    }
    return summary;
  }
  const effective = { credentialsJson: cfg.credentialsJson, spreadsheetId };
  summary.connection_ok = true;

  // Drain the durable queue. Concurrent drains are safe: claim is atomic and
  // each queued entity has exactly one row (latest submission wins).
  const claimed = await store.claimSpreadsheetSync(50);
  if (claimed.length === 0) return summary;

  const resultsList = await store.results({ admin: true }, { includeArchived: true });
  const results = new Map(resultsList.map((r) => [r.candidate_id, r]));
  const verticals = await store.listVerticals();
  const byId = new Map(verticals.map((v) => [v.id, v]));
  const verticalNames = new Map(verticals.map((v) => [v.id, v.name]));
  const evaluations = await store.listEvaluations({ admin: true });
  const preferences = preferredVerticalLabels(evaluations, verticalNames);
  const remarks = judgeRemarks(evaluations);

  const plans = new Map<string, PushPlan>();
  const resolvedCache = new Map<string, { reference: SheetsConnectionConfig; tabTitle: string }>();
  const logError = async (item: SpreadsheetSyncItem, msg: string, terminal: boolean) => {
    const attempts = item.attempts + 1;
    const status = terminal || attempts >= 5 ? 'failed' : 'pending';
    await store.completeSpreadsheetSync(item.id, status, { error: msg, attempts });
    summary.pushed.push({ id: item.id, status, detail: msg });
    await store.logSpreadsheetSync({
      connection_id: connection?.id ?? null,
      direction: 'to_sheet',
      operation: 'push',
      row_key: item.row_key,
      status: 'error',
      detail: msg,
      actor_id: actorId,
    });
  };

  for (const item of claimed) {
    if (item.entity_type !== 'evaluation') {
      await store.completeSpreadsheetSync(item.id, 'done', {});
      summary.pushed.push({ id: item.id, status: 'done' });
      continue;
    }
    const row = evaluationRow(item, results, preferences, remarks);
    if (!row) {
      await logError(item, 'candidate no longer exists', true);
      continue;
    }
    const worksheet =
      item.worksheet || byId.get(results.get(item.entity_id)?.vertical_id ?? '')?.worksheet || '';
    if (!worksheet) {
      await logError(item, 'no worksheet mapped for vertical', true);
      continue;
    }
    try {
      let resolved = resolvedCache.get(worksheet);
      if (!resolved) {
        resolved = await resolveWorksheet(effective, worksheet);
        resolvedCache.set(worksheet, resolved);
      }
      const planKey = `${resolved.reference.spreadsheetId}|${resolved.tabTitle}`;
      let plan = plans.get(planKey);
      if (!plan) {
        const { values } = await readTab(resolved.reference, resolved.tabTitle);
        plan = planFor(plans, resolved, values) ?? undefined;
        if (!plan) {
          await logError(item, `worksheet "${resolved.tabTitle}" header row missing key/name columns`, true);
          continue;
        }
      }
      const matchRow =
        findRowByKey(plan.values, plan.keyCol, item.row_key) ??
        findRowByKey(plan.values, plan.nameCol, item.row_key);
      if (matchRow) {
        plan.updates.push(...contiguousUpdates(plan, matchRow, row));
      } else {
        plan.appends.push(appendedRow(plan, row));
      }
      plan.items.push(item);
    } catch (e) {
      await logError(item, String((e as Error).message ?? e), false);
    }
  }

  for (const plan of plans.values()) {
    try {
      if (plan.updates.length) await writeBatch(plan.reference, plan.updates);
      if (plan.appends.length) await appendRows(plan.reference, plan.tab, plan.appends);
      for (const item of plan.items) {
        await store.completeSpreadsheetSync(item.id, 'done', {});
        summary.pushed.push({ id: item.id, status: 'done' });
        await store.logSpreadsheetSync({
          connection_id: connection?.id ?? null,
          direction: 'to_sheet',
          operation: 'update',
          row_key: item.row_key,
          status: 'ok',
          detail: `tab=${plan.tab}`,
          actor_id: actorId,
        });
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      for (const item of plan.items) await logError(item, msg, false);
    }
  }
  return summary;
}

/**
 * Header row for applicant exports. Labels stay alias-compatible with the
 * importer (e.g. "Roll Number" -> roll_number) and include the evaluation
 * columns pushed by `pushToSheets`.
 */
export const APPLICANT_EXPORT_HEADER = [
  'Roll Number',
  'Applicant Name',
  'Email',
  'Vertical',
  'Branch',
  'Panel',
  'Shift',
  'Priority',
  'LinkedIn',
  'GitHub',
  'Team Message',
  'Remarks',
  'Evaluations Received',
  'Evaluations Expected',
  'Completion',
  'Individual Scores',
  'Final Average',
  'Judge Count',
  'Preferred Vertical (Interview)',
  'Judge Remarks (Interview)',
];

export interface ExportSummary {
  written: { worksheet: string; rows: number; created: boolean }[];
  skipped: string[];
  connection_ok: boolean;
  error?: string;
}

/**
 * Rewrite one tab per vertical with the header row and every active applicant.
 * Tabs are created when missing; a vertical mapped to a sheet link writes to
 * the resolved tab and keeps the link mapping.
 */
export async function exportApplicantsToSheets(
  store: Store,
  config: AppConfig,
  actorId: string,
): Promise<ExportSummary> {
  const summary: ExportSummary = { written: [], skipped: [], connection_ok: false };
  const cfg = sheetsConfig(store, config);
  const connection = await store.getSpreadsheetConnection();
  const spreadsheetId = connection?.spreadsheet_id || cfg?.spreadsheetId || '';
  if (!cfg || !spreadsheetId) {
    summary.error = 'Google Sheets credentials or spreadsheet ID not configured';
    return summary;
  }
  const effective: SheetsConnectionConfig = { credentialsJson: cfg.credentialsJson, spreadsheetId };
  summary.connection_ok = true;

  const [verticals, panels, candidates, evaluations, resultsList] = await Promise.all([
    store.listVerticals(),
    store.listPanels(),
    store.listCandidates({ admin: true }, { includeArchived: false }),
    store.listEvaluations({ admin: true }),
    store.results({ admin: true }, { includeArchived: true }),
  ]);
  const panelNames = new Map(panels.map((p) => [p.id, p.name]));
  const verticalNames = new Map(verticals.map((v) => [v.id, v.name]));
  const preferences = preferredVerticalLabels(evaluations, verticalNames);
  const remarks = judgeRemarks(evaluations);
  const resultByCandidate = new Map(resultsList.map((r) => [r.candidate_id, r]));
  const groups = new Map<string, Candidate[]>();
  const unassigned: Candidate[] = [];
  for (const c of candidates) {
    if (!c.vertical_id) {
      unassigned.push(c);
      continue;
    }
    const list = groups.get(c.vertical_id) ?? [];
    list.push(c);
    groups.set(c.vertical_id, list);
  }

  const rowFor = (c: Candidate, verticalName: string): unknown[] => [
    c.roll_number || c.application_id || '',
    c.full_name,
    c.email ?? '',
    verticalName,
    c.branch ?? '',
    panelNames.get(c.panel_id) ?? '',
    c.shift ?? '',
    c.priority ?? '',
    c.linkedin_url ?? '',
    c.github_url ?? '',
    c.team_message ?? '',
    c.remarks ?? '',
    ...evaluationValues(
      resultByCandidate.get(c.id),
      preferences.get(c.id) ?? [],
      remarks.get(c.id) ?? [],
    ),
  ];

  const writeTab = async (
    reference: SheetsConnectionConfig,
    tabTitle: string,
    rows: Candidate[],
    verticalName: string,
  ): Promise<{ created: boolean; rows: number }> => {
    const created = await ensureTab(reference, tabTitle);
    await overwriteTab(reference, tabTitle, [
      APPLICANT_EXPORT_HEADER,
      ...rows.map((c) => rowFor(c, verticalName)),
    ]);
    return { created, rows: rows.length };
  };

  const byRoll = (a: Candidate, b: Candidate) =>
    (a.roll_number || a.full_name).localeCompare(b.roll_number || b.full_name);

  for (const v of verticals) {
    const rows = (groups.get(v.id) ?? []).sort(byRoll);
    if (rows.length === 0) {
      summary.skipped.push(`vertical "${v.key}" has no applicants`);
      continue;
    }
    let tabTitle = '';
    try {
      const ref = parseSheetLink(v.worksheet ?? '');
      let reference = effective;
      if (ref.spreadsheetId && v.worksheet) {
        const resolved = await resolveWorksheet(effective, v.worksheet);
        reference = resolved.reference;
        tabTitle = resolved.tabTitle;
      } else {
        tabTitle = sanitizeTabTitle(v.worksheet || v.name);
      }
      const res = await writeTab(reference, tabTitle, rows, v.name);
      summary.written.push({ worksheet: tabTitle, rows: res.rows, created: res.created });
      if (!ref.spreadsheetId && v.worksheet !== tabTitle) {
        await store.updateVertical(v.id, { worksheet: tabTitle });
      }
      await store.logSpreadsheetSync({
        connection_id: connection?.id ?? null,
        direction: 'to_sheet',
        operation: 'export',
        row_key: tabTitle,
        status: 'ok',
        detail: `rows=${rows.length}`,
        actor_id: actorId,
      });
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      summary.skipped.push(`vertical "${v.key}": ${msg}`);
      await store.logSpreadsheetSync({
        connection_id: connection?.id ?? null,
        direction: 'to_sheet',
        operation: 'export',
        row_key: tabTitle || v.key,
        status: 'error',
        detail: msg,
        actor_id: actorId,
      });
    }
  }

  if (unassigned.length) {
    unassigned.sort(byRoll);
    try {
      const res = await writeTab(effective, 'Unassigned', unassigned, 'Unassigned');
      summary.written.push({ worksheet: 'Unassigned', rows: res.rows, created: res.created });
    } catch (e) {
      summary.skipped.push(`unassigned applicants: ${String((e as Error).message ?? e)}`);
    }
  }
  return summary;
}

function colLetter(idx: number): string {
  let n = idx;
  let out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return out;
}

export async function connectionStatus(store: Store, config: AppConfig): Promise<Record<string, unknown>> {
  const conn = await store.getSpreadsheetConnection();
  const hasCreds = Boolean(config.googleSheetsCredentials);
  const spreadsheetId = conn?.spreadsheet_id || config.defaultSpreadsheetId;
  return {
    configured: hasCreds && Boolean(spreadsheetId),
    has_credentials: hasCreds,
    spreadsheet_id: spreadsheetId || '',
    // Built strictly from the stored ID — never fabricated.
    url: spreadsheetId ? spreadsheetUrl(spreadsheetId) : '',
    connection: conn,
    reachable: hasCreds && isConfigured({ credentialsJson: config.googleSheetsCredentials ?? '', spreadsheetId }),
  };
}
