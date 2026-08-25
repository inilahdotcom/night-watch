import { describe, expect, it } from "bun:test"
import { createTelegramChannel } from "../channels/telegram.ts"
import type { RenderedAlert } from "../types.ts"

function alert(overrides: Partial<RenderedAlert> = {}): RenderedAlert {
  return {
    id: 1,
    fingerprint: "m:traffic:spike",
    monitor: "m",
    type: "traffic",
    severity: "warning",
    status: "firing",
    title: "Traffic spike",
    body: "Requests up 4x",
    meta: {},
    startedAt: 1_000,
    resolvedAt: null,
    textBody: "*Traffic spike*",
    htmlBody: "<b>Traffic spike</b>",
    pushPayload: {},
    ...overrides,
  }
}

function okFetch(capture: { url?: string; body?: unknown }) {
  return (async (url: string, init?: RequestInit) => {
    capture.url = url
    capture.body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
}

describe("telegram channel — readiness", () => {
  it("is not ready without credentials, and never throws at construction", () => {
    expect(createTelegramChannel({}).isReady()).toBe(false)
    expect(createTelegramChannel({ botToken: "t" }).isReady()).toBe(false)
    expect(createTelegramChannel({ chatId: "c" }).isReady()).toBe(false)
  })

  it("is ready once both are present", () => {
    expect(
      createTelegramChannel({ botToken: "t", chatId: "c" }).isReady(),
    ).toBe(true)
  })

  it("participates in quiet hours, like WhatsApp", () => {
    expect(createTelegramChannel({}).mutedByQuietHours).toBe(true)
  })
})

describe("telegram channel — sending", () => {
  it("posts htmlBody with HTML parse mode, not the WhatsApp text", async () => {
    const cap: { url?: string; body?: any } = {}
    const ch = createTelegramChannel({
      botToken: "TOKEN",
      chatId: "-100123",
      endpoint: "https://tg.test",
      fetchImpl: okFetch(cap),
    })

    const r = await ch.send(alert())
    expect(r.ok).toBe(true)
    expect(cap.url).toBe("https://tg.test/botTOKEN/sendMessage")
    expect(cap.body.chat_id).toBe("-100123")
    expect(cap.body.parse_mode).toBe("HTML")
    // The literal-asterisk bug this channel exists to avoid.
    expect(cap.body.text).toBe("<b>Traffic spike</b>")
    expect(cap.body.text).not.toContain("*")
  })

  it("buzzes for a firing critical and stays silent otherwise", async () => {
    const cap: { body?: any } = {}
    const ch = createTelegramChannel({
      botToken: "T",
      chatId: "C",
      fetchImpl: okFetch(cap),
    })

    await ch.send(alert({ severity: "critical" }))
    expect(cap.body.disable_notification).toBe(false)

    await ch.send(alert({ severity: "warning" }))
    expect(cap.body.disable_notification).toBe(true)

    await ch.send(alert({ severity: "critical", status: "resolved" }))
    expect(cap.body.disable_notification).toBe(true)
  })

  it("reports the API's own error description rather than a bare status", async () => {
    const ch = createTelegramChannel({
      botToken: "T",
      chatId: "C",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ ok: false, error_code: 403, description: "bot was blocked by the user" }),
          { status: 403, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    })

    const r = await ch.send(alert())
    expect(r.ok).toBe(false)
    expect(r.detail).toBe("bot was blocked by the user")
  })

  it("returns a failure instead of throwing when the network is down", async () => {
    const ch = createTelegramChannel({
      botToken: "T",
      chatId: "C",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })

    const r = await ch.send(alert())
    expect(r.ok).toBe(false)
    expect(r.detail).toBe("ECONNREFUSED")
  })

  it("reports a timeout as a timeout", async () => {
    const ch = createTelegramChannel({
      botToken: "T",
      chatId: "C",
      fetchImpl: (async () => {
        const err = new Error("aborted")
        err.name = "AbortError"
        throw err
      }) as unknown as typeof fetch,
    })

    const r = await ch.send(alert())
    expect(r.ok).toBe(false)
    expect(r.detail).toBe("timeout")
  })

  it("declines to send when unconfigured rather than calling the API", async () => {
    let called = false
    const ch = createTelegramChannel({
      fetchImpl: (async () => {
        called = true
        return new Response("{}")
      }) as unknown as typeof fetch,
    })

    const r = await ch.send(alert())
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
})
