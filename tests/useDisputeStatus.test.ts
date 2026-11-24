/** @jest-environment jsdom */
import { act, renderHook } from '@testing-library/react';
import { useDisputeStatus, type DisputeStatusSource } from '../src/hooks/useDisputeStatus';
import type { Dispute, SDKResult } from '../src/types/index';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** Lets the fetch chain (source call, fetch function, poll loop) settle. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

const dispute = (status: Dispute['status'], escrowId = 'E1'): Dispute => ({
  id: 'D1',
  escrowId,
  status,
});

/** A source whose dispute status can be changed between polls. */
function fakeSource(initial: Dispute['status'] = 'open') {
  const state = { status: initial };
  const source = {
    getDispute: jest.fn(
      async (escrowId: string): Promise<SDKResult<Dispute>> => ({
        ok: true,
        data: dispute(state.status, escrowId),
      }),
    ),
  };
  return { source, state };
}

describe('useDisputeStatus', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fetches on mount and exposes the dispute and its status', async () => {
    const { source } = fakeSource('open');
    const { result } = renderHook(() => useDisputeStatus(source, 'E1'));
    await flush();

    expect(source.getDispute).toHaveBeenCalledWith('E1');
    expect(result.current.status).toBe('open');
    expect(result.current.dispute?.id).toBe('D1');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('pauses while the tab is hidden and fetches at once when shown (#783)', async () => {
    const { source } = fakeSource();
    renderHook(() => useDisputeStatus(source, 'E1', { interval: 1000 }));
    await flush();
    expect(source.getDispute).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await tick(10_000);
    expect(source.getDispute).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await flush();
    expect(source.getDispute).toHaveBeenCalledTimes(2);
  });

  it('polls at the interval and stops once the dispute is resolved', async () => {
    const { source, state } = fakeSource('open');
    const { result } = renderHook(() => useDisputeStatus(source, 'E1', { interval: 1000 }));
    await flush();

    state.status = 'resolving';
    await tick(1000);
    expect(result.current.status).toBe('resolving');

    state.status = 'resolved';
    await tick(1000);
    expect(result.current.status).toBe('resolved');

    const callsAtFinalState = source.getDispute.mock.calls.length;
    await tick(10_000);
    expect(source.getDispute).toHaveBeenCalledTimes(callsAtFinalState);
  });

  it('reports a failed fetch as error and keeps polling until it recovers', async () => {
    const source = {
      getDispute: jest
        .fn()
        .mockResolvedValueOnce({ ok: false, error: 'backend down' })
        .mockResolvedValueOnce({ ok: true, data: dispute('open') }),
    };
    const { result } = renderHook(() => useDisputeStatus(source, 'E1', { interval: 1000 }));
    await flush();

    expect(result.current.error?.message).toBe('backend down');
    expect(result.current.status).toBeNull();

    await tick(1000);
    expect(result.current.error).toBeNull();
    expect(result.current.status).toBe('open');
  });

  it('stays idle with no escrow id', async () => {
    const { source } = fakeSource();
    const { result } = renderHook(() => useDisputeStatus(source, null, { interval: 1000 }));
    await tick(5000);

    expect(source.getDispute).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.dispute).toBeNull();
  });

  it('does not restart polling when re-rendered with a new source object', async () => {
    const { source } = fakeSource();
    renderHook(() =>
      useDisputeStatus(
        // A fresh object every render, as an inline source would be.
        { getDispute: (id: string) => source.getDispute(id) } as DisputeStatusSource,
        'E1',
        { interval: 1000 },
      ),
    );
    await flush();
    await tick(1000);
    expect(source.getDispute).toHaveBeenCalledTimes(2);
  });

  it('clears the previous dispute and fetches again when the escrow id changes', async () => {
    const { source } = fakeSource('open');
    const { result, rerender } = renderHook(({ id }) => useDisputeStatus(source, id), {
      initialProps: { id: 'E1' as string | null },
    });
    await flush();
    expect(result.current.dispute?.escrowId).toBe('E1');

    rerender({ id: 'E2' });
    expect(result.current.dispute).toBeNull();
    await flush();

    expect(source.getDispute).toHaveBeenLastCalledWith('E2');
    expect(result.current.dispute?.escrowId).toBe('E2');
  });
});
