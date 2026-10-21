import { WORKSPACE_KEY, TASK_KEY, DRAFT_KEY, PRODUCTS_KEY, emptyTask } from "./model.js";
import { createQueue } from "./queue.js";
import { DEFAULT_SETTINGS, SETTINGS_KEY, validateSettings } from "./reply-generator.js";
import { validateProductContext } from "./review-context.js";

/** Serializes local writes so concurrent windows never replace each other's data. */
export class WorkspaceStore {
  constructor(storage) {
    this.storage = storage;
    this.data = { version: 2, records: {}, legacyImported: false };
    this.products = [];
    this.productRevision = 0;
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.enqueue = createQueue();
  }

  async load() {
    const saved = await this.storage.get([WORKSPACE_KEY, PRODUCTS_KEY, TASK_KEY, "autoreply.products-revision.v2", SETTINGS_KEY]);
    if (saved[WORKSPACE_KEY]?.version === 2) this.data = saved[WORKSPACE_KEY];
    this.products = Array.isArray(saved[PRODUCTS_KEY]) ? saved[PRODUCTS_KEY] : [];
    this.productRevision = saved["autoreply.products-revision.v2"] || 0;
    this.legacy = saved[TASK_KEY];
    if (saved[SETTINGS_KEY]) this.settings = { ...this.settings, ...saved[SETTINGS_KEY] };
  }

  publicSettings() {
    const { apiKey, ...settings } = this.settings;
    return { ...structuredClone(settings), hasApiKey: Boolean(apiKey) };
  }

  saveSettings(payload) {
    return this.enqueue(async () => {
      if (payload.previousRevision !== undefined && payload.previousRevision !== (this.settings.revision || 0)) {
        throw new Error("其他窗口已修改生成设置，请关闭后重新打开再保存。");
      }
      const next = validateSettings({
        ...this.settings, model: payload.model, videoModel: payload.videoModel,
        prompt: structuredClone(payload.prompt), structuredOutputs: payload.structuredOutputs,
        apiKey: payload.clearKey ? "" : typeof payload.apiKey === "string" && payload.apiKey.trim()
          ? payload.apiKey.trim() : this.settings.apiKey,
        revision: (this.settings.revision || 0) + 1,
      });
      if (next.prompt.id === this.settings.prompt.id && next.prompt.version === this.settings.prompt.version &&
          next.prompt.text !== this.settings.prompt.text) throw new Error("Prompt 正文已修改，请同时更新版本号。");
      await this.storage.set({ [SETTINGS_KEY]: next });
      this.settings = next;
      return this.publicSettings();
    });
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
        if ([payload.shopId, payload.productId].some(value => value !== undefined && value !== null && typeof value !== "string")) {
          throw new Error("平台 ID 必须使用字符串，不能使用数字。");
        }
        const shopId = String(payload.shopId || "").trim(), productId = String(payload.productId || "").trim();
        if (Boolean(shopId) !== Boolean(productId) || (shopId && (!/^\d+$/.test(shopId) || !/^\d+$/.test(productId)))) {
          throw new Error("关联商品时，请同时填写完整的数字店铺 ID 和商品 ID。");
        }
        product.binding = shopId ? { platform: "tiktok_shop", shopId, productId } : null;
        const sameBinding = JSON.stringify(previous?.binding) === JSON.stringify(product.binding);
        const commonFacts = payload.facts ?? (sameBinding && previous?.details === product.details ? previous?.facts : undefined);
        if (commonFacts !== undefined) product.facts = structuredClone(commonFacts);
        product.skuFacts = structuredClone(payload.skuFacts ?? (sameBinding ? previous?.skuFacts : null) ?? []);
        if (!Array.isArray(product.skuFacts) || product.skuFacts.some(item => typeof item?.skuId !== "string" || !item.skuId.trim() || !Array.isArray(item.facts)) ||
            new Set(product.skuFacts.map(item => item.skuId)).size !== product.skuFacts.length) throw new Error("SKU 专属资料格式无效。");
        const facts = product.facts || [{ id: "details", text: product.details }];
        for (const selected of [facts, ...product.skuFacts.map(item => [...facts, ...item.facts])]) {
          validateProductContext({ documentId: product.id, version: String(product.updatedAt), facts: selected });
        }
        if (product.binding && this.products.some(item => item.id !== product.id &&
          item.binding?.shopId === shopId && item.binding?.productId === productId && item.binding?.platform === "tiktok_shop")) {
          throw new Error("该店铺商品已关联资料，请编辑原有资料。");
        }
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
