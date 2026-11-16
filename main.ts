// Entry point: the lifecycle between this forge and the trial environment.
//
// The environment owns the trial. It starts this process, waits for it to
// announce the port it bound, drives the whole suite against that port, and
// finally tells the process the trial is over. This file does that dance and
// nothing else: the forge itself lives in app.ts, and the four surfaces it
// serves (git smart HTTP, REST v3, GraphQL, MCP) are built there.
//
// The order of operations, fixed by the environment's contract:
//
//   1. Read MAKEFUN_ENV_URL. It names the environment's origin. With no
//      origin there is nobody to talk to, so the process fails at once.
//   2. Build the server and bind port 0, letting the kernel choose a free
//      port. Port 8080 is never bound: the environment listens there.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The environment
//      records the address the request came from plus N and dials it from
//      then on. A 409 means some other process registered first; that is
//      not this process's problem, so it waits like any other.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//      The environment answers immediately either way, so this is a poll
//      with a pause between attempts, never a held-open request. A poll
//      that fails or times out is retried; the process never exits early.
//   5. Close the server and exit 0. The environment then stops and writes
//      the export the scorer reads.
//
// Only the server and the environment are imported: no package, no Node
// built-in beyond fetch and timers, no model call.

import { createApp } from './app.ts';

/** The environment's origin, with any trailing slashes stripped. */
const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

/** How long a single register or done request may run before it is dropped and retried. */
const REQUEST_TIMEOUT_MS = 30_000;
/** The pause before the first retry, and the longest pause between retries. */
const RETRY_FIRST_MS = 250;
const RETRY_LIMIT_MS = 2_000;

/** Wait `ms` milliseconds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pause before retry number `attempt`: it doubles from RETRY_FIRST_MS
 * and never passes RETRY_LIMIT_MS.
 */
function pauseBeforeRetry(attempt: number): number {
  return Math.min(RETRY_LIMIT_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Announce the bound port to the environment, retrying until it accepts.
 * A 200 means the registration landed; a 409 means another entry
 * registered first, which is fine. A 400 or 405 is a contract error and
 * ends the process; anything else (a network failure, another status) is
 * retried, since the environment may still be starting.
 */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(pauseBeforeRetry(attempt));
  }
}

/** Ask GET /done until the environment answers {"done": true}; never return before that. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_ORIGIN}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment is not answering yet, or the poll timed out: it is
      // not done, so poll again.
    }
    await pause(pauseBeforeRetry(attempt));
  }
}

/** Bind the port, announce it, then wait for the environment: the whole life of the process. */
async function run(): Promise<void> {
  if (ENV_ORIGIN === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
