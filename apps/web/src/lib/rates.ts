import { useQuery } from '@tanstack/react-query';
import { apiRequest } from './api.js';

export interface GlobalRates {
  current: { rate_iqd_per_usd: string } | null;
}

/**
 * Today's global rate, from the one query every screen shares. `rate` is `null` while it loads
 * and when none has been set: a screen then shows no conversion rather than inventing one — a
 * made-up rate is a wrong figure that looks right.
 */
export function useGlobalRate() {
  const query = useQuery({
    queryKey: ['global-rate'],
    queryFn: () => apiRequest<GlobalRates>('/settings/global-rates'),
  });
  return { query, rate: query.data?.current?.rate_iqd_per_usd ?? null };
}
