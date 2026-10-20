import { api } from './api';
import {
  saveCandidates,
  saveCriteria,
  saveRounds,
  setMeta,
} from './idb';
import type { Candidate, Criterion, Round } from './types';

export interface OfflinePrepResult {
  candidates: number;
  rounds: number;
  criteria: number;
}

export async function prepareOfflineData(
  token: string,
  userId: string,
): Promise<OfflinePrepResult> {
  const me = await api<{ panels: { id: string }[] }>('/me', { token });
  if (me.panels.length === 0) {
    throw new Error('Verify your panel code before offline data can be prepared.');
  }

  const candRes = await api<{ candidates: Candidate[] }>('/candidates', { token });
  await saveCandidates(candRes.candidates);

  const roundRes = await api<{ rounds: Round[] }>('/rounds', { token });
  const openRounds = roundRes.rounds.filter((r) => r.is_open);
  await saveRounds(openRounds);

  const allCriteria: Criterion[] = [];
  for (const round of openRounds) {
    const cRes = await api<{ criteria: Criterion[] }>(`/rounds/${round.id}/criteria`, { token });
    allCriteria.push(...cRes.criteria);
  }
  await saveCriteria(allCriteria);

  await setMeta('offline_prepared', true);
  await setMeta('last_sync_at', new Date().toISOString());
  await setMeta('prepared_for_user', userId);

  return {
    candidates: candRes.candidates.length,
    rounds: openRounds.length,
    criteria: allCriteria.length,
  };
}
