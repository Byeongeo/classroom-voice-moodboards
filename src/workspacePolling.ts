import type { WorkspaceStatus } from '../shared/contracts';

export const ACTIVE_STATUS_INTERVAL = 5_000;
export const IDLE_STATUS_INTERVAL = 60_000;

export type WorkspaceSnapshot = { activityId: string; revision: string; hasPending: boolean };
type Options<T> = {
  getSnapshot: () => WorkspaceSnapshot | null;
  available: () => boolean;
  visibilityEvents: EventTarget;
  windowEvents: EventTarget;
  fetchStatus: (activityId: string, signal: AbortSignal) => Promise<WorkspaceStatus>;
  fetchWorkspace: (activityId: string, signal: AbortSignal) => Promise<T>;
  onWorkspace: (workspace: T, snapshot: WorkspaceSnapshot) => void;
  onStatus?: (status: WorkspaceStatus) => void;
  onError: (error: unknown) => void;
};

// One request at a time. Full records are fetched only when the server's
// metadata revision changes; an inactive tab keeps no polling timer alive.
export function createWorkspacePolling<T>(options: Options<T>) {
  let stopped = false, running = false, wakeRequested = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  function schedule(immediate = false) {
    clearTimer();
    const state = options.getSnapshot();
    if (stopped || !state || !options.available()) return;
    const normal = state.hasPending ? ACTIVE_STATUS_INTERVAL : IDLE_STATUS_INTERVAL;
    timer = setTimeout(check, immediate ? 0 : Math.min(IDLE_STATUS_INTERVAL, normal * 2 ** Math.min(failures, 4)));
  }
  async function check() {
    clearTimer();
    if (stopped || running || !options.available()) return;
    const snapshot = options.getSnapshot();
    if (!snapshot) return;
    running = true;
    const request = new AbortController(); controller = request;
    const current = () => {
      const state = options.getSnapshot();
      return !stopped && !request.signal.aborted && options.available()
        && state?.activityId === snapshot.activityId && state.revision === snapshot.revision;
    };
    try {
      const status = await options.fetchStatus(snapshot.activityId, request.signal);
      if (!current()) return;
      options.onStatus?.(status);
      if (status.revision !== snapshot.revision || status.hasPending !== snapshot.hasPending) {
        const workspace = await options.fetchWorkspace(snapshot.activityId, request.signal);
        if (current()) options.onWorkspace(workspace, snapshot);
      }
      failures = 0;
    } catch (error) {
      if (current()) { failures++; options.onError(error); }
    } finally {
      if (controller === request) controller = undefined;
      running = false;
      const immediate = wakeRequested; wakeRequested = false;
      schedule(immediate);
    }
  }
  function wake() {
    clearTimer();
    if (stopped) return;
    if (!options.available()) { controller?.abort(); return; }
    if (running) { wakeRequested = true; return; }
    void check();
  }
  options.visibilityEvents.addEventListener('visibilitychange', wake);
  for (const event of ['focus', 'online', 'offline']) options.windowEvents.addEventListener(event, wake);
  schedule();
  return {
    requestNow: wake,
    stop() {
      stopped = true; clearTimer(); controller?.abort();
      options.visibilityEvents.removeEventListener('visibilitychange', wake);
      for (const event of ['focus', 'online', 'offline']) options.windowEvents.removeEventListener(event, wake);
    },
  };
}
