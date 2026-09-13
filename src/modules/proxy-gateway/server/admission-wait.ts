export async function waitForAdmissionSlot(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  const abortSignal = signal;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(cleanup, delayMs);
    const onAbort = () => cleanup();
    function cleanup() {
      clearTimeout(timer);
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}
