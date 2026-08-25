import { useSession } from "@tanstack/react-start/server"
import { timingSafeEqual } from "node:crypto"
import { loadEnv } from "@night-watch/core"

// Dashboard auth — the server half.
//
// Split from auth.ts because `@tanstack/react-start/server` may not appear in
// the client bundle, and auth.ts exports the middleware that client code
// imports. The build enforces this; the dev server does not, so the violation
// only surfaces in `vite build`.
//
// Off by default: with DASHBOARD_PASSWORD unset every server function behaves
// exactly as it did before this file existed. That keeps `bun run dev:web` a
// one-command experience and matches how every other credential in this app
// degrades (missing config disables the feature, it never throws at boot).
//
// The gate lives on the SERVER FUNCTIONS, not on the routes. server-fns.ts is
// the entire data surface of the dashboard, and a guarded UI in front of open
// server functions leaks everything to anyone who POSTs the RPC endpoint
// directly. Guarding the functions makes the route guard cosmetic — which is
// the correct order of trust.
//
// Session sealing is TanStack Start's own `useSession`: encrypted + signed,
// HttpOnly, SameSite=Lax. Hand-rolling an HMAC cookie here would add code
// without adding security.

const SESSION_NAME = "nw_session"
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14 // two weeks

interface SessionData {
  authedAt?: number
}

/** True when a password is configured. When false, everything is public. */
export function authEnabled(): boolean {
  return Boolean(loadEnv().DASHBOARD_PASSWORD)
}

function sessionConfig() {
  const env = loadEnv()
  // Only reachable when authEnabled() — loadEnv() refuses to start with a
  // password but no secret, so this cast is guarded by config validation.
  return {
    name: SESSION_NAME,
    password: env.SESSION_SECRET!,
    maxAge: MAX_AGE_SECONDS,
    cookie: { sameSite: "lax", httpOnly: true, path: "/" } as const,
  }
}

/** Whether the caller presented a valid session. Always true when auth is off. */
export async function isAuthed(): Promise<boolean> {
  if (!authEnabled()) return true
  const session = await useSession<SessionData>(sessionConfig())
  return typeof session.data.authedAt === "number"
}

/**
 * Compare against the configured password without leaking length or content
 * through timing. `timingSafeEqual` throws on length mismatch, so both sides
 * are hashed to a fixed width first.
 */
function passwordMatches(candidate: string): boolean {
  const expected = loadEnv().DASHBOARD_PASSWORD
  if (!expected) return false
  const a = new Bun.CryptoHasher("sha256").update(candidate).digest()
  const b = new Bun.CryptoHasher("sha256").update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Establishes a session. Returns false on a wrong password. */
export async function signIn(password: string): Promise<boolean> {
  if (!authEnabled()) return true
  if (!passwordMatches(password)) return false
  const session = await useSession<SessionData>(sessionConfig())
  await session.update({ authedAt: Math.floor(Date.now() / 1000) })
  return true
}

export async function signOut(): Promise<void> {
  if (!authEnabled()) return
  const session = await useSession<SessionData>(sessionConfig())
  await session.clear()
}
