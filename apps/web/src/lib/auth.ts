import { createMiddleware } from "@tanstack/react-start"

// Dashboard auth — the client-safe half.
//
// This module is imported by server-fns.ts, which the client bundle pulls in,
// so it must not statically import anything server-only. The session helpers
// live in auth.server.ts and are reached through a dynamic import inside the
// middleware's server callback, which never runs — and never resolves — on
// the client.

/**
 * Gate for every data-bearing server function.
 *
 * The gate lives on the SERVER FUNCTIONS, not on the routes. server-fns.ts is
 * the entire data surface of the dashboard, and a guarded UI in front of open
 * server functions leaks everything to anyone who POSTs the RPC endpoint
 * directly. Guarding the functions makes the route guard cosmetic — which is
 * the correct order of trust.
 *
 * Throws a bare 401 Response rather than an Error so an unauthenticated fetch
 * gets a status code it can act on instead of a stack trace it has to parse.
 */
export const authMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    const { isAuthed } = await import("./auth.server")
    if (!(await isAuthed())) {
      throw new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain" },
      })
    }
    return next()
  },
)
