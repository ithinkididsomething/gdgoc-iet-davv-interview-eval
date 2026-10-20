import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { seedDemoStore } from './demo/seed.js';
import { makeSupabaseTokenVerifier } from './lib/supabaseAuth.js';
import { MemoryStore } from './store/memory.js';
import { SupabaseStore } from './store/supabase.js';

const demoMode = process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true';
const config = loadConfig();

async function main() {
  if (demoMode) {
    const store = new MemoryStore();
    await seedDemoStore(store, config.codePepper);
    const verifyToken = async (token: string) =>
      token.startsWith('demo:') ? token.slice(5) : null;
    const app = createApp({ store, verifyToken, config, demoMode: true });
    app.listen(config.port, () => {
      console.log(`GDGOC backend (DEMO) listening on http://localhost:${config.port}`);
    });
    return;
  }

  const store = new SupabaseStore(config.supabaseUrl, config.serviceRoleKey);
  const app = createApp({
    store,
    verifyToken: makeSupabaseTokenVerifier(config.supabaseUrl),
    config,
  });
  app.listen(config.port, () => {
    console.log(`GDGOC backend listening on http://localhost:${config.port}`);
  });
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
