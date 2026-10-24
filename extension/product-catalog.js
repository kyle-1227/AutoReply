import { PRODUCTS_KEY } from "./model.js";

export const CATALOG_PREFIX = "autoreply.products.v2:";
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const list = value => [...new Set((Array.isArray(value) ? value : String(value || "").split(/[\n,，]/))
  .map(item => String(item).trim()).filter(Boolean))];
const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function shopKey(source) {
  if (source?.platform !== "tiktok_shop" || !["MY", "SG"].includes(source.market) || typeof source.shopId !== "string" || !source.shopId.trim()) {
    fail("请先读取评价，确认当前店铺。");
  }
  return JSON.stringify([source.platform, source.market, source.shopId]);
}
export const catalogKey = source => CATALOG_PREFIX + shopKey(source);

// One document describes the product, including all its links and optional variant notes.
export function productDocument(input) {
  const product = { id: String(input?.id || ""), version: input?.version,
    name: String(input?.name || "").trim(), details: String(input?.details || "").trim(),
    aliases: list(input?.aliases), skuNotes: String(input?.skuNotes || "").trim(), productIds: list(input?.productIds) };
  if (!product.id || product.id.length > 100 || !Number.isSafeInteger(product.version) || product.version < 1 || !product.name || !product.details) {
    fail("请填写商品名称和资料正文，或重新打开有效资料。");
  }
  if (product.details.length > 100000 || product.skuNotes.length > 10000 || product.name.length > 500 ||
      product.aliases.length > 100 || product.aliases.some(alias => alias.length > 300) || product.productIds.length > 1000) {
    fail("商品资料过长，请精简后保存。");
  }
  if (product.productIds.some(id => !/^\d{1,50}$/.test(id))) fail("平台商品 ID 应填写完整数字，一行一个。");
  return product;
}

export function findProduct(products, product) {
  let matches = products.filter(item => item.productIds.includes(product?.productId));
  if (!matches.length) {
    const title = ` ${normalize(product?.title)} `;
    matches = products.filter(item => [item.name, ...item.aliases].some(name => {
      const phrase = normalize(name);
      return phrase && title.includes(` ${phrase} `);
    }));
  }
  return matches.length === 1 ? matches[0] : null;
}

function oldDocument(product) {
  return productDocument({ ...product, version: product.version || 1,
    details: product.details || product.facts?.map(fact => fact.text).join("\n"),
    skuNotes: product.skuNotes || (product.skuFacts || []).map(item => `${item.skuId}: ${item.facts.map(f => f.text).join("; ")}`).join("\n"),
    productIds: product.productIds || (product.binding?.productId ? [product.binding.productId] : []) });
}

// storage.local belongs to the persistent browser profile, never to a PC backend.
// The coordinator serializes writes with task start/pause. Reads always use storage,
// so data restored by BitBrowser does not compete with a second in-memory catalog.
export class ProductCatalog {
  constructor(storage) { this.storage = storage; }

  async load() {
    const saved = await this.storage.get(PRODUCTS_KEY);
    const legacy = Array.isArray(saved[PRODUCTS_KEY]) ? saved[PRODUCTS_KEY] : [];
    const remaining = [], patch = {};
    for (const item of legacy) {
      try {
        if (!item.binding) { remaining.push(item); continue; }
        const source = { market: "MY", ...item.binding }, key = catalogKey(source);
        const catalog = patch[key] || await this.read(source);
        const product = oldDocument(item);
        const previous = catalog.products.find(other => other.id === product.id);
        if (previous && JSON.stringify(productDocument(previous)) !== JSON.stringify(product)) {
          remaining.push(item); // Keep conflicting originals; never overwrite during an upgrade.
          continue;
        }
        if (!previous) {
          if (catalog.products.some(other => other.productIds.some(id => product.productIds.includes(id)))) throw new Error("Duplicate link");
          catalog.products.push(product); catalog.revision++;
        }
        patch[key] = { products: catalog.products, revision: catalog.revision };
      } catch { remaining.push(item); } // Invalid legacy material remains available for recovery.
    }
    if (Object.keys(patch).length) await this.storage.set({ ...patch, [PRODUCTS_KEY]: remaining });
  }

  async read(source) {
    const key = catalogKey(source);
    const saved = await this.storage.get([key, PRODUCTS_KEY]);
    const catalog = saved[key] || { products: [], revision: 0 };
    const legacyProducts = (saved[PRODUCTS_KEY] || []).filter(item => !item.binding ||
      (item.binding.platform === source.platform && item.binding.shopId === source.shopId)).map(({ id, name }) => ({ id, name }));
    return { shop: shopKey(source), ...catalog, legacyProducts };
  }

  async backup(source) {
    const [platform, market, shopId] = JSON.parse(shopKey(source));
    return { version: 1, source: { platform, market, shopId }, products: (await this.read(source)).products.map(productDocument) };
  }

  async restore(source, backup) {
    if (backup?.version !== 1 || !Array.isArray(backup.products) || shopKey(backup.source) !== shopKey(source)) {
      fail("备份不属于当前店铺，或文件格式不受支持。");
    }
    const catalog = await this.read(source), products = new Map(catalog.products.map(item => [item.id, productDocument(item)]));
    for (const input of backup.products) {
      const product = productDocument(input), previous = products.get(product.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(product)) fail("备份与已有档案冲突，未覆盖任何资料。");
      products.set(product.id, product);
    }
    const ids = new Set();
    for (const product of products.values()) for (const id of product.productIds) {
      if (ids.has(id)) fail("备份包含重复商品关联，未导入任何资料。");
      ids.add(id);
    }
    await this.storage.set({ [catalogKey(source)]: { products: [...products.values()], revision: catalog.revision + 1 } });
    return this.read(source);
  }

  async edit(source, action, payload) {
    const catalog = await this.read(source);
    const previous = catalog.products.find(item => item.id === payload.id);
    let legacy;
    if (action === "IMPORT_LEGACY_PRODUCT") {
      const saved = await this.storage.get(PRODUCTS_KEY);
      legacy = saved[PRODUCTS_KEY] || [];
      const item = legacy.find(item => item.id === payload.id && catalog.legacyProducts.some(old => old.id === item.id));
      if (!item) fail("未找到可导入的旧资料。");
      payload = oldDocument(item);
      if (previous && JSON.stringify(productDocument(previous)) !== JSON.stringify(payload)) {
        fail("旧资料与当前档案冲突，请先核对；未覆盖或移除原件。");
      }
    } else if (!["SAVE", "DELETE"].includes(action)) fail("无法识别资料操作。");
    if ((action === "DELETE" || payload.id) && action !== "IMPORT_LEGACY_PRODUCT" && !previous) fail("资料已删除，请重新添加。");
    if (previous && action !== "IMPORT_LEGACY_PRODUCT" && previous.version !== payload.version) fail("资料已改变，请重新打开后操作。");
    let products = catalog.products.filter(item => item.id !== payload.id);
    if (action !== "DELETE") {
      const product = productDocument({ ...payload, id: previous?.id || payload.id || crypto.randomUUID(),
        version: previous ? previous.version + 1 : 1 });
      if (products.some(item => item.productIds.some(id => product.productIds.includes(id)))) fail("同一平台商品已关联其他档案，请先解除旧关联。");
      // A repeated legacy import never overwrites an already migrated document.
      products = action === "IMPORT_LEGACY_PRODUCT" && previous ? catalog.products : [...products, product];
    }
    const patch = { [catalogKey(source)]: { products, revision: catalog.revision + 1 } };
    if (legacy) patch[PRODUCTS_KEY] = legacy.filter(item => item.id !== payload.id);
    await this.storage.set(patch);
    return this.read(source);
  }
}
