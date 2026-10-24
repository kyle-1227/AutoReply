import { WORKSPACE_KEY, TASK_KEY, DRAFT_KEY, RETENTION_MS, emptyTask, isFinished, holdsWindow } from "./model.js";
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

  saveRecord(record) {
    const copy = structuredClone(record);
    return this.enqueue(async () => {
      const previous = this.data.records[copy.id];
      if (isFinished(copy.state)) copy.expiresAt = copy.state.expiresAt ||
        (isFinished(previous?.state) && previous.expiresAt) || Date.now() + RETENTION_MS;
      else if (holdsWindow(copy.state)) { copy.expiresAt = null; delete copy.state.expiresAt; }
      else copy.expiresAt = previous?.state.status === "idle" ? copy.expiresAt : Date.now() + RETENTION_MS;
      this.stripOldPrompts(copy);
      this.data = { ...this.data, records: { ...this.data.records, [copy.id]: copy } };
      await this.storage.set({ [WORKSPACE_KEY]: this.data });
      return copy.expiresAt;
    });
  }

  cleanup(now = Date.now()) {
    return this.enqueue(async () => {
      const expired = Object.values(this.data.records).filter(record => record.expiresAt && record.expiresAt <= now).map(record => record.id);
      for (const id of expired) delete this.data.records[id];
      let changed = expired.length > 0;
      for (const record of Object.values(this.data.records)) {
        if (record.draftUpdatedAt && record.draftUpdatedAt + RETENTION_MS <= now) {
          record.draft = {}; record.productDraft = {}; delete record.draftUpdatedAt; changed = true;
        }
      }
      if (this.data.legacyExpiresAt <= now) {
        this.legacy = null;
        await this.storage.remove?.([TASK_KEY, DRAFT_KEY, "autoreply.product-draft.v1"]);
        delete this.data.legacyExpiresAt;
        changed = true;
      }
      if (changed) await this.storage.set({ [WORKSPACE_KEY]: this.data });
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
      const next = { ...this.data, legacyImported: true, records: { ...this.data.records, [record.id]: imported } };
      await this.storage.set({ [WORKSPACE_KEY]: next });
      this.data = next;
      return structuredClone(imported);
    });
  }

}

export function createRecord(source) {
  return { id: crypto.randomUUID(), state: emptyTask(), draft: {}, productDraft: {}, source, updatedAt: Date.now(), expiresAt: Date.now() + RETENTION_MS };
}
