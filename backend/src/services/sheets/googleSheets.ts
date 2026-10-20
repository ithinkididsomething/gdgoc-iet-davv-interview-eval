import { google, type sheets_v4 } from 'googleapis';

/**
 * Thin Google Sheets client. Credentials come from a single JSON env var
 * (service-account). Never fabricates URLs: the connection stores only the
 * spreadsheet ID the admin explicitly provided; row URLs are built from it.
 */

export interface SheetsConnectionConfig {
  credentialsJson: string;
  spreadsheetId: string;
}

export interface SheetTabInfo {
  title: string;
  index: number;
  sheetId: number;
  rowCount: number;
  columnCount: number;
}

export class SheetsUnavailableError extends Error {
  constructor(reason: string) {
    super(`Google Sheets not configured: ${reason}`);
    this.name = 'SheetsUnavailableError';
  }
}

function makeClient(credentialsJson: string): sheets_v4.Sheets {
  let creds: unknown;
  try {
    creds = JSON.parse(credentialsJson);
  } catch {
    throw new SheetsUnavailableError('GOOGLE_SHEETS_CREDENTIALS is not valid JSON');
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds as Record<string, unknown>,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

export function isConfigured(cfg: Partial<SheetsConnectionConfig>): boolean {
  return Boolean(cfg.credentialsJson && cfg.spreadsheetId);
}

/** Human-readable reason for a failed Google API call (surfaced to admins). */
export function describeSheetsError(e: unknown): string {
  const err = e as {
    message?: string;
    response?: { data?: { error?: { message?: string } } };
  } | null;
  return err?.response?.data?.error?.message || err?.message || 'Google Sheets request failed';
}

/** Spreadsheet URL built only from the stored ID (no fabrication). */
export function spreadsheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

export interface SheetLinkRef {
  /** Set only when the value is a Google Sheets URL (or a bare file ID). */
  spreadsheetId: string | null;
  /** Tab id from the URL's `gid` parameter, when present. */
  gid: number | null;
}

const SHEET_URL_RE = /docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/i;
const SHEET_ID_RE = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Accepts a full Google Sheets link, a bare file ID, or a plain tab name.
 * Plain tab names return `{ spreadsheetId: null }` so callers keep using the
 * connected spreadsheet.
 */
export function parseSheetLink(value: string): SheetLinkRef {
  const raw = String(value ?? '').trim();
  if (!raw) return { spreadsheetId: null, gid: null };
  const fromUrl = raw.match(SHEET_URL_RE);
  if (fromUrl) {
    const gid = raw.match(/[#?&]gid=(\d+)/);
    return { spreadsheetId: fromUrl[1], gid: gid ? Number(gid[1]) : null };
  }
  if (SHEET_ID_RE.test(raw) && !/\s/.test(raw)) return { spreadsheetId: raw, gid: null };
  return { spreadsheetId: null, gid: null };
}

export function normalizeSpreadsheetId(value: string): string {
  return parseSheetLink(value).spreadsheetId ?? String(value ?? '').trim();
}

export async function listTabs(cfg: SheetsConnectionConfig): Promise<SheetTabInfo[]> {
  const sheets = makeClient(cfg.credentialsJson);
  const { data } = await sheets.spreadsheets.get({
    spreadsheetId: cfg.spreadsheetId,
    fields: 'sheets.properties',
  });
  return (data.sheets ?? []).map((s, i) => ({
    title: s.properties?.title ?? '',
    index: s.properties?.index ?? i,
    sheetId: s.properties?.sheetId ?? i,
    rowCount: s.properties?.gridProperties?.rowCount ?? 0,
    columnCount: s.properties?.gridProperties?.columnCount ?? 0,
  }));
}

/** Read a tab as raw rows (first row = header when headerRow is true). */
export async function readTab(
  cfg: SheetsConnectionConfig,
  tabTitle: string,
): Promise<{ values: unknown[][]; revision: string }> {
  const sheets = makeClient(cfg.credentialsJson);
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range: `'${tabTitle.replace(/'/g, "''")}'`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = (data.values ?? []) as unknown[][];
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: cfg.spreadsheetId,
    fields: 'sheets.properties(sheetId,gridProperties(rowCount))',
  });
  const tab = (meta.data.sheets ?? []).find((s) => s.properties?.title === tabTitle);
  const revision = `${tab?.properties?.sheetId ?? 'tab'}:${values.length}:${data.majorDimension ?? 'ROWS'}`;
  return { values, revision };
}

export interface WriteBatch {
  range: string;
  values: unknown[][];
}

/** Batch-write ranges (values only — never touches formulas). */
export async function writeBatch(cfg: SheetsConnectionConfig, batch: WriteBatch[]): Promise<void> {
  if (batch.length === 0) return;
  const sheets = makeClient(cfg.credentialsJson);
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: cfg.spreadsheetId,
    requestBody: {
      valueInputOption: 'RAW',
      data: batch.map((b) => ({ range: b.range, values: b.values })),
    },
  });
}

/** Append a row after the last non-empty row of the tab. */
export async function appendRow(
  cfg: SheetsConnectionConfig,
  tabTitle: string,
  row: unknown[],
): Promise<void> {
  const sheets = makeClient(cfg.credentialsJson);
  const range = `'${tabTitle.replace(/'/g, "''")}'`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: cfg.spreadsheetId,
    range,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
}

  /** Append several rows in one request (used by queued evaluation pushes). */
  export async function appendRows(
    cfg: SheetsConnectionConfig,
    tabTitle: string,
    rows: unknown[][],
  ): Promise<void> {
    if (rows.length === 0) return;
    const sheets = makeClient(cfg.credentialsJson);
    const range = `'${tabTitle.replace(/'/g, "''")}'`;
    await sheets.spreadsheets.values.append({
      spreadsheetId: cfg.spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: rows },
    });
  }

  /** Tab titles cannot contain these characters and are capped at 100 chars. */
export function sanitizeTabTitle(value: string): string {
  const cleaned = String(value ?? '')
    .replace(/[[\]:*?/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return cleaned || 'Sheet';
}

/** Create the tab when missing; returns true when it was created. */
export async function ensureTab(cfg: SheetsConnectionConfig, title: string): Promise<boolean> {
  const sheets = makeClient(cfg.credentialsJson);
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: cfg.spreadsheetId,
    fields: 'sheets.properties(title)',
  });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === title);
  if (exists) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  return true;
}

/** Replace a tab's values starting at A1 (header row included). */
export async function overwriteTab(
  cfg: SheetsConnectionConfig,
  tabTitle: string,
  values: unknown[][],
): Promise<void> {
  const sheets = makeClient(cfg.credentialsJson);
  const range = `'${tabTitle.replace(/'/g, "''")}'`;
  await sheets.spreadsheets.values.clear({ spreadsheetId: cfg.spreadsheetId, range });
  await sheets.spreadsheets.values.update({
    spreadsheetId: cfg.spreadsheetId,
    range: `${range}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/** Find the 1-based row number whose key column matches (exact, then case-insensitive). */
export function findRowByKey(values: unknown[][], keyColumn: number, key: string): number | null {
  if (!key) return null;
  const target = String(key).trim();
  const lower = target.toLowerCase();
  for (let i = 0; i < values.length; i++) {
    const cell = values[i]?.[keyColumn];
    if (cell === undefined || cell === null) continue;
    const s = String(cell).trim();
    if (s === target) return i + 1;
  }
  for (let i = 0; i < values.length; i++) {
    const cell = values[i]?.[keyColumn];
    if (cell === undefined || cell === null) continue;
    if (String(cell).trim().toLowerCase() === lower) return i + 1;
  }
  return null;
}

export function columnIndex(headers: unknown[], aliases: string[]): number | null {
  const normalized = headers.map((h) =>
    String(h ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, ''),
  );
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return null;
}
