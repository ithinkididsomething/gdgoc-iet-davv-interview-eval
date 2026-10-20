import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { hashPanelCode } from '../src/lib/hash.js';
import { MemoryStore } from '../src/store/memory.js';

const config = loadConfig({
  NODE_ENV: 'test',
  CODE_PEPPER: 'test-pepper',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
} as NodeJS.ProcessEnv);

function makeApp() {
  const store = new MemoryStore();
  const verifyToken = async (token: string) => (token.startsWith('user:') ? token.slice(5) : null);
  const app = createApp({ store, verifyToken, config });
  return { app, store };
}

const auth = (id: string) => ({ Authorization: `Bearer user:${id}` });

interface Seed {
  adminId: string;
  judge1Id: string;
  judge2Id: string;
  panelId: string;
  otherPanelId: string;
  roundId: string;
  freeRoundId: string;
  criteriaIds: string[];
  candidateId: string;
}

async function seed(store: MemoryStore, editPolicy = false): Promise<Seed> {
  const admin = await store.createProfile({ id: randomUUID(), email: 'admin@test', full_name: 'Admin', role: 'admin' });
  const judge1 = await store.createProfile({ id: randomUUID(), email: 'j1@test', full_name: 'Judge One', role: 'judge' });
  const judge2 = await store.createProfile({ id: randomUUID(), email: 'j2@test', full_name: 'Judge Two', role: 'judge' });
  const panel = await store.createPanel({ name: 'Panel A', expected_evaluations: 2 });
  const otherPanel = await store.createPanel({ name: 'Panel B', expected_evaluations: 1 });
  await store.createPanelCode({
    panel_id: panel.id,
    code_hash: hashPanelCode('PANELCODE', 'test-pepper'),
    label: 'primary',
    preview: 'PA••••DE',
  });
  const round = await store.createRound({
    name: 'Round 1',
    is_open: true,
    allow_edit_after_submit: editPolicy,
    closes_at: null,
  });
  const freeRound = await store.createRound({
    name: 'Free Round',
    is_open: true,
    allow_edit_after_submit: false,
    closes_at: null,
  });
  const c1 = await store.createCriterion({
    round_id: round.id,
    name: 'Technical',
    description: '',
    min_score: 1,
    max_score: 10,
    weight: 1,
    sort_order: 0,
    is_active: true,
  });
  const c2 = await store.createCriterion({
    round_id: round.id,
    name: 'Communication',
    description: '',
    min_score: 1,
    max_score: 10,
    weight: 1,
    sort_order: 1,
    is_active: true,
  });
  const candidate = await store.createCandidate(
    { full_name: 'Ada Lovelace', branch: 'CSE', application_id: 'APP-1', panel_id: panel.id },
    admin.id,
  );
  return {
    adminId: admin.id,
    judge1Id: judge1.id,
    judge2Id: judge2.id,
    panelId: panel.id,
    otherPanelId: otherPanel.id,
    roundId: round.id,
    freeRoundId: freeRound.id,
    criteriaIds: [c1.id, c2.id],
    candidateId: candidate.id,
  };
}

describe('auth and roles', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('resolves role from the database, not the client', async () => {
    const res = await request(app).get('/api/me').set(auth(s.judge1Id));
    expect(res.status).toBe(200);
    expect(res.body.profile.role).toBe('judge');
    expect(res.body.is_admin).toBe(false);
  });

  it('forbids judges from admin endpoints', async () => {
    const res = await request(app).get('/api/panels').set(auth(s.judge1Id));
    expect(res.status).toBe(403);
    const users = await request(app).get('/api/admin/users').set(auth(s.judge1Id));
    expect(users.status).toBe(403);
  });

  it('lets an admin permanently delete a panel with its candidates, codes and members', async () => {
    await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: 'PANELCODE' });
    const forbidden = await request(app).delete(`/api/panels/${s.panelId}`).set(auth(s.judge1Id));
    expect(forbidden.status).toBe(403);

    const res = await request(app).delete(`/api/panels/${s.panelId}`).set(auth(s.adminId));
    expect(res.status).toBe(200);
    expect(await store.getPanel(s.panelId)).toBeNull();
    expect(await store.getCandidate(s.candidateId, { admin: true })).toBeNull();
    expect((await store.listPanelCodes(s.panelId)).length).toBe(0);
    expect((await store.listPanelMembers(s.panelId)).length).toBe(0);
    expect((await store.listMyPanels(s.judge1Id)).some((p) => p.id === s.panelId)).toBe(false);

    const again = await request(app).delete(`/api/panels/${s.panelId}`).set(auth(s.adminId));
    expect(again.status).toBe(404);
  });

  it('lets an admin change roles but not demote the last admin', async () => {
    const promote = await request(app)
      .patch(`/api/admin/users/${s.judge1Id}/role`)
      .set(auth(s.adminId))
      .send({ role: 'admin' });
    expect(promote.status).toBe(200);
    // Two admins now; demoting one is fine
    const demote = await request(app)
      .patch(`/api/admin/users/${s.judge1Id}/role`)
      .set(auth(s.adminId))
      .send({ role: 'judge' });
    expect(demote.status).toBe(200);
    // Demote self (the last admin) → blocked
    const self = await request(app)
      .patch(`/api/admin/users/${s.adminId}/role`)
      .set(auth(s.adminId))
      .send({ role: 'judge' });
    expect(self.status).toBe(409);
  });
});

describe('panel verification', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
  });

  it('verifies a correct code and grants panel access', async () => {
    const res = await request(app)
      .post('/api/panels/verify')
      .set(auth(s.judge1Id))
      .send({ code: 'PANELCODE' });
    expect(res.status).toBe(200);
    expect(res.body.panel.id).toBe(s.panelId);
    const mine = await store.listMyPanels(s.judge1Id);
    expect(mine.map((p) => p.id)).toContain(s.panelId);
  });

  it('rejects an incorrect code', async () => {
    const res = await request(app)
      .post('/api/panels/verify')
      .set(auth(s.judge1Id))
      .send({ code: 'WRONGCODE' });
    expect(res.status).toBe(401);
  });

  it('rate-limits a judge who keeps failing', async () => {
    for (let i = 0; i < 8; i += 1) {
      await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: `BAD${i}` });
    }
    const res = await request(app)
      .post('/api/panels/verify')
      .set(auth(s.judge1Id))
      .send({ code: 'PANELCODE' });
    expect(res.status).toBe(429);
  });

  it('locks a code after repeated failed attempts against an inactive panel', async () => {
    await store.updatePanel(s.panelId, { is_active: false });
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app)
        .post('/api/panels/verify')
        .set(auth(s.judge1Id))
        .send({ code: 'PANELCODE' });
      expect(res.status).toBe(403); // panel_inactive
    }
    const locked = await request(app)
      .post('/api/panels/verify')
      .set(auth(s.judge1Id))
      .send({ code: 'PANELCODE' });
    expect(locked.status).toBe(429);
    expect(locked.body.status).toBe('locked');
  });

  it('rotation invalidates the old code and accepts the new one', async () => {
    const rotate = await request(app)
      .post(`/api/panels/${s.panelId}/codes/rotate`)
      .set(auth(s.adminId))
      .send({ label: 'rotated' });
    expect(rotate.status).toBe(201);
    const newCode = rotate.body.plaintext_code as string;
    const old = await request(app)
      .post('/api/panels/verify')
      .set(auth(s.judge1Id))
      .send({ code: 'PANELCODE' });
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post('/api/panels/verify')
      .set(auth(s.judge1Id))
      .send({ code: newCode });
    expect(fresh.status).toBe(200);
  });

  it('never returns the code hash or plaintext in code listings', async () => {
    const res = await request(app).get(`/api/panels/${s.panelId}/codes`).set(auth(s.adminId));
    expect(res.status).toBe(200);
    const code = res.body.codes[0];
    expect(code.code_hash).toBeUndefined();
    expect(code.code_preview).toBeTruthy();
  });
});

describe('candidates, search and import', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
    await store.createCandidate(
      { full_name: 'Grace Hopper', branch: 'ECE', application_id: 'APP-2', panel_id: s.panelId },
      s.adminId,
    );
    await store.createCandidate(
      { full_name: 'Alan Turing', branch: 'CSE', application_id: 'APP-3', panel_id: s.otherPanelId },
      s.adminId,
    );
  });

  it('judges only see candidates on their verified panels', async () => {
    await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: 'PANELCODE' });
    const res = await request(app).get('/api/candidates').set(auth(s.judge1Id));
    expect(res.status).toBe(200);
    const names = res.body.candidates.map((c: any) => c.full_name).sort();
    expect(names).toEqual(['Ada Lovelace', 'Grace Hopper']);
  });

  it('searches by name and filters by branch, with sorting', async () => {
    const byName = await request(app).get('/api/candidates?search=ada').set(auth(s.adminId));
    expect(byName.body.candidates).toHaveLength(1);
    expect(byName.body.candidates[0].full_name).toBe('Ada Lovelace');

    const byBranch = await request(app).get('/api/candidates?branch=ECE').set(auth(s.adminId));
    expect(byBranch.body.candidates.map((c: any) => c.full_name)).toEqual(['Grace Hopper']);

    const sorted = await request(app)
      .get('/api/candidates?sort=name&order=desc')
      .set(auth(s.adminId));
    expect(sorted.body.candidates[0].full_name).toBe('Grace Hopper');
    expect(sorted.body.candidates[2].full_name).toBe('Ada Lovelace');
  });

  it('judges cannot read admin-only notes', async () => {
    await store.updateCandidate(s.candidateId, { notes: 'secret admin note' });
    await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: 'PANELCODE' });
    const res = await request(app).get(`/api/candidates/${s.candidateId}`).set(auth(s.judge1Id));
    expect(res.status).toBe(200);
    expect(res.body.candidate.notes).toBe('');
    const adminRes = await request(app).get(`/api/candidates/${s.candidateId}`).set(auth(s.adminId));
    expect(adminRes.body.candidate.notes).toBe('secret admin note');
  });

  it('imports CSV with validation, duplicate skipping and row errors', async () => {
    const csv = [
      'full_name,branch,application_id,panel',
      'Katherine Johnson,Maths,APP-4,Panel A',
      'Radia Perlman,Networks,APP-2,Panel A', // duplicate application_id
      ',CSE,APP-5,Panel A', // missing name
      'X Y,ECE,APP-6,NoSuchPanel', // bad panel
    ].join('\n');
    const res = await request(app)
      .post('/api/candidates/import')
      .set(auth(s.adminId))
      .send({ csv });
    expect(res.status).toBe(200);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped_duplicates).toBe(1);
    expect(res.body.errors).toHaveLength(2);
  });

  it('blocks duplicate application_id on single create', async () => {
    const res = await request(app)
      .post('/api/candidates')
      .set(auth(s.adminId))
      .send({ full_name: 'Dup', branch: 'CSE', application_id: 'APP-1', panel_id: s.panelId });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('duplicate_application_id');
  });
});

describe('evaluations, averages and duplicates', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
    await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: 'PANELCODE' });
    await request(app).post('/api/panels/verify').set(auth(s.judge2Id)).send({ code: 'PANELCODE' });
    // Give judge2 membership on panel as well (verify already did) — also admin-assigned third judge
    await store.createProfile({ id: randomUUID(), email: 'j3@test', full_name: 'Judge Three', role: 'judge' });
  });

  const submit = (judgeId: string, scores: Record<string, number>, id = randomUUID(), extra: any = {}) =>
    request(app)
      .post('/api/evaluations')
      .set(auth(judgeId))
      .send({
        id,
        candidate_id: s.candidateId,
        round_id: s.roundId,
        feedback: 'Strong answers',
        scores,
        ...extra,
      });

  it('computes the overall score from criterion scores server-side', async () => {
    const res = await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    expect(res.status).toBe(201);
    expect(res.body.evaluation.overall_score).toBe(7);
  });

  it('stores the preferred vertical chosen during the interview', async () => {
    const preferred = randomUUID();
    const res = await submit(
      s.judge1Id,
      { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 },
      randomUUID(),
      { preferred_vertical_id: preferred },
    );
    expect(res.status).toBe(201);
    expect(res.body.evaluation.preferred_vertical_id).toBe(preferred);
    const mine = await request(app).get('/api/evaluations/mine').set(auth(s.judge1Id));
    const row = mine.body.evaluations.find((e: any) => e.id === res.body.evaluation.id);
    expect(row.preferred_vertical_id).toBe(preferred);
  });

  it('rejects out-of-range scores', async () => {
    const res = await submit(s.judge1Id, { [s.criteriaIds[0]]: 99, [s.criteriaIds[1]]: 5 });
    expect(res.status).toBe(400);
    expect(res.body.details).toBeTruthy();
  });

  it('prevents duplicate official evaluations from the same judge', async () => {
    const first = await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    expect(first.status).toBe(201);
    const second = await submit(s.judge1Id, { [s.criteriaIds[0]]: 5, [s.criteriaIds[1]]: 5 });
    expect(second.status).toBe(409);
    expect(second.body.status).toBe('duplicate');
  });

  it('is idempotent for the same client-generated evaluation id', async () => {
    const id = randomUUID();
    const scores = { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 };
    const first = await submit(s.judge1Id, scores, id);
    expect(first.status).toBe(201);
    const retry = await submit(s.judge1Id, scores, id);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    const official = await store.getOfficialEvaluation(s.judge1Id, s.candidateId, s.roundId);
    expect(official?.id).toBe(id);
  });

  it('averages only submitted evaluations across judges (never zeros)', async () => {
    // Five judges submit 8, 7, 9, 6, 10 on single-score round → average 8.0
    const judges: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const p = await store.createProfile({
        id: randomUUID(),
        email: `avg${i}@test`,
        full_name: `Avg Judge ${i}`,
        role: 'judge',
      });
      judges.push(p.id);
      await store.addPanelMember(s.panelId, p.id, s.adminId);
    }
    const round = await store.getRound(s.freeRoundId);
    expect(round).toBeTruthy();
    const scores = [8, 7, 9, 6, 10];
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post('/api/evaluations')
        .set(auth(judges[i]))
        .send({
          id: randomUUID(),
          candidate_id: s.candidateId,
          round_id: s.freeRoundId,
          overall_score: scores[i],
          scores: {},
        });
      expect(res.status).toBe(201);
    }
    const results = await request(app).get('/api/results').set(auth(s.adminId));
    const row = results.body.results.find((r: any) => r.candidate_id === s.candidateId);
    // Average of free-round evaluations
    expect(row.average_score).toBe(8);
    expect(row.evaluation_count).toBe(5);
  });

  it('marks candidates with partial evaluations as in_progress', async () => {
    await store.updatePanel(s.panelId, { expected_evaluations: 2 });
    await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 8 });
    const results = await request(app).get('/api/results').set(auth(s.adminId));
    const row = results.body.results.find((r: any) => r.candidate_id === s.candidateId);
    expect(row.evaluation_count).toBe(1);
    expect(row.expected_evaluations).toBe(2);
    expect(row.evaluation_status).toBe('in_progress');
    expect(row.average_score).toBe(8); // only the one real score, missing not zero
  });

  it('does not allow edits when the round policy forbids them', async () => {
    const created = await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    const evalId = created.body.evaluation.id;
    const patch = await request(app)
      .patch(`/api/evaluations/${evalId}`)
      .set(auth(s.judge1Id))
      .send({ feedback: 'updated', scores: { [s.criteriaIds[0]]: 5, [s.criteriaIds[1]]: 5 } });
    expect(patch.status).toBe(409);
  });

  it('allows edits and bumps version when the round policy permits', async () => {
    await store.updateRound(s.roundId, { allow_edit_after_submit: true });
    const created = await request(app)
      .post('/api/evaluations')
      .set(auth(s.judge1Id))
      .send({
        id: randomUUID(),
        candidate_id: s.candidateId,
        round_id: s.roundId,
        scores: { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 },
        feedback: 'v1',
      });
    expect(created.status).toBe(201);
    const evalId = created.body.evaluation.id;
    const patch = await request(app)
      .patch(`/api/evaluations/${evalId}`)
      .set(auth(s.judge1Id))
      .send({ feedback: 'v2', scores: { [s.criteriaIds[0]]: 10, [s.criteriaIds[1]]: 10 } });
    expect(patch.status).toBe(200);
    expect(patch.body.evaluation.version).toBe(2);
    expect(patch.body.evaluation.overall_score).toBe(10);
    const audits = store.audits.filter((a) => a.action === 'evaluation_updated');
    expect(audits.length).toBe(1);
  });

  it('never lets a judge modify another judge’s evaluation', async () => {
    const created = await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    const evalId = created.body.evaluation.id;
    const patch = await request(app)
      .patch(`/api/evaluations/${evalId}`)
      .set(auth(s.judge2Id))
      .send({ feedback: 'hacked', scores: { [s.criteriaIds[0]]: 1, [s.criteriaIds[1]]: 1 } });
    expect(patch.status).toBe(403);
  });

  it('lets a judge delete their own evaluation and submit again', async () => {
    const created = await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    expect(created.status).toBe(201);
    const evalId = created.body.evaluation.id;
    const deleted = await request(app).delete(`/api/evaluations/${evalId}`).set(auth(s.judge1Id));
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    expect(await store.getEvaluation(evalId)).toBeNull();
    expect(await store.getOfficialEvaluation(s.judge1Id, s.candidateId, s.roundId)).toBeNull();
    expect(store.audits.some((a) => a.action === 'evaluation_deleted' && a.entity_id === evalId)).toBe(true);

    const again = await submit(s.judge1Id, { [s.criteriaIds[0]]: 9, [s.criteriaIds[1]]: 9 });
    expect(again.status).toBe(201);
  });

  it('does not let a judge delete another judge evaluation', async () => {
    const created = await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    const evalId = created.body.evaluation.id;
    const deleted = await request(app).delete(`/api/evaluations/${evalId}`).set(auth(s.judge2Id));
    expect(deleted.status).toBe(403);
    expect(await store.getEvaluation(evalId)).not.toBeNull();
  });

  it('lets an admin delete any evaluation', async () => {
    const created = await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    const evalId = created.body.evaluation.id;
    const deleted = await request(app).delete(`/api/evaluations/${evalId}`).set(auth(s.adminId));
    expect(deleted.status).toBe(200);
    expect(await store.getEvaluation(evalId)).toBeNull();
  });

  it('rejects submissions from judges without panel membership', async () => {
    const outsider = await store.createProfile({
      id: randomUUID(),
      email: 'outsider@test',
      full_name: 'Outsider',
      role: 'judge',
    });
    const res = await request(app)
      .post('/api/evaluations')
      .set(auth(outsider.id))
      .send({
        id: randomUUID(),
        candidate_id: s.candidateId,
        round_id: s.roundId,
        scores: { [s.criteriaIds[0]]: 5, [s.criteriaIds[1]]: 5 },
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not assigned/i);
  });

  it('rejects submissions after panel access is revoked', async () => {
    await store.removePanelMember(s.panelId, s.judge2Id);
    const res = await request(app)
      .post('/api/evaluations')
      .set(auth(s.judge2Id))
      .send({
        id: randomUUID(),
        candidate_id: s.candidateId,
        round_id: s.roundId,
        scores: { [s.criteriaIds[0]]: 5, [s.criteriaIds[1]]: 5 },
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not assigned/i);
  });

  it('does not expose other judges’ evaluation lists to a scoped judge', async () => {
    await submit(s.judge1Id, { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 6 });
    const res = await request(app).get('/api/evaluations/mine').set(auth(s.judge2Id));
    expect(res.status).toBe(200);
    expect(res.body.evaluations).toHaveLength(0);
  });
});

describe('synchronization', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
    await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: 'PANELCODE' });
  });

  const syncItem = (id: string, extra: any = {}) => ({
    id,
    candidate_id: s.candidateId,
    round_id: s.roundId,
    feedback: 'offline eval',
    scores: { [s.criteriaIds[0]]: 9, [s.criteriaIds[1]]: 7 },
    ...extra,
  });

  it('accepts a batch and reports per-item results', async () => {
    const id = randomUUID();
    const res = await request(app)
      .post('/api/sync/evaluations')
      .set(auth(s.judge1Id))
      .send({ evaluations: [syncItem(id)] });
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('ok');
    const official = await store.getOfficialEvaluation(s.judge1Id, s.candidateId, s.roundId);
    expect(official?.id).toBe(id);
  });

  it('re-sending the same batch does not create duplicates', async () => {
    const id = randomUUID();
    const payload = { evaluations: [syncItem(id)] };
    const first = await request(app).post('/api/sync/evaluations').set(auth(s.judge1Id)).send(payload);
    expect(first.body.results[0].status).toBe('ok');
    const second = await request(app).post('/api/sync/evaluations').set(auth(s.judge1Id)).send(payload);
    expect(second.body.results[0].status).toBe('ok');
    expect(second.body.results[0].idempotent).toBe(true);
    const all = await store.listEvaluations({ admin: true, judgeId: s.judge1Id });
    expect(all).toHaveLength(1);
  });

  it('handles partial failure without losing successful items', async () => {
    const goodId = randomUUID();
    const badScores = syncItem(randomUUID(), { scores: { [s.criteriaIds[0]]: 99, [s.criteriaIds[1]]: 7 } });
    const res = await request(app)
      .post('/api/sync/evaluations')
      .set(auth(s.judge1Id))
      .send({ evaluations: [syncItem(goodId), badScores] });
    expect(res.body.results[0].status).toBe('ok');
    expect(res.body.results[1].status).toBe('error');
    const official = await store.getOfficialEvaluation(s.judge1Id, s.candidateId, s.roundId);
    expect(official?.id).toBe(goodId);
  });

  it('reports a conflict when an official evaluation already exists', async () => {
    await request(app)
      .post('/api/evaluations')
      .set(auth(s.judge1Id))
      .send(syncItem(randomUUID()));
    const res = await request(app)
      .post('/api/sync/evaluations')
      .set(auth(s.judge1Id))
      .send({ evaluations: [syncItem(randomUUID(), { replace_existing: false })] });
    expect(res.body.results[0].status).toBe('conflict');
    expect(res.body.results[0].existing).toBeTruthy();
  });

  it('replaces an existing evaluation through sync when the round allows edits', async () => {
    await store.updateRound(s.roundId, { allow_edit_after_submit: true });
    const evalId = randomUUID();
    await request(app)
      .post('/api/sync/evaluations')
      .set(auth(s.judge1Id))
      .send({ evaluations: [syncItem(evalId)] });
    const res = await request(app)
      .post('/api/sync/evaluations')
      .set(auth(s.judge1Id))
      .send({
        evaluations: [
          syncItem(evalId, { scores: { [s.criteriaIds[0]]: 10, [s.criteriaIds[1]]: 10 } }),
        ],
      });
    expect(res.body.results[0].status).toBe('ok');
    const official = await store.getOfficialEvaluation(s.judge1Id, s.candidateId, s.roundId);
    expect(official?.version).toBe(2);
    expect(official?.overall_score).toBe(10);
  });

  it('rejects sync for judges whose panel access was revoked', async () => {
    await store.removePanelMember(s.panelId, s.judge1Id);
    const res = await request(app)
      .post('/api/sync/evaluations')
      .set(auth(s.judge1Id))
      .send({ evaluations: [syncItem(randomUUID())] });
    expect(res.body.results[0].status).toBe('error');
  });

  it('exposes a lightweight status endpoint for connectivity checks', async () => {
    const res = await request(app).get('/api/sync/status').set(auth(s.judge1Id));
    expect(res.status).toBe(200);
    expect(res.body.server_time).toBeTruthy();
  });
});

describe('admin candidate profile', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
    await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: 'PANELCODE' });
  });

  it('returns the full admin profile with every judge evaluation and criterion', async () => {
    await request(app)
      .post('/api/evaluations')
      .set(auth(s.judge1Id))
      .send({
        id: randomUUID(),
        candidate_id: s.candidateId,
        round_id: s.roundId,
        feedback: 'Strong technical signal',
        scores: { [s.criteriaIds[0]]: 9, [s.criteriaIds[1]]: 8 },
      });
    const res = await request(app)
      .get(`/api/admin/candidates/${s.candidateId}/profile`)
      .set(auth(s.adminId));
    expect(res.status).toBe(200);
    expect(res.body.candidate.full_name).toBe('Ada Lovelace');
    expect(res.body.panel.name).toBe('Panel A');
    expect(res.body.panel_members[0].judge_name).toBe('Judge One');
    expect(res.body.result.evaluation_count).toBe(1);
    expect(res.body.evaluations).toHaveLength(1);
    expect(res.body.evaluations[0].judge_name).toBe('Judge One');
    expect(res.body.evaluations[0].feedback).toBe('Strong technical signal');
    expect(res.body.evaluations[0].scores).toHaveLength(2);
    expect(res.body.evaluations[0].scores[0].criterion_name).toBe('Technical');
    expect(res.body.evaluations[0].scores[0].max_score).toBe(10);
  });

  it('forbids judges from the admin profile endpoint', async () => {
    const res = await request(app)
      .get(`/api/admin/candidates/${s.candidateId}/profile`)
      .set(auth(s.judge1Id));
    expect(res.status).toBe(403);
  });
});

describe('exports', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
    await request(app).post('/api/panels/verify').set(auth(s.judge1Id)).send({ code: 'PANELCODE' });
    await request(app)
      .post('/api/evaluations')
      .set(auth(s.judge1Id))
      .send({
        id: randomUUID(),
        candidate_id: s.candidateId,
        round_id: s.roundId,
        feedback: 'Excellent problem solving',
        scores: { [s.criteriaIds[0]]: 9, [s.criteriaIds[1]]: 7 },
      });
  });

  it('admin exports a summary CSV with averages and counts', async () => {
    const res = await request(app).get('/api/export/summary.csv').set(auth(s.adminId));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain('full_name');
    expect(res.text).toContain('Ada Lovelace');
    expect(res.text).toContain('8'); // average of 9 and 7
  });

  it('admin export includes an explicit NO EVALUATIONS marker, not a zero', async () => {
    await store.createCandidate(
      { full_name: 'No Show', branch: 'CSE', application_id: null, panel_id: s.otherPanelId },
      s.adminId,
    );
    const res = await request(app).get('/api/export/summary.csv').set(auth(s.adminId));
    expect(res.text).toContain('No Show');
    expect(res.text).toMatch(/No Show[^\r\n]*\r\n/);
    const line = res.text.split('\r\n').find((l) => l.includes('No Show'))!;
    // average column empty, count 0
    expect(line).toMatch(/,,0,/);
  });

  it('detailed export contains individual ratings and written feedback', async () => {
    const res = await request(app).get('/api/export/detailed.csv').set(auth(s.adminId));
    expect(res.status).toBe(200);
    expect(res.text).toContain('Excellent problem solving');
    expect(res.text).toContain('Judge One');
    expect(res.text).toContain('Technical=9');
  });

  it('judges cannot export', async () => {
    const res = await request(app).get('/api/export/summary.csv').set(auth(s.judge1Id));
    expect(res.status).toBe(403);
  });
});

describe('round creation', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
  });

  it('does not leak request-only fields (seed_default_criteria) into the store', async () => {
    const captured: unknown[] = [];
    const real = store.createRound.bind(store);
    store.createRound = (input: Parameters<MemoryStore['createRound']>[0]) => {
      captured.push(input);
      return real(input);
    };

    const res = await request(app).post('/api/rounds').set(auth(s.adminId)).send({ name: 'New Round' });
    expect(res.status).toBe(201);
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty('seed_default_criteria');
  });

  it('seeds the default criteria for a new round', async () => {
    const res = await request(app).post('/api/rounds').set(auth(s.adminId)).send({ name: 'Seeded Round' });
    expect(res.status).toBe(201);
    const criteria = await store.listCriteria(res.body.round.id);
    expect(criteria.length).toBeGreaterThan(0);
  });

  it('rejects round creation by a judge', async () => {
    const res = await request(app).post('/api/rounds').set(auth(s.judge1Id)).send({ name: 'Nope' });
    expect(res.status).toBe(403);
  });
});

describe('round deletion', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
  });

  it('deletes a round and its criteria when it has no evaluations', async () => {
    const res = await request(app).delete(`/api/rounds/${s.freeRoundId}`).set(auth(s.adminId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, evaluations: 0 });
    expect(await store.getRound(s.freeRoundId)).toBeNull();
    expect(await store.listCriteria(s.freeRoundId)).toHaveLength(0);
  });

  it('refuses to delete an evaluated round unless forced', async () => {
    await store.addPanelMember(s.panelId, s.judge1Id, s.adminId);
    const evaluation = await request(app)
      .post('/api/evaluations')
      .set(auth(s.judge1Id))
      .send({
        id: randomUUID(),
        candidate_id: s.candidateId,
        round_id: s.roundId,
        feedback: 'Solid',
        scores: { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 7 },
      });
    expect(evaluation.status).toBe(201);

    const blocked = await request(app).delete(`/api/rounds/${s.roundId}`).set(auth(s.adminId));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('round_has_evaluations');
    expect(await store.getRound(s.roundId)).not.toBeNull();

    const forced = await request(app)
      .delete(`/api/rounds/${s.roundId}?force=true`)
      .set(auth(s.adminId));
    expect(forced.status).toBe(200);
    expect(forced.body.evaluations).toBe(1);
    expect(await store.getRound(s.roundId)).toBeNull();
  });

  it('rejects deletion by a judge', async () => {
    const res = await request(app).delete(`/api/rounds/${s.freeRoundId}`).set(auth(s.judge1Id));
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown round', async () => {
    const res = await request(app).delete(`/api/rounds/${randomUUID()}`).set(auth(s.adminId));
    expect(res.status).toBe(404);
  });
});

describe('criterion updates', () => {
  let app: ReturnType<typeof makeApp>['app'];
  let store: MemoryStore;
  let s: Seed;
  beforeEach(async () => {
    ({ app, store } = makeApp());
    s = await seed(store);
  });

  it('toggles a criterion on and off', async () => {
    const off = await request(app)
      .patch(`/api/criteria/${s.criteriaIds[0]}`)
      .set(auth(s.adminId))
      .send({ is_active: false });
    expect(off.status).toBe(200);
    expect(off.body.criterion.is_active).toBe(false);

    const on = await request(app)
      .patch(`/api/criteria/${s.criteriaIds[0]}`)
      .set(auth(s.adminId))
      .send({ is_active: true });
    expect(on.status).toBe(200);
    expect(on.body.criterion.is_active).toBe(true);
  });

  it('creates a criterion with a description', async () => {
    const res = await request(app)
      .post(`/api/rounds/${s.roundId}/criteria`)
      .set(auth(s.adminId))
      .send({ name: 'Ownership', description: 'Takes charge of their work', max_score: 5 });
    expect(res.status).toBe(201);
    expect(res.body.criterion.description).toBe('Takes charge of their work');
  });

  it('deletes an unused criterion', async () => {
    const res = await request(app).delete(`/api/criteria/${s.criteriaIds[0]}`).set(auth(s.adminId));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, scores: 0 });
    const remaining = await store.listCriteria(s.roundId);
    expect(remaining.map((c) => c.id)).toEqual([s.criteriaIds[1]]);
  });

  it('refuses to delete a scored criterion unless forced', async () => {
    await store.addPanelMember(s.panelId, s.judge1Id, s.adminId);
    const submitted = await request(app)
      .post('/api/evaluations')
      .set(auth(s.judge1Id))
      .send({
        id: randomUUID(),
        candidate_id: s.candidateId,
        round_id: s.roundId,
        feedback: 'Solid',
        scores: { [s.criteriaIds[0]]: 8, [s.criteriaIds[1]]: 7 },
      });
    expect(submitted.status).toBe(201);
    const evaluationId = submitted.body.evaluation.id;

    const blocked = await request(app)
      .delete(`/api/criteria/${s.criteriaIds[0]}`)
      .set(auth(s.adminId));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('criterion_has_scores');

    const forced = await request(app)
      .delete(`/api/criteria/${s.criteriaIds[0]}?force=true`)
      .set(auth(s.adminId));
    expect(forced.status).toBe(200);
    expect(forced.body.scores).toBe(1);
    const evaluation = await store.getEvaluation(evaluationId);
    expect(evaluation?.scores.map((x) => x.criterion_id)).toEqual([s.criteriaIds[1]]);
  });

  it('rejects criterion deletion by a judge', async () => {
    const res = await request(app).delete(`/api/criteria/${s.criteriaIds[0]}`).set(auth(s.judge1Id));
    expect(res.status).toBe(403);
  });

  it('returns 404 for an unknown criterion', async () => {
    const res = await request(app).delete(`/api/criteria/${randomUUID()}`).set(auth(s.adminId));
    expect(res.status).toBe(404);
  });
});