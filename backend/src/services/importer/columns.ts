/**
 * Vertical → worksheet mapping. Vertical names are configurable in the
 * database (public.verticals, seeded from the addendum); this module only
 * provides matching heuristics and column aliases for the workbook importer.
 */

/** Column aliases we accept for each logical applicant field (case/space insensitive). */
export const COLUMN_ALIASES: Record<string, string[]> = {
  roll_number: ['roll number', 'roll no', 'rollno', 'enrollment number', 'enrollment no', 'enrolment number'],
  full_name: ['applicant name', 'full name', 'name', 'student name'],
  email: ['email', 'email id', 'e-mail', 'college email id', 'google email'],
  branch: ['branch', 'department'],
  panel: ['panel'],
  shift: ['shift'],
  priority: ['priority', 'priority rank'],
  linkedin_url: ['linkedin', 'linkedin profile', 'linkedin id', 'linkedin url', 'link to your linkedin profile'],
  github_url: ['github', 'github profile', 'github id', 'github url', 'link to your github profile'],
  team_message: ['team message', 'message to the team', 'team msg'],
  remarks: ['remarks', 'remark', 'comments', 'notes'],
  task_links: ['task link', 'task links', 'google drive link', 'drive link', 'drive task link', 'submitted task', 'submitted tasks'],
};

/** Fields that must be present for a row to be importable. */
export const REQUIRED_FIELDS = ['full_name'] as const;

/** Normalize a header cell for alias matching. */
export function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Map raw header cells → logical field names. Unmapped columns are preserved in source_extra. */
export function mapColumns(headers: unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  headers.forEach((h, idx) => {
    const norm = normalizeHeader(h);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (out.has(field)) continue;
      if (aliases.includes(norm)) {
        out.set(field, idx);
        break;
      }
    }
  });
  return out;
}

/**
 * Heuristic: pick the worksheet whose header row contains an applicant-name
 * column. Sheets that do not look like applicant sheets are reported, not
 * silently dropped.
 */
export function looksLikeApplicantSheet(headers: unknown[]): boolean {
  const mapped = mapColumns(headers);
  return mapped.has('full_name');
}

/** Columns emitted by the results exports; these sheets are never applicants. */
const RESULTS_EXPORT_MARKERS = [
  'average score',
  'evaluation count',
  'expected evaluations',
  'evaluation status',
  'shortlisting status',
  'overall score',
  'criterion scores',
];

/**
 * A results export also contains an applicant-name column, so it would
 * otherwise be accepted by the importer and re-create every candidate under a
 * synthetic sheet (e.g. "Sheet1"). Reject it before taking any rows.
 */
export function looksLikeResultsExport(headers: unknown[]): boolean {
  const normalized = new Set(headers.map((h) => normalizeHeader(h)));
  if (!normalized.has('candidate id')) return false;
  return RESULTS_EXPORT_MARKERS.filter((h) => normalized.has(h)).length >= 2;
}

/** Stable identity for a row: prefer roll number, fall back to email, then name+sheet. */
export function rowKeyFor(
  fields: Map<string, number>,
  row: unknown[],
): { key: string; method: 'roll' | 'email' | 'name' } {
  const cell = (f: string): string => {
    const idx = fields.get(f);
    return idx === undefined ? '' : String(row[idx] ?? '').trim();
  };
  const roll = cell('roll_number');
  if (roll) return { key: roll.toUpperCase(), method: 'roll' };
  const email = cell('email');
  if (email) return { key: email.toLowerCase(), method: 'email' };
  const name = cell('full_name');
  return { key: name.toUpperCase(), method: 'name' };
}

/**
 * Pull Google Drive/Docs links out of a cell (a single URL or a list of them).
 * Only actual https drive URLs are returned — never fabricated.
 */
export function extractDriveLinks(raw: unknown): { label: string; url: string }[] {
  const text = String(raw ?? '');
  const matches = text.match(/https?:\/\/[^\s,;"'<>]+/g) ?? [];
  const seen = new Set<string>();
  const links: { label: string; url: string }[] = [];
  matches.forEach((url, i) => {
    const clean = url.replace(/[.,;)]+$/, '');
    if (seen.has(clean)) return;
    seen.add(clean);
    const isDrive = /drive\.google\.com|docs\.google\.com/i.test(clean);
    links.push({ label: `Task ${i + 1}`, url: clean, ...(isDrive ? {} : {}) });
  });
  return links;
}

/** Extract profile links (linkedin/github/other) from raw cells. */
export function extractProfileUrl(raw: unknown): string {
  const text = String(raw ?? '').trim();
  const m = text.match(/https?:\/\/[^\s,;"'<>]+/);
  if (m) return m[0].replace(/[.,;)]+$/, '');
  // A bare linkedin handle like "in/username" or "username" — build nothing,
  // only accept values that are clearly already URLs.
  return '';
}
