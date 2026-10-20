import { api } from './api';

type TokenProvider = () => Promise<string | null>;

let timer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;

/**
 * Debounced nudge for the backend sheet queue. Any signed-in judge can call
 * the trigger endpoint; only the first concurrent call actually claims rows,
 * so five people submitting at once still costs one sheet write per tab.
 */
export function scheduleSheetSync(getToken: TokenProvider, delayMs = 8_000): void {
  if (typeof window === 'undefined') return;
  if (timer !== null) return;
  const run = async () => {
    timer = null;
    const token = await getToken();
    if (!token) return;
    try {
      const res = await api<{ pending: number }>('/sheets/trigger', { method: 'POST', token });
      if (res.pending > 0 && retries < 4) {
        retries += 1;
        timer = setTimeout(run, 15_000);
      } else {
        retries = 0;
      }
    } catch {
      if (retries < 3) {
        retries += 1;
        timer = setTimeout(run, 20_000);
      }
    }
  };
  timer = setTimeout(run, delayMs);
}
