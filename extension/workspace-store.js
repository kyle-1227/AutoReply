import { WORKSPACE_KEY, TASK_KEY, DRAFT_KEY, PRODUCTS_KEY, emptyTask } from "./model.js";
import { createQueue } from "./queue.js";

/** Serializes local writes so concurrent windows never replace each other's data. */
export class WorkspaceStore {
  constructor(storage) {
    this.storage = storage;
    this.data = { version: 2, records: {}, legacyImported: false };
    this.products = [];
    this.productRevision = 0;
    this.enqueue = createQueue();
  }

  async load() {
    const saved = await this.storage.get([WORKSPACE_KEY, PRODUCTS_KEY, TASK_KEY, "autoreply.products-revision.v2"]);
    if (saved[WORKSPACE_KEY]?.version === 2) this.data = saved[WORKSPACE_KEY];
    this.products = Array.isArray(saved[PRODUCTS_KEY]) ? saved[PRODUCTS_KEY] : [];
    this.productRevision = saved["autoreply.products-revision.v2"] || 0;
    this.legacy = saved[TASK_KEY];
  }

  saveRecord(record) {
    const copy = structuredClone(record);
    return this.enqueue(async () => {
      const next = { ...this.data, records: { ...this.data.records, [copy.id]: copy } };
      await this.storage.set({ [WORKSPACE_KEY]: next });
      this.data = next;
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

  editProduct(action, payload) {
    return this.enqueue(async () => {
      let next;
      if (action === "DELETE") {
        if (!this.products.some(item => item.id === payload.id)) throw new Error("这份产品资料已被删除。");
        next = this.products.filter(item => item.id !== payload.id);
      } else if (action === "SAVE") {
        const product = {
          id: payload.id || crypto.randomUUID(), name: String(payload.name || "").trim(),
          sku: String(payload.sku || "").trim(), details: String(payload.details || "").trim(),
          updatedAt: Date.now(),
        };
        if (!product.name || !product.details) throw new Error("请填写产品名称和产品资料。");
        const previous = this.products.find(item => item.id === product.id);
        product.updatedAt = Math.max(product.updatedAt, (previous?.updatedAt || 0) + 1);
        if (payload.id && !previous) throw new Error("这份产品资料已被删除，请重新添加。");
        if (previous && (previous.updatedAt || 0) !== (payload.previousUpdatedAt || 0)) {
          throw new Error("其他窗口已修改这份资料，请重新点击编辑后保存。");
        }
        if (product.sku && this.products.some(item => item.id !== product.id && item.sku.toLowerCase() === product.sku.toLowerCase())) {
          throw new Error("该产品编号 / SKU 已存在，请编辑已有资料或使用其他编号。");
        }
        next = previous ? this.products.map(item => item.id === product.id ? product : item) : [...this.products, product];
      } else throw new Error("无法识别产品资料操作。");
      const revision = this.productRevision + 1;
      await this.storage.set({ [PRODUCTS_KEY]: next, "autoreply.products-revision.v2": revision });
      this.products = next;
      this.productRevision = revision;
      return structuredClone(next);
    });
  }
}

export function createRecord(source) {
  return { id: crypto.randomUUID(), state: emptyTask(), draft: {}, productDraft: {}, source, updatedAt: Date.now() };
}
