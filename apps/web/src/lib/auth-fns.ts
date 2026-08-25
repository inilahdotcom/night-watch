import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

// Deliberately NOT in server-fns.ts: every function in that file carries
// `authMiddleware`, and the three below are the ones that have to answer
// before a session exists. Keeping them in a separate module means the gate
// can never be removed from a data function by accident, and can never be
// applied to the login function by accident.

export const fetchAuthState = createServerFn({
  method: "GET",
  strict: { output: false },
}).handler(async () => {
  const { authEnabled, isAuthed } = await import("./auth.server")
  return { enabled: authEnabled(), authed: await isAuthed() }
})

export const doSignIn = createServerFn({ method: "POST" })
  .validator(z.object({ password: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const { signIn } = await import("./auth.server")
    const ok = await signIn(data.password)
    // Returned rather than thrown: a wrong password is an expected outcome of
    // a login form, not an exceptional one, and the form needs to re-render
    // with a message rather than land on an error boundary.
    return { ok }
  })

export const doSignOut = createServerFn({ method: "POST" }).handler(async () => {
  const { signOut } = await import("./auth.server")
  await signOut()
  return { ok: true }
})
