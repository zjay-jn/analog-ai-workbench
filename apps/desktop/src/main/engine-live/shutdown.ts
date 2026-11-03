export type ShutdownFailureCode = 'CLOUD_SHUTDOWN_FAILED' | 'CLOUD_SHUTDOWN_TIMEOUT';
export type ShutdownParticipant = Readonly<{
  revoke: () => void;
  dispose: () => void;
  shutdown?: () => Promise<void>;
}>;

/** Revoke synchronously, await every owner once, then dispose even after failures. */
export function createBoundedShutdown(options: Readonly<{
  participants: readonly ShutdownParticipant[];
  timeoutMs?: number;
  onFailure?: (code: ShutdownFailureCode) => void;
  beforeDrain?: Promise<void>;
}>) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 45_000) throw Error('CLOUD_SHUTDOWN_CONFIGURATION');
  let revoked = false;
  let failure: ShutdownFailureCode | undefined;
  let pending: Promise<void> | undefined;
  const participants = [...options.participants];
  const record = (code: ShutdownFailureCode) => {
    if (failure) return;
    failure = code;
    try { options.onFailure?.(code); } catch { /* Observers cannot skip cleanup. */ }
  };
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    for (const participant of participants) {
      try { participant.revoke(); } catch { record('CLOUD_SHUTDOWN_FAILED'); }
    }
  };
  const shutdown = (): Promise<void> => {
    if (pending) return pending;
    // Publish the promise before callbacks: a participant may re-enter shutdown.
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void pending.catch(() => {});
    revoke();
    const finish = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const complete = (async () => {
          await options.beforeDrain;
          await Promise.all(participants.map(async participant => {
            try { await participant.shutdown?.(); } catch { record('CLOUD_SHUTDOWN_FAILED'); }
          }));
        })();
        const timeout = new Promise<void>(done => {
          timer = setTimeout(() => { record('CLOUD_SHUTDOWN_TIMEOUT'); done(); }, timeoutMs);
        });
        await Promise.race([complete, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
        for (const participant of participants) {
          try { participant.dispose(); } catch { record('CLOUD_SHUTDOWN_FAILED'); }
        }
      }
      if (failure) reject(Error(failure)); else resolve();
    };
    void Promise.resolve().then(finish).catch(() => { record('CLOUD_SHUTDOWN_FAILED'); reject(Error(failure!)); });
    return pending;
  };
  const register = (participant: ShutdownParticipant): void => {
    if (participants.includes(participant)) return;
    participants.push(participant);
    if (revoked) {
      // Construction stops here, but the barrier keeps this new owner in the awaited drain.
      try { participant.revoke(); } catch { record('CLOUD_SHUTDOWN_FAILED'); }
      throw Error('CLOUD_SHUTDOWN_STARTED');
    }
  };
  const assertOpen = () => { if (revoked) throw Error('CLOUD_SHUTDOWN_STARTED'); };
  return Object.freeze({ revoke, shutdown, register, assertOpen });
}

/** Synchronous construction owns cleanup before the first resource; shutdown drains after its finally. */
export function createInitializationShutdown(options: Readonly<{
  timeoutMs?: number;
  onFailure?: (code: ShutdownFailureCode) => void;
}>) {
  let complete = false;
  let release!: () => void;
  const beforeDrain = new Promise<void>(resolve => { release = resolve; });
  const cleanup = createBoundedShutdown({ ...options, participants: [], beforeDrain });
  return Object.freeze({
    revoke: cleanup.revoke,
    shutdown: cleanup.shutdown,
    register(participant: ShutdownParticipant) {
      if (complete) throw Error('CLOUD_INITIALIZATION_COMPLETE');
      cleanup.register(participant);
    },
    assertOpen() {
      if (complete) throw Error('CLOUD_INITIALIZATION_COMPLETE');
      cleanup.assertOpen();
    },
    completeConstruction() { if (!complete) { complete = true; release(); } },
  });
}
