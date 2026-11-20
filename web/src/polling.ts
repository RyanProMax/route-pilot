type PollOptions = {
  interval?: number; retry?: number; initialDelay?: number;
  onError?: () => void;
};

// One foreground request at a time. A suspended timer must never delay resume.
export function pollVisible(task: (signal: AbortSignal) => Promise<number | false | void>, {
  interval = 60_000, retry = 15_000, initialDelay = 0, onError,
}: PollOptions = {}) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: AbortController | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let startedAt = -Infinity;
  const available = () => !document.hidden && navigator.onLine;
  function cancel() {
    clearTimeout(timer); clearTimeout(deadline); timer = undefined;
    active?.abort(); active = null;
  }
  function schedule(delay: number) {
    clearTimeout(timer);
    if (!stopped && available()) timer = setTimeout(() => { timer = undefined; void run(); }, delay);
  }
  async function run() {
    if (stopped || !available() || active) return;
    clearTimeout(timer); timer = undefined;
    const controller = new AbortController();
    active = controller; startedAt = Date.now();
    deadline = setTimeout(() => {
      if (active !== controller) return;
      controller.abort(); active = null;
      onError?.(); schedule(retry);
    }, 15_000);
    let delay: number | false = interval;
    try {
      const next = await task(controller.signal);
      if (next !== undefined) delay = next;
    } catch {
      if (active === controller && !controller.signal.aborted) {
        onError?.(); delay = retry;
      }
    } finally {
      if (active === controller) {
        clearTimeout(deadline); active = null;
        if (!stopped && delay !== false) schedule(delay);
      }
    }
  }
  function resume() {
    if (!available()) { cancel(); return; }
    // Frozen/BFCache requests may still look pending after their timeout elapsed.
    if (active && Date.now() - startedAt >= 15_000) cancel();
    if (active) return;
    const sinceStart = Date.now() - startedAt;
    if (sinceStart >= 1_000) void run();
    else schedule(1_000 - sinceStart);
  }
  document.addEventListener('visibilitychange', resume);
  for (const event of ['online', 'offline', 'focus', 'pageshow']) window.addEventListener(event, resume);
  if (initialDelay > 0) schedule(initialDelay); else void run();
  return () => {
    stopped = true; cancel();
    document.removeEventListener('visibilitychange', resume);
    for (const event of ['online', 'offline', 'focus', 'pageshow']) window.removeEventListener(event, resume);
  };
}
