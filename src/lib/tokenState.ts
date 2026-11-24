import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Whether the API turned down the caller's token during one remote request. The HTTP layer
 * trusts a token it checked a moment ago without asking again (see `http.ts`), so a tool call
 * that hits a 401 must be able to say so: the next request then checks again and answers the
 * 401 that sends the client back to sign in.
 */
const store = new AsyncLocalStorage<{ rejected: boolean }>();

/** Run `fn`, and report whether any API call inside it was refused as unauthorised. */
export async function watchTokenRejection(fn: () => Promise<void>): Promise<boolean> {
  const state = { rejected: false };
  await store.run(state, fn);
  return state.rejected;
}

/** Called by the API client on a 401. Outside a watched request it does nothing. */
export function noteTokenRejected(): void {
  const state = store.getStore();
  if (state) state.rejected = true;
}
