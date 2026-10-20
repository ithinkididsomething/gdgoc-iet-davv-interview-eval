import { hashPanelCode } from '../lib/hash.js';
import type { MemoryStore } from '../store/memory.js';

/** Stable IDs so demo tokens survive hot-reloads of route modules. */
export const DEMO_ADMIN_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_JUDGE_ID = '00000000-0000-4000-8000-000000000002';

export const DEMO_ACCOUNTS = [
  {
    id: DEMO_ADMIN_ID,
    email: 'admin@demo.local',
    password: 'demo1234',
    full_name: 'Demo Admin',
    role: 'admin' as const,
  },
  {
    id: DEMO_JUDGE_ID,
    email: 'judge@demo.local',
    password: 'demo1234',
    full_name: 'Demo Judge',
    role: 'judge' as const,
  },
] as const;

export const DEMO_PANEL_CODE = 'DEMOCODE';

/** Populate an empty MemoryStore with a small interview dataset for local demos. */
export async function seedDemoStore(store: MemoryStore, codePepper: string): Promise<void> {
  for (const account of DEMO_ACCOUNTS) {
    await store.createProfile({
      id: account.id,
      email: account.email,
      full_name: account.full_name,
      role: account.role,
    });
  }

  const vertical = await store.createVertical({
    key: 'web',
    name: 'Web Development',
    worksheet: 'Web',
    sort_order: 1,
  });

  const panel = await store.createPanel({ name: 'Demo Panel A', expected_evaluations: 2 });
  panel.vertical_id = vertical.id;
  panel.shift = 'Morning';

  await store.createPanelCode({
    panel_id: panel.id,
    code_hash: hashPanelCode(DEMO_PANEL_CODE, codePepper),
    label: 'demo',
    preview: 'DE••••DE',
  });

  await store.addPanelMember(panel.id, DEMO_JUDGE_ID, DEMO_ADMIN_ID);

  const round = await store.createRound({
    name: 'Demo Round 1',
    is_open: true,
    allow_edit_after_submit: true,
    closes_at: null,
  });

  const criteria = [
    { name: 'Technical skills', description: 'Domain knowledge and problem solving', sort_order: 0 },
    { name: 'Communication', description: 'Clarity and collaboration', sort_order: 1 },
    { name: 'Culture fit', description: 'Community mindset and ownership', sort_order: 2 },
  ];
  for (const c of criteria) {
    await store.createCriterion({
      round_id: round.id,
      name: c.name,
      description: c.description,
      min_score: 1,
      max_score: 5,
      weight: 1,
      sort_order: c.sort_order,
      is_active: true,
    });
  }

  const applicants = [
    { full_name: 'Ada Lovelace', branch: 'CSE', application_id: 'APP-1001' },
    { full_name: 'Grace Hopper', branch: 'IT', application_id: 'APP-1002' },
    { full_name: 'Alan Turing', branch: 'CSE', application_id: 'APP-1003' },
  ];
  for (const row of applicants) {
    const candidate = await store.createCandidate({ ...row, panel_id: panel.id }, DEMO_ADMIN_ID);
    await store.updateCandidate(candidate.id, {
      vertical_id: vertical.id,
      shift: 'Morning',
      email: `${row.full_name.toLowerCase().replace(' ', '.')}@example.com`,
      roll_number: row.application_id,
      github_url: 'https://github.com/example',
      linkedin_url: 'https://linkedin.com/in/example',
    });
  }

  console.log('Demo data seeded:');
  console.log('  admin@demo.local / demo1234  (admin)');
  console.log('  judge@demo.local / demo1234  (judge)');
  console.log(`  panel code: ${DEMO_PANEL_CODE}`);
}
