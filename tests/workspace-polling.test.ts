import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspacePolling, type WorkspaceSnapshot } from '../src/workspacePolling';

const active: (() => void)[] = [];
afterEach(() => { active.splice(0).forEach(stop => stop()); vi.useRealTimers(); });
function harness(pending = false) {
  let snapshot: WorkspaceSnapshot | null = { activityId: 'activity-a', revision: 'one', hasPending: pending };
  let visible = true;
  const visibilityEvents = new EventTarget(), windowEvents = new EventTarget();
  const fetchStatus = vi.fn(async (_activityId: string, _signal: AbortSignal) => ({ revision: snapshot!.revision, hasPending: snapshot!.hasPending, serverTime: Date.now() }));
  const fetchWorkspace = vi.fn(async () => ({ revision: 'two', hasPending: false }));
  const onWorkspace = vi.fn((next: {revision:string;hasPending:boolean}) => { snapshot = { ...snapshot!, ...next }; });
  const onError = vi.fn();
  const polling = createWorkspacePolling({ getSnapshot: () => snapshot, available: () => visible,
    visibilityEvents, windowEvents, fetchStatus, fetchWorkspace, onWorkspace, onError });
  active.push(() => polling.stop());
  return { fetchStatus, fetchWorkspace, onWorkspace, onError, polling, visibilityEvents, windowEvents,
    setSnapshot(next: WorkspaceSnapshot) { snapshot = next; },
    setVisible(next: boolean) { visible = next; visibilityEvents.dispatchEvent(new Event('visibilitychange')); } };
}

it('작업 없는 20명은 1분 동안 전체 자료를 재다운로드하지 않고 경량 상태만 한 번씩 확인한다', async () => {
  vi.useFakeTimers(); const clients = Array.from({ length: 20 }, () => harness());
  await vi.advanceTimersByTimeAsync(59_999);
  clients.forEach(client => expect(client.fetchStatus).not.toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(1);
  expect(clients.reduce((n,c) => n+c.fetchStatus.mock.calls.length,0)).toBe(20);
  clients.forEach(client => expect(client.fetchWorkspace).not.toHaveBeenCalled());
});

it('처리 중에는 상태만 확인하고 완료된 변경에 한해서 전체 자료를 한 번 받는다', async () => {
  vi.useFakeTimers(); const client = harness(true);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(client.fetchStatus).toHaveBeenCalledTimes(3);
  expect(client.fetchWorkspace).not.toHaveBeenCalled();
  client.fetchStatus.mockResolvedValue({ revision: 'two', hasPending: false, serverTime: Date.now() });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(client.fetchWorkspace).toHaveBeenCalledTimes(1);
  expect(client.onWorkspace).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(59_999);
  expect(client.fetchStatus).toHaveBeenCalledTimes(4);
});

it('가려진 탭은 요청하지 않고 다시 보일 때 즉시 상태를 확인한다', async () => {
  vi.useFakeTimers(); const client = harness(true);
  client.setVisible(false);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(client.fetchStatus).not.toHaveBeenCalled();
  client.setVisible(true); await vi.advanceTimersByTimeAsync(0);
  expect(client.fetchStatus).toHaveBeenCalledTimes(1);
  expect(client.fetchWorkspace).not.toHaveBeenCalled();
});

it('활동을 바꾼 뒤 도착한 이전 활동의 상태를 화면에 적용하지 않는다', async () => {
  vi.useFakeTimers(); const client = harness(true);
  let resolve!: (value: any) => void;
  client.fetchStatus.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await vi.advanceTimersByTimeAsync(5_000);
  client.setSnapshot({ activityId:'activity-b',revision:'other',hasPending:false });
  resolve({revision:'two',hasPending:false,serverTime:Date.now()});
  await vi.advanceTimersByTimeAsync(0);
  expect(client.fetchWorkspace).not.toHaveBeenCalled();
  expect(client.onWorkspace).not.toHaveBeenCalled();
});

it('사용자 조작으로 더 최신 자료를 받은 뒤 옛 자동 조회가 덮어쓰지 않는다', async () => {
  vi.useFakeTimers(); const client = harness(true);
  let resolve!: (value:any) => void;
  client.fetchStatus.mockResolvedValue({revision:'two',hasPending:true,serverTime:Date.now()});
  client.fetchWorkspace.mockImplementationOnce(() => new Promise(done => { resolve=done; }));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(client.fetchWorkspace).toHaveBeenCalledTimes(1);
  client.setSnapshot({activityId:'activity-a',revision:'three',hasPending:false});
  resolve({revision:'two',hasPending:true}); await vi.advanceTimersByTimeAsync(0);
  expect(client.onWorkspace).not.toHaveBeenCalled();
});

it('중복 포커스에도 요청을 겹치지 않고 화면을 떠나면 진행 중 요청을 취소한다', async () => {
  vi.useFakeTimers(); const client = harness(true);
  let signal: AbortSignal | undefined;
  client.fetchStatus.mockImplementationOnce((_id, received) => { signal=received; return new Promise(() => {}); });
  client.polling.requestNow();
  client.windowEvents.dispatchEvent(new Event('focus'));
  client.windowEvents.dispatchEvent(new Event('online'));
  expect(client.fetchStatus).toHaveBeenCalledTimes(1);
  client.polling.stop(); expect(signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(client.fetchStatus).toHaveBeenCalledTimes(1);
});

it('오류가 반복되면 요청 간격을 늘리고 연결 복구 시 즉시 재확인한다', async () => {
  vi.useFakeTimers(); const client=harness(true);
  client.fetchStatus.mockRejectedValueOnce(new Error('temporary'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(client.onError).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(9_999); expect(client.fetchStatus).toHaveBeenCalledTimes(1);
  client.windowEvents.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(0);
  expect(client.fetchStatus).toHaveBeenCalledTimes(2);
  expect(client.fetchWorkspace).not.toHaveBeenCalled();
});
