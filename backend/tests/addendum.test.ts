import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPanelCode } from '../src/lib/hash.js';
import { DEFAULT_CRITERIA, STAR_MAX, STAR_MIN } from '../src/lib/rubric.js';
import { parseWorkbook } from '../src/services/importer/parse.js';
import { MemoryStore } from '../src/store/memory.js';

const config = loadConfig({
  NODE_ENV: 'test',
  CODE_PEPPER: 'test-pepper',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  ADMIN_SECRET_CODE: 'super-secret-admin',
} as NodeJS.ProcessEnv);

function makeApp() {
  const store = new MemoryStore();
  const verifyToken = async (token: string) => (token.startsWith('user:') ? token.slice(5) : null);
  const app = createApp({ store, verifyToken, config });
  return { app, store };
}

const auth = (id: string) => ({ Authorization: `Bearer user:${id}` });

async function seedAdmin(store: MemoryStore): Promise<string> {
  const admin = await store.createProfile({
    id: randomUUID(),
    email: 'admin@test',
    full_name: 'Admin',
    role: 'admin',
  });
  return admin.id;
}

/** Build an in-memory workbook with per-vertical sheets. */
function buildWorkbook(sheets: Record<string, (string | number | null)[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const CONTENT_HEADER = [
  'Roll Number',
  'Applicant Name',
  'Email',
  'Branch',
  'Panel',
  'Shift',
  'Priority',
  'LinkedIn URL',
  'GitHub URL',
  'Team Message',
  'Remarks',
  'Drive Task Link',
];

function contentRows(): (string | number | null)[][] {
  return [
    CONTENT_HEADER,
    ['21BCS1001', 'Asha Rao', 'asha@example.com', 'CSE', 'Panel 1.1', 'Morning', 2, 'https://linkedin.com/in/asha', '', 'Hi', 'strong ref', 'https://drive.google.com/file/d/abc'],
    ['21BCS1002', 'Vikram Sen', 'vikram@example.com', 'IT', 'Panel 1.2', 'Morning', 5, '', '', '', '', ''],
    // duplicate roll inside the sheet — must be skipped by intra-file dedupe
    ['21BCS1001', 'Asha Rao Dup', 'asha2@example.com', 'CSE', 'Panel 1.1', 'Morning', 2, '', '', '', '', ''],
  ];
}

const DESIGN_HEADER = ['Application Id', 'Full Name', 'email id', 'department', 'team', 'time'];
const designRows = (): (string | number | null)[][] => [
  DESIGN_HEADER,
  ['APP-77', 'Meera Iyer', 'meera@example.com', 'ECE', 'Design', 'Evening'],
];

describe('workbook importer (parse)', () => {
  it('parses per-vertical sheets with their own headers and audits skipped sheets', () => {
    const buf = buildWorkbook({
      Content: contentRows(),
      Design: designRows(),
      'Fee Records': [['Receipt No', 'Amount'], ['R-1', 500]],
    });
    const report = parseWorkbook(buf, 'recruitment.xlsx');
    expect(report.sheets).toHaveLength(3);
    const content = report.sheets.find((s) => s.sheet === 'Content');
    expect(content?.usedAsSource).toBe(true);
    expect(content?.applicantRows).toBe(2); // third row is an intra-file duplicate
    const design = report.sheets.find((s) => s.sheet === 'Design');
    expect(design?.usedAsSource).toBe(true);
    const fees = report.sheets.find((s) => s.sheet === 'Fee Records');
    expect(fees?.usedAsSource).toBe(false);
    expect(fees?.reason).toMatch(/no applicant-name column/);
    expect(report.intraFileDuplicates).toBe(1);
    expect(report.applicants).toHaveLength(3);
  });

  it('preserves unknown columns in source_extra and extracts drive links', () => {
    const buf = buildWorkbook({ Content: contentRows() });
    const report = parseWorkbook(buf, 'wb.xlsx');
    const asha = report.applicants.find((a) => a.roll_number === '21BCS1001');
    expect(asha?.task_links).toEqual([
      { label: 'Task 1', url: 'https://drive.google.com/file/d/abc' },
    ]);
    expect(asha?.source_extra).toEqual({});
    expect(asha?.priority).toBe(2);
    expect(asha?.linkedin_url).toBe('https://linkedin.com/in/asha');
  });

  it('skips non-applicant sheets instead of erroring', () => {
    const buf = buildWorkbook({
      Content: contentRows(),
      Notes: [['todo', 'hire more']],
    });
    const report = parseWorkbook(buf, 'mixed.xlsx');
    expect(report.errors.filter((e) => e.sheet === 'Notes')).toHaveLength(0);
    expect(report.sheets.find((s) => s.sheet === 'Notes')?.usedAsSource).toBe(false);
  });
});

describe('import upsert (store)', () => {
  it('creates then updates without wiping existing fields', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const buf = buildWorkbook({ Content: contentRows() });
    const first = await request(app)
      .post('/api/admin/applicants/import')
      .set(auth(adminId))
      .attach('file', buf, 'recruitment.xlsx');
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(2);
    expect(first.body.updated).toBe(0);

    // Re-import with a sparse sheet (missing email column values) — emails kept.
    const sparse = buildWorkbook({
      Content: [CONTENT_HEADER, ['21BCS1001', 'Asha Rao Renamed', '', '', 'Panel 1.1', '', null, '', '', '', '', '']],
    });
    const second = await request(app)
      .post('/api/admin/applicants/import')
      .set(auth(adminId))
      .attach('file', sparse, 'recruitment.xlsx');
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(0);
    expect(second.body.updated).toBe(1);

    const { candidates } = (await request(app).get('/api/candidates?search=21BCS1001').set(auth(adminId))).body;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].full_name).toBe('Asha Rao Renamed');
    expect(candidates[0].email).toBe('asha@example.com');
    expect(candidates[0].roll_number).toBe('21BCS1001');
    expect(candidates[0].source_sheet).toBe('Content');
  });

  it('maps sheet names to seeded verticals', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    await store.createVertical({ key: 'content', name: 'Content Writing', worksheet: 'Content' });
    const buf = buildWorkbook({ Content: contentRows() });
    await request(app)
      .post('/api/admin/applicants/import')
      .set(auth(adminId))
      .attach('file', buf, 'wb.xlsx');
    const { candidates } = (await request(app).get('/api/candidates').set(auth(adminId))).body;
    const verticals = await store.listVerticals();
    expect(candidates[0].vertical_id).toBe(verticals[0].id);
  });

  it('rejects imports from non-admins', async () => {
    const { app, store } = makeApp();
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'J', role: 'judge' });
    const buf = buildWorkbook({ Content: contentRows() });
    const res = await request(app)
      .post('/api/admin/applicants/import')
      .set(auth(judge.id))
      .attach('file', buf, 'wb.xlsx');
    expect(res.status).toBe(403);
  });

  it('previews without writing', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const buf = buildWorkbook({ Content: contentRows() });
    const res = await request(app)
      .post('/api/admin/applicants/import/preview')
      .set(auth(adminId))
      .attach('file', buf, 'wb.xlsx');
    expect(res.status).toBe(200);
    // one row is an intra-file duplicate, so Content alone yields 2 applicants
    expect(res.body.applicant_count).toBe(2);
    expect((await store.listCandidates({ admin: true }, {}))).toHaveLength(0);
  });
});

describe('verticals', () => {
  it('seeds ten defaults and exposes them to authenticated users', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    await store.createVertical({ key: 'content', name: 'Content Writing' });
    // seed the remaining nine like the migration does
    for (const key of ['marketing', 'creatives', 'design', 'technical']) {
      await store.createVertical({ key, name: key });
    }
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'J', role: 'judge' });
    const res = await request(app).get('/api/verticals').set(auth(judge.id));
    expect(res.status).toBe(200);
    expect(res.body.verticals.length).toBe(5);
    expect(res.body.verticals[0].sort_order).toBeLessThanOrEqual(res.body.verticals[4].sort_order);
  });

  it('allows admins to create and patch verticals, judges cannot', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'J', role: 'judge' });
    const created = await request(app)
      .post('/api/verticals')
      .set(auth(adminId))
      .send({ key: 'sponsorship', name: 'Sponsorship', worksheet: 'Sponsorship' });
    expect(created.status).toBe(201);
    const patched = await request(app)
      .patch(`/api/verticals/${created.body.vertical.id}`)
      .set(auth(adminId))
      .send({ is_active: false });
    expect(patched.status).toBe(200);
    expect(patched.body.vertical.is_active).toBe(false);
    const denied = await request(app).post('/api/verticals').set(auth(judge.id)).send({ key: 'x', name: 'X' });
    expect(denied.status).toBe(403);
  });
});

describe('default rubric on round creation', () => {
  it('seeds the five 1–5 star criteria', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const res = await request(app)
      .post('/api/rounds')
      .set(auth(adminId))
      .send({ name: 'Addendum Round', is_open: true, allow_edit_after_submit: false });
    expect(res.status).toBe(201);
    const criteria = await store.listCriteria(res.body.round.id);
    expect(criteria).toHaveLength(DEFAULT_CRITERIA.length);
    expect(criteria.map((c) => c.name)).toEqual(DEFAULT_CRITERIA.map((c) => c.name));
    for (const c of criteria) {
      expect(c.min_score).toBe(STAR_MIN);
      expect(c.max_score).toBe(STAR_MAX);
      expect(c.weight).toBe(1);
      expect(c.is_active).toBe(true);
    }
  });

  it('skips seeding when asked', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const res = await request(app)
      .post('/api/rounds')
      .set(auth(adminId))
      .send({ name: 'Bare Round', seed_default_criteria: false });
    expect(res.status).toBe(201);
    expect(await store.listCriteria(res.body.round.id)).toHaveLength(0);
  });
});

describe('per-criterion feedback', () => {
  it('persists written feedback alongside each star rating', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'Judge', role: 'judge' });
    const panel = await store.createPanel({ name: 'P', expected_evaluations: 1 });
    await store.addPanelMember(panel.id, judge.id, adminId);
    const round = await request(app)
      .post('/api/rounds')
      .set(auth(adminId))
      .send({ name: 'Rubric Round' });
    const criteria = await store.listCriteria(round.body.round.id);
    const candidate = await store.createCandidate(
      { full_name: 'Test Person', branch: 'CSE', application_id: null, panel_id: panel.id },
      adminId,
    );
    const scores: Record<string, number> = {};
    const feedbacks: Record<string, string> = {};
    criteria.forEach((c, i) => {
      scores[c.id] = i + 1;
      feedbacks[c.id] = `note for ${c.name}`;
    });
    const res = await request(app)
      .post('/api/evaluations')
      .set(auth(judge.id))
      .send({
        id: randomUUID(),
        candidate_id: candidate.id,
        round_id: round.body.round.id,
        feedback: 'overall',
        scores,
        criterion_feedbacks: feedbacks,
      });
    expect(res.status).toBe(201);
    // equal weights: mean of 1..5 = 3
    expect(res.body.evaluation.overall_score).toBe(3);
    for (const s of res.body.evaluation.scores) {
      expect(s.feedback).toBe(`note for ${criteria.find((c) => c.id === s.criterion_id)?.name}`);
    }
  });
});

describe('admin secret code claim', () => {
  it('promotes a signed-in judge only when the code matches', async () => {
    const { app, store } = makeApp();
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'J', role: 'judge' });
    const other = await store.createProfile({ id: randomUUID(), email: 'o@test', full_name: 'O', role: 'judge' });

    const wrong = await request(app)
      .post('/api/admin/claim')
      .set(auth(judge.id))
      .send({ code: 'nope' });
    expect(wrong.status).toBe(401);
    expect((await store.getProfile(judge.id))!.role).toBe('judge');

    const ok = await request(app)
      .post('/api/admin/claim')
      .set(auth(judge.id))
      .send({ code: 'super-secret-admin' });
    expect(ok.status).toBe(200);
    expect((await store.getProfile(judge.id))!.role).toBe('admin');

    const again = await request(app)
      .post('/api/admin/claim')
      .set(auth(judge.id))
      .send({ code: 'super-secret-admin' });
    expect(again.status).toBe(200);
    expect(again.body.already_admin).toBe(true);

    const denied = await request(app)
      .post('/api/admin/claim')
      .set(auth(other.id))
      .send({ code: 'wrong' });
    expect(denied.status).toBe(401);
  });

  it('rate-limits repeated wrong attempts and rejects unauthenticated callers', async () => {
    const { app, store } = makeApp();
    const judge = await store.createProfile({ id: randomUUID(), email: 'r@test', full_name: 'R', role: 'judge' });
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const res = await request(app)
        .post('/api/admin/claim')
        .set(auth(judge.id))
        .send({ code: 'wrong' });
      last = res.status;
    }
    expect(last).toBe(429);
    const anon = await request(app).post('/api/admin/claim').send({ code: 'super-secret-admin' });
    expect(anon.status).toBe(401);
    expect((await store.getProfile(judge.id))!.role).toBe('judge');
  });
});

describe('registration completion (panel code gate)', () => {
  async function seedPanel(store: MemoryStore, code: string) {
    const panel = await store.createPanel({ name: `Panel ${code}`, expected_evaluations: 1 });
    await store.createPanelCode({
      panel_id: panel.id,
      code_hash: hashPanelCode(code, 'test-pepper'),
      label: 'permanent',
      preview: `${code.slice(0, 2)}${code.slice(-2)}`,
    });
    return panel;
  }

  it('valid panel code joins the judge to that panel', async () => {
    const { app, store } = makeApp();
    const panel = await seedPanel(store, 'PANECODE');
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'J', role: 'judge' });

    const res = await request(app)
      .post('/api/auth/complete-registration')
      .set(auth(judge.id))
      .send({ code: 'panecode' }); // lowercase — server normalizes
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('judge');
    expect(res.body.panel.id).toBe(panel.id);
    const mine = await store.listMyPanels(judge.id);
    expect(mine.map((p) => p.id)).toContain(panel.id);
    expect((await store.getProfile(judge.id))!.role).toBe('judge');
  });

  it('admin invite code promotes the account', async () => {
    const { app, store } = makeApp();
    const user = await store.createProfile({ id: randomUUID(), email: 'a@test', full_name: 'A', role: 'judge' });
    const res = await request(app)
      .post('/api/auth/complete-registration')
      .set(auth(user.id))
      .send({ code: 'super-secret-admin' });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect((await store.getProfile(user.id))!.role).toBe('admin');
  });

  it('invalid code destroys the account', async () => {
    const { app, store } = makeApp();
    await seedPanel(store, 'PANECODE');
    const judge = await store.createProfile({ id: randomUUID(), email: 'x@test', full_name: 'X', role: 'judge' });

    const res = await request(app)
      .post('/api/auth/complete-registration')
      .set(auth(judge.id))
      .send({ code: 'NOTREAL1' });
    expect(res.status).toBe(401);
    expect(await store.getProfile(judge.id)).toBeNull();

    const anon = await request(app).post('/api/auth/complete-registration').send({ code: 'PANECODE' });
    expect(anon.status).toBe(401);
  });
});

describe('spreadsheet sync queue', () => {
  it('coalesces pending items and claims with stale-lease recovery', async () => {
    const { store } = makeApp();
    const item = {
      direction: 'to_sheet' as const,
      entity_type: 'evaluation' as const,
      entity_id: randomUUID(),
      worksheet: 'Content',
      row_key: '21BCS1001',
      payload: { v: 1 },
    };
    await store.enqueueSpreadsheetSync(item);
    await store.enqueueSpreadsheetSync({ ...item, payload: { v: 2 } });
    const queued = await store.listSpreadsheetSync('pending');
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ v: 2 });

    const claimed = await store.claimSpreadsheetSync(10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('in_flight');
    // second claim of an in-flight row without lease expiry returns nothing
    expect(await store.claimSpreadsheetSync(10)).toHaveLength(0);

    await store.completeSpreadsheetSync(claimed[0].id, 'done', {});
    expect((await store.listSpreadsheetSync('done'))).toHaveLength(1);
  });

  it('re-arms a finished row and keeps retry attempts bounded', async () => {
    const { store } = makeApp();
    const item = {
      direction: 'to_sheet' as const,
      entity_type: 'evaluation' as const,
      entity_id: randomUUID(),
      worksheet: 'Content',
      row_key: '21BCS1002',
      payload: { v: 1 },
    };
    await store.enqueueSpreadsheetSync(item);
    const first = await store.claimSpreadsheetSync(10);
    await store.completeSpreadsheetSync(first[0].id, 'done', {});
    expect(await store.listSpreadsheetSync('pending')).toHaveLength(0);

    // A later evaluation for the same candidate must be pushed, not dropped
    // because the previous queue row is done.
    await store.enqueueSpreadsheetSync({ ...item, payload: { v: 2 } });
    const again = await store.listSpreadsheetSync('pending');
    expect(again).toHaveLength(1);
    expect(again[0].payload).toEqual({ v: 2 });

    const claimed = await store.claimSpreadsheetSync(10);
    await store.completeSpreadsheetSync(claimed[0].id, 'pending', {
      error: 'temporary',
      attempts: 2,
    });
    const retry = await store.listSpreadsheetSync('pending');
    expect(retry).toHaveLength(1);
    expect(retry[0].attempts).toBe(2);
    expect(retry[0].last_error).toBe('temporary');
  });

  it('evaluation submission enqueues a push when the vertical has a worksheet', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'J', role: 'judge' });
    const panel = await store.createPanel({ name: 'P', expected_evaluations: 1 });
    await store.addPanelMember(panel.id, judge.id, adminId);
    const vertical = await store.createVertical({ key: 'content', name: 'Content', worksheet: 'Content' });
    const round = await request(app).post('/api/rounds').set(auth(adminId)).send({ name: 'R' });
    const criteria = await store.listCriteria(round.body.round.id);
    const candidate = await store.createCandidate(
      { full_name: 'Cand', branch: 'CSE', application_id: null, panel_id: panel.id },
      adminId,
    );
    await store.updateCandidate(candidate.id, { vertical_id: vertical.id, roll_number: '21BCS9' });
    const scores: Record<string, number> = {};
    criteria.forEach((c) => (scores[c.id] = 4));
    const res = await request(app)
      .post('/api/evaluations')
      .set(auth(judge.id))
      .send({
        id: randomUUID(),
        candidate_id: candidate.id,
        round_id: round.body.round.id,
        feedback: '',
        scores,
      });
    expect(res.status).toBe(201);
    const queue = await store.listSpreadsheetSync('pending');
    expect(queue).toHaveLength(1);
    expect(queue[0].direction).toBe('to_sheet');
    expect(queue[0].worksheet).toBe('Content');
    expect(queue[0].row_key).toBe('21BCS9');
  });

  it('push without credentials fails queue items gracefully', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    await store.enqueueSpreadsheetSync({
      direction: 'to_sheet',
      entity_type: 'evaluation',
      entity_id: randomUUID(),
      worksheet: 'Content',
      row_key: 'X',
      payload: {},
    });
    const res = await request(app).post('/api/sheets/push').set(auth(adminId));
    expect(res.status).toBe(200);
    expect(res.body.connection_ok).toBe(false);
    expect(res.body.pushed[0].status).toBe('failed');
    expect((await store.listSpreadsheetSync('failed'))).toHaveLength(1);
  });
});

describe('reports', () => {
  it('exports all four types as CSV and xlsx', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'Judge', role: 'judge' });
    const panel = await store.createPanel({ name: 'P', expected_evaluations: 1 });
    await store.addPanelMember(panel.id, judge.id, adminId);
    const vertical = await store.createVertical({ key: 'content', name: 'Content Writing', worksheet: 'Content' });
    const round = await request(app).post('/api/rounds').set(auth(adminId)).send({ name: 'R' });
    const criteria = await store.listCriteria(round.body.round.id);
    const candidate = await store.createCandidate(
      { full_name: 'Export Me', branch: 'CSE', application_id: null, panel_id: panel.id },
      adminId,
    );
    await store.updateCandidate(candidate.id, { vertical_id: vertical.id });
    const scores: Record<string, number> = {};
    criteria.forEach((c) => (scores[c.id] = 5));
    await request(app)
      .post('/api/evaluations')
      .set(auth(judge.id))
      .send({
        id: randomUUID(),
        candidate_id: candidate.id,
        round_id: round.body.round.id,
        feedback: 'great',
        scores,
      });

    for (const type of ['summary', 'individual', 'criterion', 'vertical']) {
      const csv = await request(app).get(`/api/reports/export?type=${type}&format=csv`).set(auth(adminId));
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.split('\n').length).toBeGreaterThanOrEqual(2);
      const xlsx = await request(app).get(`/api/reports/export?type=${type}&format=xlsx`).set(auth(adminId));
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    }

    const bad = await request(app).get('/api/reports/export?type=nope').set(auth(adminId));
    expect(bad.status).toBe(400);

    const overview = await request(app).get('/api/reports/overview').set(auth(adminId));
    expect(overview.status).toBe(200);
    expect(overview.body.totals.applicants).toBe(1);
    expect(overview.body.by_vertical[0].avg_of_averages).toBe('5.00');
  });

  it('keeps reports admin-only', async () => {
    const { app, store } = makeApp();
    const judge = await store.createProfile({ id: randomUUID(), email: 'j@test', full_name: 'J', role: 'judge' });
    expect((await request(app).get('/api/reports/overview').set(auth(judge.id))).status).toBe(403);
    expect((await request(app).get('/api/reports/export').set(auth(judge.id))).status).toBe(403);
  });
});

describe('expanded candidate filters', () => {
  it('filters by vertical, shift and priority and sorts by priority/roll', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const panel = await store.createPanel({ name: 'P', expected_evaluations: 1 });
    const v = await store.createVertical({ key: 'content', name: 'Content' });
    const c1 = await store.createCandidate({ full_name: 'Zed', branch: 'CSE', application_id: null, panel_id: panel.id }, adminId);
    await store.updateCandidate(c1.id, { vertical_id: v.id, shift: 'morning', priority: 9, roll_number: '21' });
    const c2 = await store.createCandidate({ full_name: 'Ann', branch: 'ECE', application_id: null, panel_id: panel.id }, adminId);
    await store.updateCandidate(c2.id, { vertical_id: v.id, shift: 'evening', priority: 1, roll_number: '22' });

    const byShift = await request(app).get('/api/candidates?shift=morning').set(auth(adminId));
    expect(byShift.body.candidates.map((c: any) => c.full_name)).toEqual(['Zed']);
    const byPriority = await request(app).get('/api/candidates?sort=priority').set(auth(adminId));
    expect(byPriority.body.candidates.map((c: any) => c.full_name)).toEqual(['Ann', 'Zed']);
    const byRoll = await request(app).get('/api/candidates?sort=roll&order=desc').set(auth(adminId));
    expect(byRoll.body.candidates.map((c: any) => c.roll_number)).toEqual(['22', '21']);
    const byVertical = await request(app).get(`/api/candidates?verticalId=${v.id}`).set(auth(adminId));
    expect(byVertical.body.candidates).toHaveLength(2);
  });
});

describe('provisional vs complete results', () => {
  it('flags provisional results until the expected panel count is reached', async () => {
    const { app, store } = makeApp();
    const adminId = await seedAdmin(store);
    const j1 = await store.createProfile({ id: randomUUID(), email: 'j1@test', full_name: 'J1', role: 'judge' });
    const j2 = await store.createProfile({ id: randomUUID(), email: 'j2@test', full_name: 'J2', role: 'judge' });
    const panel = await store.createPanel({ name: 'P', expected_evaluations: 2 });
    await store.addPanelMember(panel.id, j1.id, adminId);
    await store.addPanelMember(panel.id, j2.id, adminId);
    const round = await request(app).post('/api/rounds').set(auth(adminId)).send({ name: 'R' });
    const criteria = await store.listCriteria(round.body.round.id);
    const candidate = await store.createCandidate({ full_name: 'C', branch: 'CSE', application_id: null, panel_id: panel.id }, adminId);

    const scoresFor = (n: number) => {
      const s: Record<string, number> = {};
      criteria.forEach((c) => (s[c.id] = n));
      return s;
    };
    await request(app)
      .post('/api/evaluations')
      .set(auth(j1.id))
      .send({ id: randomUUID(), candidate_id: candidate.id, round_id: round.body.round.id, feedback: '', scores: scoresFor(3) });
    let rows = (await request(app).get('/api/results').set(auth(adminId))).body.results;
    expect(rows[0].evaluation_status).toBe('in_progress');
    expect(rows[0].is_provisional).toBe(true);
    expect(rows[0].average_score).toBe(3);

    await request(app)
      .post('/api/evaluations')
      .set(auth(j2.id))
      .send({ id: randomUUID(), candidate_id: candidate.id, round_id: round.body.round.id, feedback: '', scores: scoresFor(5) });
    rows = (await request(app).get('/api/results').set(auth(adminId))).body.results;
    expect(rows[0].evaluation_status).toBe('complete');
    expect(rows[0].is_provisional).toBe(false);
    // final = mean of individual scores (3 + 5) / 2 = 4, displayed 2dp
    expect(rows[0].average_score).toBe(4);
    expect(rows[0].judge_ratings).toHaveLength(2);
  });
});

describe('bootstrap', () => {
  it('health endpoint still responds', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

beforeEach(() => {
  // each test builds its own store; nothing shared
});
