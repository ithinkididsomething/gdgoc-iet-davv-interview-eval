import * as XLSX from 'xlsx';
import {
  REQUIRED_FIELDS,
  extractDriveLinks,
  extractProfileUrl,
  mapColumns,
  looksLikeApplicantSheet,
  looksLikeResultsExport,
  normalizeHeader,
  rowKeyFor,
} from './columns.js';

export interface ImportRowError {
  sheet: string;
  row: number;
  reason: string;
  raw?: unknown;
}

export interface SheetAudit {
  sheet: string;
  rows: number;
  applicantRows: number;
  usedAsSource: boolean;
  headers: string[];
  reason?: string;
}

export interface ParsedApplicant {
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
  task_links: { label: string; url: string }[];
  external_profiles: { label: string; url: string }[];
  source_extra: Record<string, unknown>;
}

export interface ImportReport {
  file: string;
  sheets: SheetAudit[];
  applicants: ParsedApplicant[];
  errors: ImportRowError[];
  /** duplicate (sheet,key) pairs inside this file — first occurrence wins */
  intraFileDuplicates: number;
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}

function parsePriority(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.round(n);
  return i >= 1 && i <= 10 ? i : null;
}

/**
 * Parse a workbook (.xlsx/.xls/.csv buffer). Every worksheet is inspected —
 * sheets are NOT assumed to share columns. Applicant sheets are those whose
 * header row maps a name column; other sheets are audited and skipped with a
 * reason instead of silently ignored.
 */
export function parseWorkbook(buf: Buffer, filename: string): ImportReport {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const report: ImportReport = {
    file: filename,
    sheets: [],
    applicants: [],
    errors: [],
    intraFileDuplicates: 0,
  };
  const seenKeys = new Set<string>();

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false, raw: false });
    if (matrix.length === 0) {
      report.sheets.push({ sheet: sheetName, rows: 0, applicantRows: 0, usedAsSource: false, headers: [], reason: 'empty' });
      continue;
    }
    const headerIdx = findHeaderRow(matrix);
    const headers = (matrix[headerIdx] ?? []).map((h) => cellToString(h));
    const fields = mapColumns(headers);
    const isResultsExport = looksLikeResultsExport(headers);
    const isApplicant = !isResultsExport && looksLikeApplicantSheet(headers);
    const audit: SheetAudit = {
      sheet: sheetName,
      rows: matrix.length - headerIdx - 1,
      applicantRows: 0,
      usedAsSource: isApplicant,
      headers,
    };
    if (isResultsExport) {
      audit.reason = 'results export, not applicant data';
      report.sheets.push(audit);
      continue;
    }
    if (!isApplicant) {
      audit.reason = 'no applicant-name column in header';
      report.sheets.push(audit);
      continue;
    }

    const missing = REQUIRED_FIELDS.filter((f) => !fields.has(f));
    if (missing.length > 0) {
      audit.reason = `missing required columns: ${missing.join(', ')}`;
      audit.usedAsSource = false;
      report.sheets.push(audit);
      continue;
    }

    const knownFields = new Set(fields.keys());
    const extraHeaderIdx: number[] = [];
    headers.forEach((h, i) => {
      const norm = normalizeHeader(h);
      if (!norm) return;
      const isKnown = [...knownFields].some((f) => {
        const idx = fields.get(f);
        return idx === i;
      });
      if (!isKnown) extraHeaderIdx.push(i);
    });

    for (let r = headerIdx + 1; r < matrix.length; r++) {
      const row = matrix[r] ?? [];
      const rowNum = r + 1; // 1-based sheet row
      const { key, method } = rowKeyFor(fields, row);
      const name = cellToString(row[fields.get('full_name')!]);
      if (!name && !key) {
        report.errors.push({ sheet: sheetName, row: rowNum, reason: 'row has no applicant name or identifier' });
        continue;
      }
      if (!name) {
        report.errors.push({ sheet: sheetName, row: rowNum, reason: 'missing required value: applicant name' });
        continue;
      }
      const dedupeId = `${sheetName}::${key || name.toUpperCase()}`;
      if (seenKeys.has(dedupeId)) {
        report.intraFileDuplicates++;
        continue;
      }
      seenKeys.add(dedupeId);

      const cell = (f: string): string => {
        const idx = fields.get(f);
        return idx === undefined ? '' : cellToString(row[idx]);
      };

      const sourceExtra: Record<string, unknown> = {};
      for (const i of extraHeaderIdx) {
        const h = headers[i];
        const v = row[i];
        if (v === undefined || v === null || cellToString(v) === '') continue;
        sourceExtra[h] = cellToString(v);
      }

      const taskIdx = fields.get('task_links');
      const taskCell = taskIdx === undefined ? '' : row[taskIdx];
      const taskLinks = extractDriveLinks(taskCell);

      report.applicants.push({
        sourceSheet: sheetName,
        sourceRow: rowNum,
        sourceKey: key,
        keyMethod: method,
        full_name: name,
        roll_number: cell('roll_number'),
        email: cell('email'),
        branch: cell('branch'),
        panel: cell('panel'),
        shift: cell('shift'),
        priority: parsePriority(row[fields.get('priority')!]),
        linkedin_url: extractProfileUrl(row[fields.get('linkedin_url') ?? -1]),
        github_url: extractProfileUrl(row[fields.get('github_url') ?? -1]),
        team_message: cell('team_message'),
        remarks: cell('remarks'),
        task_links: taskLinks,
        external_profiles: buildExternalProfiles(fields, row),
        source_extra: sourceExtra,
      });
      audit.applicantRows++;
    }
    report.sheets.push(audit);
  }
  return report;
}

function findHeaderRow(matrix: unknown[][]): number {
  for (let i = 0; i < Math.min(matrix.length, 10); i++) {
    const headers = (matrix[i] ?? []).map((h) => cellToString(h));
    if (headers.filter(Boolean).length < 2) continue;
    if (looksLikeApplicantSheet(headers)) return i;
  }
  return 0;
}

function buildExternalProfiles(
  fields: Map<string, number>,
  row: unknown[],
): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const linkedinIdx = fields.get('linkedin_url');
  const githubIdx = fields.get('github_url');
  if (linkedinIdx !== undefined) {
    const url = extractProfileUrl(row[linkedinIdx]);
    if (url) out.push({ label: 'LinkedIn', url });
  }
  if (githubIdx !== undefined) {
    const url = extractProfileUrl(row[githubIdx]);
    if (url) out.push({ label: 'GitHub', url });
  }
  // Any column literally named "instagram"/"other profile"/etc. with a URL.
  for (const [field, idx] of fields) {
    if (field === 'linkedin_url' || field === 'github_url') continue;
    const url = extractProfileUrl(row[idx]);
    if (url && /instagram|other|twitter|x\.com|behance|dribbble/i.test(field)) {
      out.push({ label: field, url });
    }
  }
  return out;
}
