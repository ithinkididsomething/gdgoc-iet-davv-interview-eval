import { Router } from 'express';
import { z } from 'zod';
import { badRequest, HttpError } from '../lib/errors.js';
import { requireAuth, type AuthedRequest } from '../lib/auth.js';
import { connectionStatus, exportApplicantsToSheets, pullFromSheets, pushToSheets } from '../services/sync-spreadsheet/engine.js';
import { describeSheetsError, listTabs, normalizeSpreadsheetId, spreadsheetUrl } from '../services/sheets/googleSheets.js';
import type { AppConfig } from '../config.js';
import type { Store } from '../store/types.js';

const connectionSchema = z.object({
  spreadsheet_id: z
    .string()
    .trim()
    .min(6)
    .max(300)
    .regex(/^[\w-]+$/, 'must be a Google Sheets file ID'),
  title: z.string().trim().max(200).default(''),
  header_row: z.number().int().min(1).max(20).default(1),
  is_active: z.boolean().default(true),
});

export function sheetSyncRoutes(store: Store, config: AppConfig): Router {
  const r = Router();

  const isAdmin = (req: AuthedRequest) => {
    if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
  };

  r.get('/sheets/connection', requireAuth, async (_req, res, next) => {
    try {
      res.json(await connectionStatus(store, config));
    } catch (e) {
      next(e);
    }
  });

  r.put('/sheets/connection', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      // Accept a full Google Sheets link as well as a bare file ID.
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parsed = connectionSchema.safeParse({
        ...body,
        spreadsheet_id: normalizeSpreadsheetId(
          typeof body.spreadsheet_id === 'string' ? body.spreadsheet_id : '',
        ),
      });
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      if (!config.googleSheetsCredentials) {
        throw badRequest('Server is missing GOOGLE_SHEETS_CREDENTIALS — connection cannot be activated');
      }
      const conn = await store.saveSpreadsheetConnection({
        kind: 'google_sheets',
        spreadsheet_id: parsed.data.spreadsheet_id,
        title: parsed.data.title || `Spreadsheet ${parsed.data.spreadsheet_id}`,
        header_row: parsed.data.header_row,
        is_active: parsed.data.is_active,
        last_sync_status: 'never',
        last_sync_error: '',
      });
      await store.audit({
        actor_id: req.user!.id,
        action: 'spreadsheet_connected',
        entity_type: 'spreadsheet_connection',
        entity_id: conn.id,
        details: { spreadsheet_id: conn.spreadsheet_id },
      });
      res.json({
        connection: conn,
        url: spreadsheetUrl(conn.spreadsheet_id),
      });
    } catch (e) {
      next(e);
    }
  });

  // List tabs of the connected spreadsheet (for vertical↔worksheet mapping UI).
  r.get('/sheets/tabs', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const conn = await store.getSpreadsheetConnection();
      const spreadsheetId = conn?.spreadsheet_id || config.defaultSpreadsheetId;
      if (!config.googleSheetsCredentials || !spreadsheetId) throw badRequest('Sheets not configured');
      const tabs = await listTabs({
        credentialsJson: config.googleSheetsCredentials,
        spreadsheetId,
      });
      res.json({ tabs });
    } catch (e) {
      next(e instanceof HttpError ? e : badRequest(describeSheetsError(e)));
    }
  });

  // Pull applicant rows from mapped worksheets (per vertical).
  r.post('/sheets/pull', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const summary = await pullFromSheets(store, config, req.user!.id);
      await store.saveSpreadsheetConnection({
        last_sync_at: new Date().toISOString(),
        last_sync_status: summary.connection_ok ? 'ok' : 'error',
        last_sync_error: summary.error ?? '',
      });
      res.json(summary);
    } catch (e) {
      next(e);
    }
  });

  // Push queued evaluation rows (drains the durable sync queue).
  r.post('/sheets/push', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const summary = await pushToSheets(store, config, req.user!.id);
      if (summary.connection_ok) {
        await store.saveSpreadsheetConnection({
          last_sync_at: new Date().toISOString(),
          last_sync_status: summary.pushed.some((p) => p.status === 'failed') ? 'error' : 'ok',
          last_sync_error: summary.error ?? '',
        });
      }
      res.json(summary);
    } catch (e) {
      next(e);
    }
  });

  // Any signed-in judge may nudge the queue (debounced client-side). It only
  // drains work that was already enqueued by submissions, so this cannot leak
  // sheet data; responses are deliberately reduced to counters.
  r.post('/sheets/trigger', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const summary = await pushToSheets(store, config, req.user!.id);
      const pending = (await store.listSpreadsheetSync('pending')).length;
      res.json({
        connection_ok: summary.connection_ok,
        pushed: summary.pushed.filter((p) => p.status === 'done').length,
        failed: summary.pushed.filter((p) => p.status === 'failed').length,
        pending,
      });
    } catch (e) {
      next(e);
    }
  });

  // Write the header row + every active applicant into one tab per vertical.
  r.post('/sheets/export', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const summary = await exportApplicantsToSheets(store, config, req.user!.id);
      if (summary.connection_ok) {
        await store.saveSpreadsheetConnection({
          last_sync_at: new Date().toISOString(),
          last_sync_status: summary.written.length ? 'ok' : 'error',
          last_sync_error: summary.error ?? '',
        });
      }
      res.json(summary);
    } catch (e) {
      next(e);
    }
  });

  // Both directions: pull then push.
  r.post('/sheets/sync', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const pull = await pullFromSheets(store, config, req.user!.id);
      const push = await pushToSheets(store, config, req.user!.id);
      res.json({ pull, push });
    } catch (e) {
      next(e);
    }
  });

  r.get('/sheets/queue', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const queue = await store.listSpreadsheetSync(status);
      res.json({ queue });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
