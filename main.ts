// main.ts — boot the forge and hand it to the suite.
//
// The suite (the env) owns port 8080 and tells us where it lives through
// MAKEFUN_ENV_URL. Our job is small: start the forge on a port the kernel
// picks, tell the suite which one, then wait until the suite says it is
// finished and leave quietly.
//
//   no env   -> exit 1 at once; there is nothing to talk to.
//   register -> POST /register {"port": N}. 200 means accepted; 409 means
//               another forge registered first, and we wait it out like any
//               other. 400 or 405 mean the contract itself is broken, so
//               we stop. Anything else — the env still booting, a dropped
//               connection, an unexpected status — is retried.
//   done     -> GET /done until the body says {"done": true}. Every other
//               answer means "not yet": keep polling.
//   exit     -> close the forge and exit 0.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('main: MAKEFUN_ENV_URL is not set; no suite to register with\n');
  process.exit(1);
}

// How long a single call to the suite may take before we abandon it.
const CALL_TIMEOUT_MS = 30_000;
// Pause after the first failed attempt, doubling up to the cap.
const PAUSE_FIRST_MS = 250;
const PAUSE_MAX_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call `tryOnce` until it returns a value. A null return means "not yet":
 * wait a little longer each time (250ms, 500ms, 1s, 2s, then 2s) and try
 * again. An exception thrown by `tryOnce` is fatal and escapes.
 *
 * Retries are logged only while they are still informative: the first three,
 * then every tenth. A /done poll can run for the whole trial, and a line
 * every two seconds would flood the log for no reason.
 */
async function untilDone<T>(label: string, tryOnce: () => Promise<T | null>): Promise<T> {
  let failures = 0;
  for (;;) {
    const value = await tryOnce();
    if (value !== null) return value;
    const wait = Math.min(PAUSE_MAX_MS, PAUSE_FIRST_MS * 2 ** failures);
    failures += 1;
    if (failures <= 3 || failures % 10 === 0) {
      process.stderr.write(`main: ${label}; retrying in ${wait}ms (attempt ${failures})\n`);
    }
    await pause(wait);
  }
}

/** A request that dies on its own after CALL_TIMEOUT_MS. */
function timedFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
}

/**
 * Announce our port to the suite. Returns once the suite has accepted it
 * (200) or told us someone else got there first (409). A 400/405 is a
 * contract error and throws; anything else is retried.
 */
async function announcePort(port: number): Promise<void> {
  await untilDone('register not accepted yet', async () => {
    try {
      const res = await timedFetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) return true;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
      process.stderr.write(`main: register answered HTTP ${res.status}\n`);
      return null;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
      process.stderr.write(`main: register failed: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  });
}

/** Poll the suite until it reports {"done": true}. */
async function waitForSuite(): Promise<void> {
  await untilDone('suite not done yet', async () => {
    try {
      const res = await timedFetch(`${envOrigin}/done`);
      if (!res.ok) return null;
      const body = (await res.json()) as { done?: unknown };
      return body.done === true ? true : null;
    } catch {
      return null; // The suite is not answering yet; poll again.
    }
  });
}

/** Start the forge, hand it to the suite, and wait for the suite to finish. */
async function run(): Promise<void> {
  const forge = createApp();
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => resolve());
  });
  const bound = forge.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the forge did not bind an ephemeral TCP port');
  }
  process.stdout.write(`main: forge listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('main: registered; waiting for the suite to finish\n');

  await waitForSuite();
  forge.close();
  process.stdout.write('main: suite done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`main: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
