import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { createQueue } from "../extension/queue.js";
import { usdUnits } from "../extension/cost-store.js";

const unavailable = () => Object.assign(new Error("费用记录无法保存，未发起新的模型请求。"), { code: "COST_STORAGE_FAILED" });
const validId = value => typeof value === "string" && /^[\w-]{1,100}$/.test(value);

/** Native pipe accounting. Business cancellation never discards a charge. */
export class CostTracker {
  constructor({ settings, send, ackTimeoutMs = 8000, queryDelays = [1000, 3000, 10000], queryTimeoutMs = 10000 }) {
    Object.assign(this, { settings, send, ackTimeoutMs, queryDelays, queryTimeoutMs });
    this.sessionId = randomUUID();
    this.sequence = 0;
    this.pending = new Map();
    this.queries = new Set();
    this.controller = new AbortController();
    this.enqueue = createQueue();
    this.failed = false;
  }

  emit(event) {
    return this.enqueue(async () => {
      if (this.failed || this.controller.signal.aborted) throw unavailable();
      const sequence = ++this.sequence, packet = { type: "COST_EVENT", sessionId: this.sessionId, sequence, ...event };
      try {
        await new Promise((resolve, reject) => {
          const timers = [];
          const finish = error => { timers.forEach(clearTimeout); this.pending.delete(sequence); error ? reject(error) : resolve(); };
          this.pending.set(sequence, { taskId: event.taskId, finish });
          const send = () => { try { this.send(packet); } catch { finish(unavailable()); } };
          for (const factor of [.33, .66]) timers.push(setTimeout(send, this.ackTimeoutMs * factor));
          timers.push(setTimeout(() => finish(unavailable()), this.ackTimeoutMs));
          send();
        });
      } catch {
        this.failed = true;
        throw unavailable();
      }
    });
  }

  acknowledge({ sessionId, sequence, taskId, accepted }) {
    const pending = this.pending.get(sequence);
    if (sessionId !== this.sessionId || !pending || pending.taskId !== taskId || typeof accepted !== "boolean") return { acknowledged: false };
    pending.finish(accepted ? null : unavailable());
    return { acknowledged: true };
  }

  forRun({ taskId, roundId, shop }) {
    if (!validId(roundId)) return null; // Older clients do not enable accounting.
    const context = Object.freeze({ taskId, roundId, shop });
    return {
      begin: async model => {
        const ticket = { ...context, attemptId: randomUUID(), model };
        await this.emit({ ...ticket, phase: "started" });
        return ticket;
      },
      finish: async (ticket, { data, sent }) => {
        const amount = sent ? usdUnits(data?.usage?.cost) : "0";
        const generationId = typeof data?.id === "string" && data.id.length <= 200 ? data.id : null;
        await this.emit({ ...ticket, phase: amount === null ? "unknown" : "settled", amount, generationId });
        if (amount === null && generationId) this.query({ ...ticket, generationId, queryAttempts: 0 });
      },
    };
  }

  query(entry) {
    if (this.queries.has(entry.attemptId) || entry.queryAttempts >= 3 || !entry.generationId) return;
    this.queries.add(entry.attemptId);
    const run = async () => {
      for (let index = entry.queryAttempts; index < 3; index++) {
        await wait(this.queryDelays[index], undefined, { signal: this.controller.signal });
        await this.emit({ ...entry, phase: "unknown", queryAttempts: index + 1 });
        let amount = null;
        try {
          const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(entry.generationId)}`, {
            headers: { Authorization: `Bearer ${this.settings.apiKey}` },
            signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.queryTimeoutMs)]),
          });
          if (response.ok) amount = usdUnits((await response.json())?.data?.total_cost);
          else if ([401, 402, 403].includes(response.status)) {
            await this.emit({ ...entry, phase: "unknown", queryAttempts: 3 });
            return;
          }
        } catch { /* No price estimate or model retry can replace a missing bill. */ }
        if (amount !== null) {
          await this.emit({ ...entry, phase: "settled", amount, queryAttempts: index + 1 });
          return;
        }
      }
    };
    void run().catch(() => {}).finally(() => this.queries.delete(entry.attemptId));
  }

  reconcile(entries) {
    if (!Array.isArray(entries) || entries.length > 50) throw unavailable();
    for (const entry of entries) {
      if (![entry?.id, entry?.taskId, entry?.roundId].every(validId) || typeof entry.shop !== "string" || entry.shop.length > 300 ||
          typeof entry.model !== "string" || typeof entry.generationId !== "string" || entry.generationId.length > 200 ||
          !Number.isInteger(entry.queryAttempts) || entry.queryAttempts < 0 || entry.queryAttempts > 3) throw unavailable();
      this.query({ attemptId: entry.id, taskId: entry.taskId, roundId: entry.roundId, shop: entry.shop,
        model: entry.model, generationId: entry.generationId, queryAttempts: entry.queryAttempts });
    }
    return { accepted: true };
  }

  close() {
    this.controller.abort();
    for (const pending of this.pending.values()) pending.finish(unavailable());
  }
}
