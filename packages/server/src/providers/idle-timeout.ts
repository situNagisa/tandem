export function createIdleTimeout(signal: AbortSignal, seconds: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, seconds * 1000);
  };
  reset();
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    reset,
    get timedOut() {
      return timedOut;
    },
    clear: () => clearTimeout(timer),
  };
}

export function idleTimeoutError(seconds: number): Error {
  return new Error(`模型 ${seconds} 秒无响应，已中止`);
}
