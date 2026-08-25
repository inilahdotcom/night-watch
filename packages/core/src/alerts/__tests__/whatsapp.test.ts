import { beforeEach, describe, expect, it } from "bun:test";
import {
  createWhatsAppChannel,
  type WhatsAppAdapter,
  type WhatsAppSocketState,
} from "../channels/whatsapp.ts";
import type { RenderedAlert } from "../types.ts";

// Stub adapter — hand-drives connect/disconnect/logged-out and records sends.
class StubAdapter implements WhatsAppAdapter {
  connected = true;
  sends: Array<{ jid: string; text: string }> = [];
  private cbs: Array<(s: WhatsAppSocketState) => void> = [];
  nextError: string | null = null;

  isConnected(): boolean {
    return this.connected;
  }
  async sendText(jid: string, text: string): Promise<void> {
    if (this.nextError) {
      const msg = this.nextError;
      this.nextError = null;
      throw new Error(msg);
    }
    this.sends.push({ jid, text });
  }
  onStateChange(cb: (s: WhatsAppSocketState) => void): () => void {
    this.cbs.push(cb);
    return () => {
      this.cbs = this.cbs.filter((x) => x !== cb);
    };
  }
  fire(state: WhatsAppSocketState): void {
    for (const cb of this.cbs) cb(state);
  }
}

// Injectable clock + sleep so pacing tests don't burn wall-clock time.
class FakeClock {
  t = 1_000_000;
  sleepCalls: number[] = [];
  now = (): number => this.t;
  sleep = async (ms: number): Promise<void> => {
    this.sleepCalls.push(ms);
    this.t += ms;
  };
  advance(ms: number): void {
    this.t += ms;
  }
}

let alertCounter = 0;
function alert(text = "hello"): RenderedAlert {
  alertCounter += 1;
  return {
    id: alertCounter,
    fingerprint: `fp-${alertCounter}`,
    monitor: "example",
    type: "traffic",
    severity: "warning",
    status: "firing",
    title: "test",
    body: "b",
    meta: {},
    startedAt: 0,
    resolvedAt: null,
    htmlBody: "<b>rendered</b>",
    textBody: text,
    pushPayload: {},
  };
}

beforeEach(() => {
  alertCounter = 0;
});

describe("whatsapp channel — happy path", () => {
  it("sends immediately when the socket is connected", async () => {
    const adapter = new StubAdapter();
    const clock = new FakeClock();
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
      now: clock.now,
      sleep: clock.sleep,
    });
    const r = await ch.send(alert("one"));
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("sent");
    expect(adapter.sends).toEqual([{ jid: "grp@g.us", text: "one" }]);
  });
});

describe("whatsapp channel — pacing", () => {
  it("waits paceMs between two rapid sends", async () => {
    const adapter = new StubAdapter();
    const clock = new FakeClock();
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
      paceMs: 1200,
      now: clock.now,
      sleep: clock.sleep,
    });
    await ch.send(alert("a"));
    // Fake clock hasn't advanced — no delay yet.
    await ch.send(alert("b"));
    // Second send should have paced by 1200ms.
    expect(clock.sleepCalls).toContain(1200);
    expect(adapter.sends.map((s) => s.text)).toEqual(["a", "b"]);
  });

  it("does not delay when enough time has already passed", async () => {
    const adapter = new StubAdapter();
    const clock = new FakeClock();
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
      paceMs: 1200,
      now: clock.now,
      sleep: clock.sleep,
    });
    await ch.send(alert());
    clock.advance(2000); // longer than paceMs
    await ch.send(alert());
    // First send may have paced (no — nothing before it). Second shouldn't.
    expect(clock.sleepCalls).toEqual([]);
  });
});

describe("whatsapp channel — queueing when disconnected", () => {
  it("queues sends while disconnected and flushes on reconnect", async () => {
    const adapter = new StubAdapter();
    adapter.connected = false;
    const clock = new FakeClock();
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
      now: clock.now,
      sleep: clock.sleep,
    });
    await ch.send(alert("q1"));
    await ch.send(alert("q2"));
    expect(ch.queueSize()).toBe(2);
    expect(adapter.sends).toEqual([]);

    adapter.connected = true;
    adapter.fire({ kind: "connected" });
    // Drain is async; wait a microtask.
    await new Promise((r) => setImmediate(r));
    expect(adapter.sends.map((s) => s.text)).toEqual(["q1", "q2"]);
    expect(ch.queueSize()).toBe(0);
  });

  it("bounds the queue at maxQueue by dropping the oldest message", async () => {
    const adapter = new StubAdapter();
    adapter.connected = false;
    const clock = new FakeClock();
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
      maxQueue: 3,
      now: clock.now,
      sleep: clock.sleep,
    });
    await ch.send(alert("old-1"));
    await ch.send(alert("old-2"));
    await ch.send(alert("old-3"));
    await ch.send(alert("new"));
    expect(ch.queueSize()).toBe(3);

    adapter.connected = true;
    adapter.fire({ kind: "connected" });
    await new Promise((r) => setImmediate(r));

    // "old-1" was dropped; the remaining three are in FIFO order.
    expect(adapter.sends.map((s) => s.text)).toEqual([
      "old-2",
      "old-3",
      "new",
    ]);
  });
});

describe("whatsapp channel — logged out state", () => {
  it("becomes not-ready and refuses new sends until reconnected", async () => {
    const adapter = new StubAdapter();
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
    });
    expect(ch.isReady()).toBe(true);

    adapter.fire({ kind: "logged-out", reason: "device removed" });
    expect(ch.isReady()).toBe(false);

    const r = await ch.send(alert("x"));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/logged out/);
    expect(adapter.sends).toEqual([]);
  });

  it("recovers after a successful reconnect", async () => {
    const adapter = new StubAdapter();
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
    });
    adapter.fire({ kind: "logged-out", reason: "device removed" });
    expect(ch.isReady()).toBe(false);
    adapter.fire({ kind: "connected" });
    expect(ch.isReady()).toBe(true);
  });
});

describe("whatsapp channel — recover from a failed send", () => {
  it("queues the message when sendText throws mid-flight", async () => {
    const adapter = new StubAdapter();
    adapter.nextError = "socket write failed";
    const ch = createWhatsAppChannel({
      adapter,
      groupJid: "grp@g.us",
    });
    const r = await ch.send(alert("boom"));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/socket write failed/);
    expect(ch.queueSize()).toBe(1);
  });
});
