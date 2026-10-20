import { Router } from 'express';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { requireAuth, scopeFor, type AuthedRequest } from '../lib/auth.js';
import { evaluationPatchSchema, evaluationSubmitSchema } from '../lib/validate.js';
import { enqueueEvaluationSheetSync, handleSubmission } from '../services/submit.js';
import type { Store } from '../store/types.js';

export function evaluationRoutes(store: Store): Router {
  const r = Router();

  // Submit a single evaluation (online path). Idempotent via client-generated id.
  r.post('/evaluations', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = evaluationSubmitSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const { replace_existing, ...input } = parsed.data;
      const outcome = await handleSubmission(store, req.user!.id, input, {
        replaceExisting: replace_existing ?? false,
      });
      await store.audit({
        actor_id: req.user!.id,
        action: 'evaluation_submitted',
        entity_type: 'evaluation',
        entity_id: input.id,
        details: { candidate_id: input.candidate_id, round_id: input.round_id, result: outcome.status },
      });
      if (outcome.status === 'ok') {
        res.status(outcome.idempotent ? 200 : 201).json(outcome);
        return;
      }
      if (outcome.status === 'duplicate') {
        res.status(409).json({
          ...outcome,
          message:
            'You have already submitted an official evaluation for this candidate. ' +
            'Enable edit-after-submit in the round settings to replace it.',
        });
        return;
      }
      if (outcome.status === 'error' && outcome.details) {
        res.status(400).json(outcome);
        return;
      }
      res.status(400).json(outcome);
    } catch (e) {
      next(e);
    }
  });

  // Judge's own evaluation history (with sync-relevant metadata).
  r.get('/evaluations/mine', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const evaluations = await store.listEvaluations({ admin: false, judgeId: req.user!.id });
      res.json({ evaluations });
    } catch (e) {
      next(e);
    }
  });

  // Edit own evaluation — only when the round's policy allows it and it is open.
  r.patch('/evaluations/:id', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const parsed = evaluationPatchSchema.safeParse(req.body);
      if (!parsed.success) throw badRequest('Invalid request', parsed.error.flatten());
      const existing = await store.getEvaluation(req.params.id);
      if (!existing) throw notFound('Evaluation not found');
      if (existing.judge_id !== req.user!.id) {
        throw new HttpError(403, 'forbidden', 'You cannot modify another judge’s evaluation');
      }
      const round = await store.getRound(existing.round_id);
      if (!round) throw notFound('Round not found');
      if (!round.is_open || (round.closes_at && new Date(round.closes_at).getTime() < Date.now())) {
        throw conflict('This round is closed; the evaluation cannot be edited', 'round_closed');
      }
      if (!round.allow_edit_after_submit) {
        throw conflict('Edits are not allowed for this round', 'edits_not_allowed');
      }
      // Re-run the full submission pipeline against the existing record.
      const outcome = await handleSubmission(
        store,
        req.user!.id,
        {
          id: existing.id,
          candidate_id: existing.candidate_id,
          round_id: existing.round_id,
          feedback: parsed.data.feedback,
          overall_score: parsed.data.overall_score ?? null,
          scores: parsed.data.scores ?? {},
          criterion_feedbacks: parsed.data.criterion_feedbacks ?? {},
          preferred_vertical_id: parsed.data.preferred_vertical_id ?? null,
        },
        { replaceExisting: true },
      );
      if (outcome.status !== 'ok') {
        res.status(400).json(outcome);
        return;
      }
      await store.audit({
        actor_id: req.user!.id,
        action: 'evaluation_updated',
        entity_type: 'evaluation',
        entity_id: existing.id,
        details: {
          previous_score: existing.overall_score,
          new_score: outcome.evaluation.overall_score,
          previous_version: existing.version,
          new_version: outcome.evaluation.version,
        },
      });
      res.json(outcome);
    } catch (e) {
      next(e);
    }
  });

  // Delete a submitted evaluation. Judges may delete their own; admins any.
  r.delete('/evaluations/:id', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const existing = await store.getEvaluation(req.params.id);
      if (!existing) throw notFound('Evaluation not found');
      const scope = await scopeFor(store, req.user!);
      if (!scope.admin && existing.judge_id !== req.user!.id) {
        throw forbidden("You cannot delete another judge's evaluation");
      }
      const deleted = await store.deleteEvaluation(existing.id);
      if (!deleted) throw notFound('Evaluation not found');
      const candidate = await store.getCandidate(existing.candidate_id, { admin: true });
      if (candidate) {
        try {
          await enqueueEvaluationSheetSync(
            store,
            candidate,
            existing.id,
            existing.round_id,
            existing.judge_id,
          );
        } catch {
          /* sheet updates are best-effort */
        }
      }
      await store.audit({
        actor_id: req.user!.id,
        action: 'evaluation_deleted',
        entity_type: 'evaluation',
        entity_id: existing.id,
        details: {
          candidate_id: existing.candidate_id,
          round_id: existing.round_id,
          judge_id: existing.judge_id,
          overall_score: existing.overall_score,
        },
      });
      res.json({ deleted: true, evaluation: deleted });
    } catch (e) {
      next(e);
    }
  });

  // Evaluations for one candidate. Judges may view ratings on their own panel;
  // admins may view everything.
  r.get('/evaluations', requireAuth, async (req: AuthedRequest, res, next) => {
    try {
      const candidateId = typeof req.query.candidateId === 'string' ? req.query.candidateId : undefined;
      const judgeId = typeof req.query.judgeId === 'string' ? req.query.judgeId : undefined;
      const scope = await scopeFor(store, req.user!);
      const evaluations = await store.listEvaluations({
        admin: scope.admin,
        judgeId: scope.admin ? judgeId : req.user!.id,
        candidateId,
        panelIds: scope.panelIds,
      });
      res.json({ evaluations });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
