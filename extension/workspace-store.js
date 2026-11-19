import { WORKSPACE_KEY, TASK_KEY, DRAFT_KEY, RETENTION_MS, emptyTask, isFinished, holdsWindow, hasFailedReviews } from "./model.js";
import { createQueue } from "./queue.js";

export class WorkspaceStore {
  constructor(storage) {
    this.storage = storage;
    this.data = { version: 2, records: {}, legacyImported: false };
    this.enqueue = createQueue();
  }

  async load() {
    const saved = await this.storage.get([WORKSPACE_KEY, TASK_KEY]);
    if (saved[WORKSPACE_KEY]?.version === 2) this.data = saved[WORKSPACE_KEY];
    this.legacy = saved[TASK_KEY];
    if (!this.data.retentionMigratedAt) {
      this.data.retentionMigratedAt = Date.now();
      for (const record of Object.values(this.data.records)) {
        if (isFinished(record.state) || record.state.status === "idle") record.expiresAt = Date.now() + RETENTION_MS;
        this.stripOldPrompts(record);
      }
      if (this.legacy) this.stripOldPrompts({ state: this.legacy });
      this.data.legacyExpiresAt = Date.now() + RETENTION_MS;
      await this.storage.set({ [WORKSPACE_KEY]: this.data, [TASK_KEY]: this.legacy || null });
    }
    await this.storage.remove?.(["autoreply.generation.v1", "autoreply.backend.v1"]);
    await this.cleanup();
  }

  stripOldPrompts(record) {
    for (const review of record.state.reviews || []) {
      const old = review.generationRecord;
      if (!old) continue;
      if (old.prompt) old.promptVersion = old.prompt.version;
      if (old.productContext) old.product = { id: old.productContext.documentId, version: old.productContext.version };
      delete old.prompt; delete old.productContext; delete old.replyPolicy;
    }
  }

  async persist(next) {
    await this.storage.set({ [WORKSPACE_KEY]: next });
    this.data = next;
  }

  saveRecord(record) {
    const copy = structuredClone(record);
    return this.enqueue(async () => {
      const previous = this.data.records[copy.id];
      if (hasFailedReviews(copy.state) || holdsWindow(copy.state)) { copy.expiresAt = null; delete copy.state.expiresAt; }
      else if (isFinished(copy.state)) copy.expiresAt = (hasFailedReviews(previous?.state) ? null : copy.state.expiresAt) ||
        (isFinished(previous?.state) && previous.expiresAt) || Date.now() + RETENTION_MS;
      else copy.expiresAt = previous?.state.status === "idle" ? copy.expiresAt : Date.now() + RETENTION_MS;
      this.stripOldPrompts(copy);
      await this.persist({ ...this.data, records: { ...this.data.records, [copy.id]: copy } });
      return copy.expiresAt;
    });
  }

  cleanup(now = Date.now()) {
    return this.enqueue(async () => {
      let changed = false;
      const expired = [];
      const next = { ...this.data, records: { ...this.data.records } };
      for (let record of Object.values(this.data.records)) {
        if ((record.expiresAt || record.state.expiresAt) && hasFailedReviews(record.state)) {
          record = { ...record, expiresAt: null, state: { ...record.state } };
          delete record.state.expiresAt;
          next.records[record.id] = record;
          changed = true;
        }
        if (record.expiresAt && record.expiresAt <= now) {
          expired.push(record.id);
          delete next.records[record.id];
          changed = true;
        } else if (record.draftUpdatedAt && record.draftUpdatedAt + RETENTION_MS <= now) {
          const copy = { ...record, draft: {}, productDraft: {} };
          delete copy.draftUpdatedAt;
          next.records[record.id] = copy;
          changed = true;
        }
      }
      if (this.data.legacyExpiresAt <= now) {
        await this.storage.remove?.([TASK_KEY, DRAFT_KEY, "autoreply.product-draft.v1"]);
        this.legacy = null;
        delete next.legacyExpiresAt;
        changed = true;
      }
      if (changed) await this.persist(next);
      return expired;
    });
  }

  hasLegacy() {
    return !this.data.legacyImported && Array.isArray(this.legacy?.reviews) && this.legacy.reviews.length > 0;
  }

  importLegacy(record) {
    return this.enqueue(async () => {
      if (!this.hasLegacy()) throw new Error("旧版记录已恢复，或没有可恢复的记录。");
      const saved = await this.storage.get([DRAFT_KEY, "autoreply.product-draft.v1"]);
      const state = structuredClone(this.legacy);
      state.reviews.forEach(review => {
        if (review.status === "processing") { review.status = "pending"; review.reply = ""; }
      });
      Object.assign(state, { currentId: null, phase: 0, nextStepAt: null, status: "paused", generation: 0, error: "" });
      const imported = { ...record, state, draft: saved[DRAFT_KEY] || {}, productDraft: saved["autoreply.product-draft.v1"] || {} };
      await this.persist({ ...this.data, legacyImported: true, records: { ...this.data.records, [record.id]: imported } });
      return structuredClone(imported);
    });
  }

}

export function createRecord(source) {
  return { id: crypto.randomUUID(), state: emptyTask(), draft: {}, productDraft: {}, source, updatedAt: Date.now(), expiresAt: Date.now() + RETENTION_MS };
}
