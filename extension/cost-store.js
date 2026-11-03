import { shopKey } from "./product-catalog.js";
import { createQueue } from "./queue.js";

export const COSTS_KEY = "autoreply.costs.v1";
const COST_STORAGE_VERSION = 1;
const ID = /^[\w-]{1,100}$/;
const amount = value => typeof value === "string" && /^\d{1,40}$/.test(value);
const invalid = () => Object.assign(new Error("费用记录无法保存或校验失败，未发起新的模型请求。"), { code: "COST_STORAGE_FAILED" });
const blank = () => ({ amount: "0", pending: 0, unknown: 0 });

// JSON carries integer picodollars as strings; no floating-point accumulation.
export function usdUnits(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const fixed = value.toFixed(12);
  return /^\d+\.\d{12}$/.test(fixed) ? BigInt(fixed.replace(".", "")).toString() : null;
}

export function formatUsd(value) {
  const units = BigInt(value || "0");
  if (units > 0n && units < 1000000n) return "<$0.000001";
  const micros = (units + 500000n) / 1000000n;
  return `$${(micros / 1000000n).toLocaleString("en-US")}.${String(micros % 1000000n).padStart(6, "0")}`;
}

export function formatCost(summary) {
  if (!summary) return "—";
  const states = [summary.pending ? `${summary.pending} 笔计费中` : "", summary.unknown ? `${summary.unknown} 笔待确认` : ""].filter(Boolean);
  return [summary.amount !== "0" || !states.length ? formatUsd(summary.amount) : "", ...states].filter(Boolean).join(" · ");
}

/** One writer per browser profile. Amounts never depend on review retention. */
export class CostStore {
  constructor(storage, { now = Date.now, onChange = () => {} } = {}) {
    Object.assign(this, { storage, now, onChange });
    this.enqueue = createQueue();
    this.data = { version: COST_STORAGE_VERSION, revision: 0, enabledAt: null, sessions: {}, current: {}, rounds: {}, shops: {}, attempts: {} };
  }

  async load() {
    const saved = (await this.storage.get(COSTS_KEY))[COSTS_KEY];
    if (saved) {
      if (saved.version !== COST_STORAGE_VERSION) throw invalid();
      this.data = saved;
    }
    // A previous native pipe cannot survive a background/browser restart.
    await this.change(next => {
      let changed = false;
      for (const row of Object.values(next.attempts)) if (row.status === "pending") { row.status = "unknown"; changed = true; }
      for (const session of Object.values(next.sessions)) if (!session.closed) { session.closed = true; changed = true; }
      return changed;
    });
  }

  change(edit) {
    return this.enqueue(async () => {
      const next = structuredClone(this.data);
      if (edit(next) === false) return;
      next.revision++;
      try { await this.storage.set({ [COSTS_KEY]: next }); }
      catch { throw invalid(); }
      this.data = next;
      try { this.onChange(); } catch { /* UI notifications do not roll back persisted accounting. */ }
    });
  }

  async activate(sessionId) {
    if (!ID.test(sessionId || "")) throw invalid();
    await this.change(next => {
      next.enabledAt ??= this.now();
      next.sessions[sessionId] ??= { sequence: 0, closed: false };
      next.sessions[sessionId].closed = false;
    });
  }

  async ensureRound(taskId, source, epoch = 0) {
    const shop = shopKey(source);
    const current = this.data.rounds[this.data.current[taskId]];
    if (current?.shop === shop && (current.epoch || 0) === epoch) return current.id;
    const id = crypto.randomUUID();
    await this.change(next => {
      // Concurrent starts share the profile's serialized writer.
      const existing = next.rounds[next.current[taskId]];
      if (existing?.shop === shop && (existing.epoch || 0) === epoch) return false;
      next.current[taskId] = id;
      next.rounds[id] = { id, taskId, shop, epoch, startedAt: this.now(), amount: "0" };
      next.shops[shop] ??= { amount: "0" };
    });
    return this.data.current[taskId];
  }

  reset(taskId) {
    return this.change(next => { if (!next.current[taskId]) return false; delete next.current[taskId]; });
  }

  receive(event) {
    return this.change(next => {
      const session = next.sessions[event?.sessionId];
      if (!session || session.closed || !Number.isSafeInteger(event.sequence) || event.sequence < 1) throw invalid();
      if (event.sequence <= session.sequence) return false;
      if (event.sequence !== session.sequence + 1 || !ID.test(event.attemptId || "")) throw invalid();
      const round = next.rounds[event.roundId];
      if (!round || round.taskId !== event.taskId || round.shop !== event.shop || !["started", "unknown", "settled"].includes(event.phase)) throw invalid();
      let row = next.attempts[event.attemptId];
      if (event.phase === "started") {
        if (row) throw invalid();
        row = next.attempts[event.attemptId] = { id: event.attemptId, sessionId: event.sessionId, taskId: event.taskId,
          roundId: event.roundId, shop: event.shop, model: event.model, status: "pending", generationId: null, queryAttempts: 0, amount: null };
      } else {
        if (!row || row.roundId !== event.roundId || row.shop !== event.shop || row.taskId !== event.taskId) throw invalid();
        if (row.status === "settled") {
          if (event.phase !== "settled" || event.amount !== row.amount) throw invalid();
        } else if (event.phase === "settled") {
          if (!amount(event.amount)) throw invalid();
          row.status = "settled"; row.amount = event.amount;
          round.amount = (BigInt(round.amount) + BigInt(event.amount)).toString();
          next.shops[row.shop].amount = (BigInt(next.shops[row.shop].amount) + BigInt(event.amount)).toString();
        } else row.status = "unknown";
      }
      if (typeof event.generationId === "string" && event.generationId.length <= 200) row.generationId = event.generationId;
      if (Number.isInteger(event.queryAttempts) && event.queryAttempts >= row.queryAttempts && event.queryAttempts <= 3) row.queryAttempts = event.queryAttempts;
      session.sequence = event.sequence;
    });
  }

  disconnected(sessionId) {
    return this.change(next => {
      const session = next.sessions[sessionId];
      if (!session || session.closed) return false;
      session.closed = true;
      for (const row of Object.values(next.attempts)) if (row.sessionId === sessionId && row.status === "pending") row.status = "unknown";
    });
  }

  unresolved() {
    return Object.values(this.data.attempts).filter(row => row.status === "unknown" && row.generationId && row.queryAttempts < 3).map(row => structuredClone(row));
  }

  snapshot(taskId, source, epoch = 0) {
    const shop = source && this.data.enabledAt ? shopKey(source) : null;
    const current = this.data.rounds[this.data.current[taskId]];
    const round = current?.shop === shop && (current.epoch || 0) === epoch ? current : null;
    const base = { revision: this.data.revision, enabledAt: this.data.enabledAt, taskId, epoch, roundId: round?.id || null, shop };
    if (!shop) return { ...base, task: null, total: null };
    const task = { ...blank(), amount: round?.amount || "0" };
    const total = { ...blank(), amount: this.data.shops[shop]?.amount || "0" };
    for (const row of Object.values(this.data.attempts)) {
      if (row.shop !== shop || row.status === "settled") continue;
      const field = row.status === "pending" ? "pending" : "unknown";
      total[field]++;
      if (row.roundId === round?.id) task[field]++;
    }
    return { ...base, task, total, startedAt: round?.startedAt || this.data.enabledAt };
  }

  cleanup(taskIds) {
    const retained = new Set(taskIds);
    return this.change(next => {
      let changed = false;
      for (const [id, round] of Object.entries(next.rounds)) {
        const rows = Object.values(next.attempts).filter(row => row.roundId === id);
        if ((retained.has(round.taskId) && next.current[round.taskId] === id) || rows.some(row => row.status !== "settled")) continue;
        for (const row of rows) delete next.attempts[row.id];
        if (next.current[round.taskId] === id) delete next.current[round.taskId];
        delete next.rounds[id]; changed = true;
      }
      for (const [id, session] of Object.entries(next.sessions)) if (session.closed && !Object.values(next.attempts).some(row => row.sessionId === id && row.status !== "settled")) {
        delete next.sessions[id]; changed = true;
      }
      return changed;
    });
  }
}
