import { Router } from 'express';
import { z } from 'zod';
import { badRequest, HttpError } from '../lib/errors.js';
import { parseCsvObjects, toCsv } from '../lib/csv.js';
import { requireAuth, scopeFor, type AuthedRequest } from '../lib/auth.js';
import { candidateFiltersSchema, candidatePatchSchema, candidateWriteSchema } from '../lib/validate.js';
import type { Store } from '../store/types.js';

function isAdmin(req: AuthedRequest) {
  if (req.user!.role !== 'admin') throw new HttpError(403, 'forbidden', 'Administrator access required');
}

export function candidateRoutes(store: Store): Router {
  const r = Router();

  r.get('/candidates', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = candidateFiltersSchema.safeParse(req.query);
      if (!parsed.success) throw badRequest('Invalid filters', parsed.error.flatten());
      const scope = await scopeFor(store, req.user!);
      const candidates = await store.listCandidates(scope, parsed.data);
      res.json({ candidates, count: candidates.length });
    } catch (e) {
      next(e);
    }
  });

  r.get('/candidates/:id', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const scope = await scopeFor(store, req.user!);
      const candidate = await store.getCandidate(req.params.id, scope);
      if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found');
      res.json({ candidate });
    } catch (e) {
      next(e);
    }
  });

  // Full admin view of one applicant: profile, panel, result and every judge
  // evaluation with criterion-level scores and written feedback.
  r.get('/admin/candidates/:id/profile', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const candidate = await store.getCandidate(req.params.id, { admin: true });
      if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found');
      const [panel, panelMembers, verticals, evaluations] = await Promise.all([
        store.getPanel(candidate.panel_id),
        store.listPanelMembers(candidate.panel_id),
        store.listVerticals(),
        store.listEvaluations({ admin: true, candidateId: candidate.id }),
      ]);
      const vertical = verticals.find((v) => v.id === candidate.vertical_id) ?? null;
      const verticalNames = new Map(verticals.map((v) => [v.id, v.name]));
      const criteriaById = new Map<string, { name: string; max_score: number }>();
      for (const roundId of [...new Set(evaluations.map((e) => e.round_id))]) {
        for (const criterion of await store.listCriteria(roundId)) {
          criteriaById.set(criterion.id, { name: criterion.name, max_score: criterion.max_score });
        }
      }
      const resultRows = await store.results(
        { admin: true },
        { search: candidate.roll_number || candidate.full_name, includeArchived: true },
      );
      const result = resultRows.find((r) => r.candidate_id === candidate.id) ?? null;
      res.json({
        candidate,
        panel,
        panel_members: panelMembers,
        vertical,
        result,
        evaluations: evaluations.map((e) => ({
          ...e,
          preferred_vertical_name: e.preferred_vertical_id
            ? verticalNames.get(e.preferred_vertical_id) ?? null
            : null,
          scores: e.scores.map((s) => ({
            ...s,
            criterion_name: criteriaById.get(s.criterion_id)?.name ?? s.criterion_id,
            max_score: criteriaById.get(s.criterion_id)?.max_score ?? null,
          })),
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  r.post('/candidates', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const parsed = candidateWriteSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const { interview_status, shortlisting_status, notes, ...input } = parsed.data;
      let candidate;
      try {
        candidate = await store.createCandidate(
          { ...input, application_id: input.application_id ?? null },
          req.user!.id,
        );
      } catch (e: any) {
        if (/already exists|duplicate/i.test(String(e?.message ?? e))) {
          throw new HttpError(409, 'duplicate_application_id', 'An application with this ID already exists');
        }
        throw e;
      }
      if (interview_status || shortlisting_status || notes) {
        await store.updateCandidate(candidate.id, {
          ...(interview_status ? { interview_status } : {}),
          ...(shortlisting_status ? { shortlisting_status } : {}),
          ...(notes !== undefined ? { notes } : {}),
        });
      }
      await store.audit({
        actor_id: req.user!.id,
        action: 'candidate_created',
        entity_type: 'candidate',
        entity_id: candidate.id,
        details: { full_name: candidate.full_name },
      });
      res.status(201).json({ candidate });
    } catch (e) {
      next(e);
    }
  });

  r.patch('/candidates/:id', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const parsed = candidatePatchSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const candidate = await store.updateCandidate(req.params.id, parsed.data);
      if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found');
      await store.audit({
        actor_id: req.user!.id,
        action: 'candidate_updated',
        entity_type: 'candidate',
        entity_id: candidate.id,
        details: parsed.data as Record<string, unknown>,
      });
      res.json({ candidate });
    } catch (e) {
      next(e);
    }
  });

  r.post('/candidates/:id/archive', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const parsed = zArchive.safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const candidate = await store.archiveCandidate(req.params.id, parsed.data.archived);
      if (!candidate) throw new HttpError(404, 'not_found', 'Candidate not found');
      await store.audit({
        actor_id: req.user!.id,
        action: parsed.data.archived ? 'candidate_archived' : 'candidate_unarchived',
        entity_type: 'candidate',
        entity_id: candidate.id,
        details: {},
      });
      res.json({ candidate });
    } catch (e) {
      next(e);
    }
  });

  // CSV import: body { csv: string }. Panel referenced by name or UUID.
  r.post('/candidates/import', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      const csv = typeof req.body?.csv === 'string' ? req.body.csv : null;
      if (!csv) throw badRequest('Body must contain a "csv" string');
      const { records, error } = parseCsvObjects(csv);
      if (error) throw badRequest(error);
      const panels = await store.listPanels();
      const byName = new Map(panels.map((p) => [p.name.toLowerCase(), p.id]));
      const rows: { full_name: string; branch: string; application_id: string | null; panel_id: string }[] = [];
      const rowErrors: { row: number; message: string }[] = [];
      records.forEach((rec, idx) => {
        const rowNo = idx + 2;
        const full_name = (rec.full_name ?? '').trim();
        const branch = (rec.branch ?? '').trim();
        const application_id = (rec.application_id ?? '').trim() || null;
        const panelRef = (rec.panel ?? rec.panel_id ?? '').trim();
        if (!full_name) {
          rowErrors.push({ row: rowNo, message: 'full_name is required' });
          return;
        }
        if (!panelRef) {
          rowErrors.push({ row: rowNo, message: 'panel is required (panel name or id)' });
          return;
        }
        const panelId = byName.get(panelRef.toLowerCase()) ?? (panels.some((p) => p.id === panelRef) ? panelRef : null);
        if (!panelId) {
          rowErrors.push({ row: rowNo, message: `Unknown panel "${panelRef}"` });
          return;
        }
        rows.push({ full_name, branch, application_id, panel_id: panelId });
      });
      const result = await store.bulkCreateCandidates(rows, req.user!.id);
      result.errors = [...rowErrors, ...result.errors].sort((a, b) => a.row - b.row);
      await store.audit({
        actor_id: req.user!.id,
        action: 'candidates_imported',
        entity_type: 'candidate',
        entity_id: null,
        details: { imported: result.imported, skipped: result.skipped_duplicates, errors: result.errors.length },
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  r.get('/candidates/import/template.csv', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      isAdmin(req);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="candidates-template.csv"');
      res.send(
        toCsv(['full_name', 'branch', 'application_id', 'panel'], [
          ['Ada Lovelace', 'CSE', 'APP-001', 'Panel A'],
        ]),
      );
    } catch (e) {
      next(e);
    }
  });

  return r;
}

const zArchive = z.object({ archived: z.boolean().default(true) });
