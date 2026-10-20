import { Router } from 'express';
import { z } from 'zod';
import { AttemptTracker } from '../lib/attemptTracker.js';
import { badRequest, HttpError, tooMany } from '../lib/errors.js';
import { generatePanelCode, hashPanelCode } from '../lib/hash.js';
import { requireAuth, type AuthedRequest } from '../lib/auth.js';
import { codeCreateSchema, verifyPanelSchema } from '../lib/validate.js';
import type { AppConfig } from '../config.js';
import type { Store } from '../store/types.js';

const judgeAttempts = new AttemptTracker();

export function panelRoutes(store: Store, config: AppConfig): Router {
  const r = Router();

  // Judge verifies a panel code; gains membership to that panel.
  r.post('/panels/verify', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = verifyPanelSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const user = req.user!;
      const key = `verify:${user.id}`;
      if (!judgeAttempts.allow(key, 8, 15 * 60_000)) {
        throw tooMany('Too many verification attempts. Try again later.');
      }
      const codeHash = hashPanelCode(parsed.data.code.toUpperCase(), config.codePepper);
      const outcome = await store.verifyPanelCode({
        code_hash: codeHash,
        judge_id: user.id,
        lockout_minutes: config.verifyLockoutMinutes,
      });
      if (outcome.status === 'ok') {
        judgeAttempts.reset(key);
        await store.audit({
          actor_id: user.id,
          action: 'panel_verified',
          entity_type: 'panel',
          entity_id: outcome.panel.id,
          details: {},
        });
        res.json({ status: 'ok', panel: outcome.panel });
        return;
      }
      judgeAttempts.fail(key, 15 * 60_000);
      if (outcome.status === 'locked') {
        res.status(429).json({
          status: 'locked',
          message: 'Too many incorrect attempts for this code. It is temporarily locked.',
          retry_at: outcome.retry_at,
        });
        return;
      }
      if (outcome.status === 'panel_inactive') {
        res.status(403).json({ status: 'panel_inactive', message: 'This panel is not active.' });
        return;
      }
      res.status(401).json({ status: 'invalid', message: 'Incorrect panel code.' });
    } catch (e) {
      next(e);
    }
  });

  r.get('/panels/mine', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      res.json({ panels: await store.listMyPanels(req.user!.id) });
    } catch (e) {
      next(e);
    }
  });

  // ---- Admin panel management -------------------------------------------
  r.get('/panels', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const [panels, members] = await Promise.all([store.listPanels(), store.listAllPanelMembers()]);
      const byPanel = new Map<string, { judge_id: string; judge_name: string; verified_at: string | null }[]>();
      for (const m of members) {
        const list = byPanel.get(m.panel_id) ?? [];
        list.push({ judge_id: m.judge_id, judge_name: m.judge_name, verified_at: m.verified_at });
        byPanel.set(m.panel_id, list);
      }
      res.json({ panels: panels.map((p) => ({ ...p, members: byPanel.get(p.id) ?? [] })) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/panels', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const parsed = z
        .object({ name: z.string().trim().min(1).max(120) })
        .safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const panel = await store.createPanel(parsed.data);
      await store.audit({
        actor_id: req.user!.id,
        action: 'panel_created',
        entity_type: 'panel',
        entity_id: panel.id,
        details: { name: panel.name },
      });
      res.status(201).json({ panel });
    } catch (e) {
      next(e);
    }
  });

  r.patch('/panels/:id', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const parsed = z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          is_active: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const panel = await store.updatePanel(req.params.id, parsed.data);
      if (!panel) throw new HttpError(404, 'not_found', 'Panel not found');
      await store.audit({
        actor_id: req.user!.id,
        action: 'panel_updated',
        entity_type: 'panel',
        entity_id: panel.id,
        details: parsed.data,
      });
      res.json({ panel });
    } catch (e) {
      next(e);
    }
  });

  r.delete('/panels/:id', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const deleted = await store.deletePanel(req.params.id);
      if (!deleted) throw new HttpError(404, 'not_found', 'Panel not found');
      await store.audit({
        actor_id: req.user!.id,
        action: 'panel_deleted',
        entity_type: 'panel',
        entity_id: req.params.id,
        details: {},
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ---- Panel verification codes (admin) ---------------------------------
  r.get('/panels/:id/codes', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      res.json({ codes: await store.listPanelCodes(req.params.id) });
    } catch (e) {
      next(e);
    }
  });

  // Create a code (does not deactivate existing ones)
  r.post('/panels/:id/codes', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const parsed = codeCreateSchema.safeParse({ ...req.body, panel_id: req.params.id });
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const panel = await store.getPanel(req.params.id);
      if (!panel) throw new HttpError(404, 'not_found', 'Panel not found');
      const code = parsed.data.code ?? generatePanelCode();
      const preview = `${code.slice(0, 2)}••••${code.slice(-2)}`;
      const created = await store.createPanelCode({
        panel_id: panel.id,
        code_hash: hashPanelCode(code.toUpperCase(), config.codePepper),
        label: parsed.data.label,
        preview,
        expires_at: parsed.data.expires_at ?? null,
      });
      await store.audit({
        actor_id: req.user!.id,
        action: 'panel_code_created',
        entity_type: 'panel_code',
        entity_id: created.id,
        details: { panel_id: panel.id, label: parsed.data.label },
      });
      // Plaintext returned exactly once, at creation time.
      res.status(201).json({ code_record: created, plaintext_code: code });
    } catch (e) {
      next(e);
    }
  });

  // Rotate: deactivate all active codes for the panel and issue a new one.
  r.post('/panels/:id/codes/rotate', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const parsed = codeCreateSchema.safeParse({ ...req.body, panel_id: req.params.id });
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const panel = await store.getPanel(req.params.id);
      if (!panel) throw new HttpError(404, 'not_found', 'Panel not found');
      const code = parsed.data.code ?? generatePanelCode();
      const preview = `${code.slice(0, 2)}••••${code.slice(-2)}`;
      const created = await store.rotatePanelCode({
        panel_id: panel.id,
        code_hash: hashPanelCode(code.toUpperCase(), config.codePepper),
        label: parsed.data.label,
        preview,
        expires_at: parsed.data.expires_at ?? null,
      });
      await store.audit({
        actor_id: req.user!.id,
        action: 'panel_code_rotated',
        entity_type: 'panel',
        entity_id: created.id,
        details: { panel_id: panel.id },
      });
      res.status(201).json({ code_record: created, plaintext_code: code });
    } catch (e) {
      next(e);
    }
  });

  r.patch('/panel-codes/:codeId', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const parsed = z.object({ is_active: z.boolean() }).safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const code = await store.setPanelCodeActive(req.params.codeId, parsed.data.is_active);
      if (!code) throw new HttpError(404, 'not_found', 'Code not found');
      await store.audit({
        actor_id: req.user!.id,
        action: parsed.data.is_active ? 'panel_code_activated' : 'panel_code_deactivated',
        entity_type: 'panel_code',
        entity_id: code.id,
        details: {},
      });
      res.json({ code_record: code });
    } catch (e) {
      next(e);
    }
  });

  // ---- Panel membership (admin) -------------------------------------------
  r.get('/panels/:id/members', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      res.json({ members: await store.listPanelMembers(req.params.id) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/panels/:id/members', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const parsed = z.object({ judge_id: z.string().uuid() }).safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const judge = await store.getProfile(parsed.data.judge_id);
      if (!judge) throw new HttpError(404, 'not_found', 'Judge not found');
      if (judge.role !== 'judge') throw badRequest('Target user is not a judge');
      await store.addPanelMember(req.params.id, parsed.data.judge_id, req.user!.id);
      await store.audit({
        actor_id: req.user!.id,
        action: 'panel_member_added',
        entity_type: 'panel',
        entity_id: req.params.id,
        details: { judge_id: parsed.data.judge_id },
      });
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.delete('/panels/:id/members/:judgeId', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
      const removed = await store.removePanelMember(req.params.id, req.params.judgeId);
      if (!removed) throw new HttpError(404, 'not_found', 'Membership not found');
      await store.audit({
        actor_id: req.user!.id,
        action: 'panel_member_removed',
        entity_type: 'panel',
        entity_id: req.params.id,
        details: { judge_id: req.params.judgeId },
      });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
