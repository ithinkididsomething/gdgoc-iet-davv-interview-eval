export interface AppConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  codePepper: string;
  corsOrigin: string | string[];
  verifyLockoutMinutes: number;
  port: number;
  // addendum: workbook + spreadsheet sync
  googleSheetsCredentials: string | null;
  defaultSpreadsheetId: string;
  interviewersPerVertical: number;
  // Secret code an admin types on the registration form to gain admin status.
  // Never exposed by any API; compared in constant time.
  adminSecretCode: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const codePepper = env.CODE_PEPPER ?? '';
  const demoMode = env.DEMO_MODE === '1' || env.DEMO_MODE === 'true';
  if (!supabaseUrl || !serviceRoleKey || !codePepper) {
    // Only enforced when the Supabase store is actually constructed.
    if (env.NODE_ENV !== 'test' && !demoMode) {
      throw new Error(
        'Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CODE_PEPPER',
      );
    }
  }
  return {
    supabaseUrl,
    serviceRoleKey,
    codePepper,
    corsOrigin: env.CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean) ?? '*',
    verifyLockoutMinutes: Number(env.VERIFY_ATTEMPT_LOCKOUT_MINUTES ?? 10),
    port: Number(env.PORT ?? 4000),
    googleSheetsCredentials: env.GOOGLE_SHEETS_CREDENTIALS?.trim() || null,
    defaultSpreadsheetId: env.SPREADSHEET_ID ?? '',
    interviewersPerVertical: Number(env.INTERVIEWERS_PER_VERTICAL ?? 10),
    adminSecretCode: env.ADMIN_SECRET_CODE ?? '',
  };
}
