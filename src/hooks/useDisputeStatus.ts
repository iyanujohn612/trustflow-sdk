import type { Dispute, SDKResult } from '../types/index';
import { usePolling } from './usePolling';

/**
 * What `useDisputeStatus` reads from. {@link DisputeClient} satisfies it; so
 * can any object whose `getDispute` resolves to an {@link SDKResult}.
 */
export interface DisputeStatusSource {
  getDispute(escrowId: string): SDKResult<Dispute> | Promise<SDKResult<Dispute>>;
}

export interface UseDisputeStatusOptions {
  /** Poll interval in ms. Defaults to 5000. */
  interval?: number;
  /** Pause while the tab is hidden. Defaults to true (#783). */
  pauseWhenHidden?: boolean;
}

/** Statuses after which a dispute can no longer change, so polling stops. */
const FINAL_STATUSES = new Set<Dispute['status']>(['resolved', 'cancelled']);

/**
 * Polls the backend for the current status of a dispute on an escrow.
 *
 * Built on {@link usePolling}, so polling pauses while the browser tab is
 * hidden and fetches once when it is shown again (#783). Polling also stops
 * once the dispute is `resolved` or `cancelled`, and `dispute` keeps the same
 * object reference while polls return equal data.
 *
 * Backend failures are returned as `error` rather than thrown. Polling
 * continues after an error, so a transient outage recovers on its own.
 *
 * @param source - Usually a `DisputeClient`
 * @param escrowId - Escrow whose dispute to watch; pass null to idle
 * @param options - Poll interval and visibility behaviour
 * @returns `dispute` and `status` (null until the first successful fetch),
 *   `loading`, `error`, and `refresh` to fetch immediately
 *
 * @example
 * ```typescript
 * const disputes = new DisputeClient(config);
 * const { status, error } = useDisputeStatus(disputes, escrow.id);
 * ```
 */
export function useDisputeStatus(
  source: DisputeStatusSource,
  escrowId: string | null,
  options: UseDisputeStatusOptions = {},
) {
  const { interval = 5_000, pauseWhenHidden = true } = options;

  const { data, error, loading, refresh } = usePolling<Dispute | null>(
    async () => {
      if (!escrowId) return null;
      const result = await source.getDispute(escrowId);
      if (!result.ok) throw new Error(result.error);
      return result.data;
    },
    {
      interval,
      pauseWhenHidden,
      enabled: escrowId !== null,
      key: escrowId,
      stopWhen: (dispute) => dispute !== null && FINAL_STATUSES.has(dispute.status),
    },
  );

  return {
    dispute: data ?? null,
    status: data?.status ?? null,
    loading: escrowId !== null && loading,
    error,
    refresh,
  };
}
