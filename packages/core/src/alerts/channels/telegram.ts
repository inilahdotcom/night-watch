import { createLogger } from "../../logger.ts"
import type {
  DeliveryResult,
  NotificationChannel,
  RenderedAlert,
} from "../types.ts"

// Telegram channel.
//
// Exists mainly as insurance. WhatsApp is reachable only through Baileys —
// an unofficial client on a session Meta can invalidate at any moment — and
// when that happens the primary alert path dies silently. Telegram's Bot API
// is official, free, works in groups, and is a plain HTTPS POST, so it costs
// one file and no dependency to stop having a single point of failure.
//
// Sends `htmlBody`, not `textBody`: WhatsApp's `*bold*` renders as literal
// asterisks on Telegram.

const DEFAULT_ENDPOINT = "https://api.telegram.org"

export interface TelegramChannelOptions {
  botToken?: string
  chatId?: string
  /** Overridable for tests. */
  endpoint?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

interface TelegramResponse {
  ok: boolean
  description?: string
  error_code?: number
}

export function createTelegramChannel(
  opts: TelegramChannelOptions,
): NotificationChannel {
  const log = createLogger("telegram")
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000

  return {
    name: "telegram",
    // Same reasoning as WhatsApp: a group message buzzes every phone in it.
    mutedByQuietHours: true,

    isReady(): boolean {
      return Boolean(opts.botToken && opts.chatId)
    },

    async send(alert: RenderedAlert): Promise<DeliveryResult> {
      if (!opts.botToken || !opts.chatId) {
        return { ok: false, detail: "telegram not configured" }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(
          `${endpoint}/bot${opts.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              chat_id: opts.chatId,
              text: alert.htmlBody,
              parse_mode: "HTML",
              // Alert bodies carry no links worth previewing, and a preview
              // card would push the actual message off a phone screen.
              disable_web_page_preview: true,
              // Recoveries and warnings should not buzz; a firing critical
              // should. Mirrors the push channel's urgency split.
              disable_notification:
                alert.status === "resolved" || alert.severity !== "critical",
            }),
          },
        )

        const payload = (await response
          .json()
          .catch(() => null)) as TelegramResponse | null

        if (!response.ok || !payload?.ok) {
          const detail =
            payload?.description ?? `HTTP ${response.status}`
          log.warn({ alertId: alert.id, detail }, "telegram send failed")
          return { ok: false, detail }
        }
        return { ok: true, detail: "sent" }
      } catch (err) {
        const name = (err as { name?: string }).name
        const detail =
          name === "AbortError" || name === "TimeoutError"
            ? "timeout"
            : (err as Error).message || String(err)
        log.warn({ alertId: alert.id, detail }, "telegram send failed")
        return { ok: false, detail }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
