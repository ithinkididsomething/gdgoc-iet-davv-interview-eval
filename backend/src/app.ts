import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { ZodError } from 'zod';
import type { AppConfig } from './config.js';
import { HttpError } from './lib/errors.js';
import { makeAuthMiddleware, type TokenVerifier } from './lib/auth.js';
import { meRoutes } from './routes/me.js';
import { panelRoutes } from './routes/panels.js';
import { candidateRoutes } from './routes/candidates.js';
import { roundRoutes } from './routes/rounds.js';
import { evaluationRoutes } from './routes/evaluations.js';
import { syncRoutes } from './routes/sync.js';
import { resultRoutes } from './routes/results.js';
import { adminRoutes } from './routes/admin.js';
import { verticalRoutes } from './routes/verticals.js';
import { applicantImportRoutes } from './routes/admin-applicants.js';
import { sheetSyncRoutes } from './routes/sheets.js';
import { reportRoutes } from './routes/reports.js';
import { registrationRoutes } from './routes/registration.js';
import { DEMO_ACCOUNTS } from './demo/seed.js';
import type { Store } from './store/types.js';

export interface AppDeps {
  store: Store;
  verifyToken: TokenVerifier;
  config: AppConfig;
  demoMode?: boolean;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  const configuredOrigin = deps.config.corsOrigin;
  const corsOrigin =
    typeof configuredOrigin === 'string' ? configuredOrigin : configuredOrigin.includes('*') ? '*' : configuredOrigin;
  app.use(
    cors({
      origin: corsOrigin,
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.use(
    '/api',
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 500,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  const auth = makeAuthMiddleware(deps.store, deps.verifyToken);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, demo: Boolean(deps.demoMode), time: new Date().toISOString() });
  });

  if (deps.demoMode) {
    app.post('/api/auth/demo-login', async (req, res, next) => {
      try {
        const email = String(req.body?.email ?? '').trim().toLowerCase();
        const password = String(req.body?.password ?? '');
        const account = DEMO_ACCOUNTS.find((a) => a.email === email && a.password === password);
        if (!account) {
          res.status(401).json({ error: { code: 'invalid_credentials', message: 'Invalid demo email or password' } });
          return;
        }
        const profile = await deps.store.getProfile(account.id);
        const panels = profile ? await deps.store.listMyPanels(profile.id) : [];
        res.json({
          token: `demo:${account.id}`,
          profile: profile
            ? { id: profile.id, email: profile.email, full_name: profile.full_name, role: profile.role }
            : null,
          panels,
        });
      } catch (e) {
        next(e);
      }
    });
  }

  // Authenticate once for the whole /api tree. Mounting `auth` in front of
  // every router made Express re-run it on each fall-through, so requests
  // to later routers verified the token + fetched the profile up to 13×.
  app.use('/api', auth);

  app.use('/api', meRoutes(deps.store));
  app.use('/api', panelRoutes(deps.store, deps.config));
  app.use('/api', candidateRoutes(deps.store));
  app.use('/api', roundRoutes(deps.store));
  app.use('/api', evaluationRoutes(deps.store));
  app.use('/api', syncRoutes(deps.store));
  app.use('/api', resultRoutes(deps.store));
  app.use('/api', adminRoutes(deps.store, deps.config));
  app.use('/api', registrationRoutes(deps.store, deps.config));
  app.use('/api', verticalRoutes(deps.store));
  app.use('/api', applicantImportRoutes(deps.store));
  app.use('/api', sheetSyncRoutes(deps.store, deps.config));
  app.use('/api', reportRoutes(deps.store));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: { code: 'validation_error', message: 'Invalid request', details: err.flatten() },
      });
      return;
    }
    // Body-parser and similar middleware throw errors carrying an HTTP status.
    const status = (err as { status?: number; statusCode?: number } | null)?.status
      ?? (err as { statusCode?: number } | null)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: 'bad_request', message: 'Malformed request' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  });

  return app;
}
