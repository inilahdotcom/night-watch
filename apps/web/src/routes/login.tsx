import { createFileRoute, redirect, useRouter } from "@tanstack/react-router"
import { useState } from "react"
import { doSignIn, fetchAuthState } from "../lib/auth-fns"
import { Button } from "../components/ui/button"

export const Route = createFileRoute("/login")({
  // Nothing to log into when auth is off, and no reason to show the form to
  // someone who already has a session.
  beforeLoad: async () => {
    const state = await fetchAuthState()
    if (!state.enabled || state.authed) throw redirect({ to: "/" })
  },
  component: LoginPage,
})

function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const result = await doSignIn({ data: { password } })
      if (result.ok) {
        await router.invalidate()
        await router.navigate({ to: "/" })
      } else {
        setError("That password is not right.")
        setPassword("")
      }
    } catch {
      setError("Could not reach the server. Is the web process still running?")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-sm flex-col justify-center px-5">
      <h1 className="text-2xl">Night Watch</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        This dashboard is password protected.
      </p>

      <form onSubmit={onSubmit} className="mt-6">
        <label htmlFor="password" className="mono text-muted-foreground text-[10px] tracking-widest uppercase">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="border-border bg-card focus-visible:border-ring focus-visible:ring-ring/50 mt-2 w-full rounded-xl border px-4 py-3 text-sm outline-none focus-visible:ring-3"
        />

        {error && (
          <p role="alert" className="text-status-critical mt-3 text-sm">
            {error}
          </p>
        )}

        <Button
          type="submit"
          size="lg"
          disabled={busy || password.length === 0}
          className="mt-4 w-full"
        >
          {busy ? "Checking…" : "Enter"}
        </Button>
      </form>
    </main>
  )
}
