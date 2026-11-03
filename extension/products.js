import { $, element, downloadJson } from "./ui.js";
import { createQueue } from "./queue.js";
import { CATEGORIES, CATEGORY_SOURCE_NAMES, categoryName, resolveCategory } from "./categories.js";

export function initializeProducts({ notify, captureContext, initialDraft = {}, showPage }) {
  const form = $("product-form"), enqueueDraft = createQueue();
  let products = [], editingId = null, editingVersion = 0, busy = false, refreshing = false, locked = true, shop = null;
  let draftWrites = Promise.resolve(), refreshId = 0, operationId = 0;
  let refreshPromise = null, refreshAgain = false, contextLocked = null;
  let selectedCategories = [], revision = 0, categoryRevision = null, categoryOptionsKey = null;
  const fields = { name: "product-name", categoryId: "product-category", aliases: "product-aliases", skuNotes: "product-notes", details: "product-details", productIds: "product-platform-id" };
  function values() { return Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, $(id).value])); }
  function saveDraft() {
    const scope = captureContext(), payload = { ...values(), editingId, editingVersion };
    draftWrites = enqueueDraft(() => scope.request("COMMAND", { command: "PRODUCT_DRAFT", payload }));
    draftWrites.catch(() => { try { scope.check(); showError("草稿保存失败，请重试。"); } catch {} });
  }
  function showError(message = "") { $("product-error").textContent = message; $("product-error").hidden = !message; }
  function failed(error) { if (!error.stalePage) showError(error.message); }
  function controls() {
    $("refresh-products").disabled = busy || refreshing || !shop;
    $("refresh-products").textContent = refreshing ? "刷新中…" : "刷新";
    $("refresh-products").setAttribute("aria-busy", String(refreshing));
    $("open-categories").disabled = busy || refreshing || !shop;
    $("categories-back").disabled = busy;
    for (const node of document.querySelectorAll("#product-form input, #product-form textarea, #product-form select, #product-form button, #product-list button, #legacy-products button, #category-form input, #category-form button")) node.disabled = busy || locked;
    $("skip-categories").disabled = busy;
    for (const node of $("product-transfer").querySelectorAll("button, input")) node.disabled = busy || locked || !shop;
  }
  function categoryPreview() {
    const used = resolveCategory({ categoryId: $("product-category").value }, selectedCategories);
    $("product-category").title = `使用规则：${categoryName(used.id)}（${CATEGORY_SOURCE_NAMES[used.source]}）`;
  }
  function renderCategorySelect() {
    const key = JSON.stringify(selectedCategories), select = $("product-category"), value = select.value;
    if (key !== categoryOptionsKey) {
      categoryOptionsKey = key;
      const defaultOption = element("option", "", "未指定（按店铺规则）"); defaultOption.value = "";
      const options = [defaultOption];
      for (const preferred of [true, false]) {
        const items = CATEGORIES.filter(item => selectedCategories.includes(item.id) === preferred);
        if (!items.length) continue;
        const group = element("optgroup"); group.label = preferred ? "店铺已选" : "其他类目";
        group.append(...items.map(item => { const option = element("option", "", item.name); option.value = item.id; return option; }));
        options.push(group);
      }
      select.replaceChildren(...options); select.value = value;
    }
    categoryPreview();
  }
  function restoreDraft(draft = {}) {
    editingId = draft.editingId || null; editingVersion = draft.editingVersion || 0;
    for (const [key, id] of Object.entries(fields)) $(id).value = Array.isArray(draft[key]) ? draft[key].join("\n") : draft[key] || "";
    categoryPreview();
    $("products-title").textContent = editingId ? "编辑产品资料" : "添加产品资料";
    $("save-product").textContent = editingId ? "保存修改" : "保存产品资料";
    $("reset-product").textContent = editingId ? "取消编辑" : "清空表单";
    showError();
  }
  function render() {
    renderCategorySelect();
    $("shop-category-summary").textContent = selectedCategories.length ? `已选 ${selectedCategories.length} 类` : "未设置";
    $("shop-category-summary").title = selectedCategories.map(categoryName).join("、") || "未设置时使用全品类基础规则";
    $("product-count").textContent = products.length;
    $("products-empty").hidden = products.length > 0;
    $("product-list").replaceChildren(...products.map(product => {
      const card = element("article", "review-card");
      card.append(element("h3", "product-name", product.name));
      const used = resolveCategory(product, selectedCategories);
      card.append(element("p", "product-sku", categoryName(used.id)));
      if (product.aliases.length) card.append(element("p", "product-sku", product.aliases.join(" / ")));
      card.append(element("p", "product-details", product.details));
      if (product.skuNotes) card.append(element("p", "product-details", product.skuNotes));
      const actions = element("div", "card-actions");
      for (const [action, label] of [["edit", "编辑"], ["delete", "删除"]]) {
        const button = element("button", "button text-button", label);
        button.type = "button"; button.dataset.action = action; button.dataset.id = product.id;
        actions.append(button);
      }
      card.append(actions); return card;
    }));
    controls();
  }
  function applyCatalog(data) {
    if (shop && shop !== data.shop) restoreDraft();
    shop = data.shop; products = data.products; locked = contextLocked ?? data.locked;
    selectedCategories = data.categoryIds || []; revision = data.revision || 0;
    $("products-status").textContent = data.message || (locked ? "任务运行中，资料只读" : "当前店铺环境的资料");
    render();
    $("legacy-products").replaceChildren(...(data.legacyProducts || []).map(item => {
      const button = element("button", "button secondary", `导入旧资料：${item.name}`);
      button.type = "button"; button.disabled = locked || busy;
      button.addEventListener("click", async () => {
        try { await persist("IMPORT_LEGACY_PRODUCT", { id: item.id }); }
        catch (error) { failed(error); }
      });
      return button;
    }));
  }
  function refresh(scope = captureContext(), invalidated = false) {
    if (refreshPromise) { refreshAgain ||= invalidated; return refreshPromise; }
    const expected = ++refreshId;
    refreshing = true; controls();
    const promise = (async () => {
      try {
        do {
          refreshAgain = false;
          const data = await scope.request("PRODUCTS", { action: "LIST" });
          if (expected !== refreshId) return;
          applyCatalog(data);
        } while (refreshAgain);
        return true;
      } catch (error) {
        if (expected !== refreshId || error.stalePage) return;
        locked = true; controls(); $("products-status").textContent = error.message;
      } finally {
        if (expected === refreshId) { refreshPromise = null; refreshing = false; controls(); }
      }
    })();
    return refreshPromise = promise;
  }
  async function persist(action, payload, scope = captureContext()) {
    const expected = ++operationId;
    const catalogRequest = ++refreshId;
    refreshPromise = null; refreshing = false;
    busy = true; controls();
    try {
      const data = await scope.request("PRODUCTS", { action, payload });
      scope.check();
      if (catalogRequest === refreshId) applyCatalog(data);
    }
    finally { if (expected === operationId) { busy = false; controls(); } }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || locked) return;
    try {
      await persist("SAVE", { ...values(), id: editingId, version: editingVersion });
      restoreDraft(); saveDraft(); notify("商品资料已保存。");
    } catch (error) { failed(error); }
  });
  $("reset-product").addEventListener("click", () => { restoreDraft(); saveDraft(); });
  $("export-products").addEventListener("click", async () => {
    try {
      const { backup } = await captureContext().request("PRODUCTS", { action: "EXPORT" });
      downloadJson(backup, `AutoReply-${backup.source.shopId}-products.json`);
    } catch (error) { failed(error); }
  });
  $("import-products").addEventListener("click", () => $("product-backup").click());
  $("product-backup").addEventListener("change", async event => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file || locked || busy) return;
    const scope = captureContext();
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("资料备份不能超过 10 MB。");
      let backup;
      try { backup = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())); }
      catch { throw new Error("备份不是有效的 UTF-8 JSON 文件。"); }
      await persist("IMPORT_BACKUP", backup, scope);
      showError(); notify("本店资料已导入。");
    } catch (error) { failed(error); }
  });
  $("product-list").addEventListener("click", async event => {
    const button = event.target.closest("[data-action]");
    if (!button || busy || locked) return;
    const product = products.find(item => item.id === button.dataset.id);
    if (!product) return;
    if (button.dataset.action === "edit") {
      restoreDraft({ ...product, editingId: product.id, editingVersion: product.version });
      saveDraft(); $("product-name").focus(); return;
    }
    if (!confirm(`删除“${product.name}”的资料？`)) return;
    try {
      await persist("DELETE", { id: product.id, version: product.version });
      if (editingId === product.id) { restoreDraft(); saveDraft(); }
    } catch (error) { failed(error); }
  });
  // TXT is plain product material: its name supplies a default title, never hidden instructions.
  $("product-file").addEventListener("change", async event => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file || locked || busy) return;
    const scope = captureContext();
    try {
      showError();
      if (!/\.txt$/i.test(file.name) || file.size > 400000) throw new Error("请选择不超过 400 KB 的 UTF-8 TXT 文件。");
      const bytes = await file.arrayBuffer();
      scope.check();
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("文件编码无法识别，请另存为 UTF-8 TXT 后重新导入。"); }
      if (!text.trim()) throw new Error("资料文件为空。");
      $("product-details").value = text;
      if (!$("product-name").value.trim()) $("product-name").value = file.name.replace(/\.txt$/i, "");
      saveDraft();
    } catch (error) { failed(error); }
  });
  form.addEventListener("input", saveDraft);
  $("product-category").addEventListener("change", categoryPreview);
  $("category-options").append(...CATEGORIES.map(item => {
    const label = element("label"), input = element("input"); input.type = "checkbox"; input.name = "category"; input.value = item.id;
    label.append(input, element("span", "", item.name)); return label;
  }));
  $("open-categories").addEventListener("click", async () => {
    if (busy || refreshing || !shop) return;
    try {
      const scope = captureContext(); await draftWrites;
      if (!await refresh(scope)) return;
      scope.check(); categoryRevision = revision;
      $("category-error").hidden = true;
      for (const input of $("category-options").querySelectorAll("input")) input.checked = selectedCategories.includes(input.value);
      showPage("categories");
    } catch (error) { failed(error); }
  });
  $("category-form").addEventListener("submit", async event => {
    event.preventDefault(); if (busy || locked || !shop) return;
    try {
      await persist("SAVE_CATEGORIES", { categoryIds: [...$("category-options").querySelectorAll("input:checked")].map(input => input.value), revision: categoryRevision });
      showPage("products"); notify("店铺类目已保存。");
    } catch (error) {
      if (!error.stalePage) { $("category-error").textContent = error.message; $("category-error").hidden = false; }
    }
  });
  for (const id of ["categories-back", "skip-categories"]) $(id).addEventListener("click", () => { if (!busy) showPage("products"); });
  $("refresh-products").addEventListener("click", async () => {
    if (busy || refreshing || !shop) return;
    try {
      if (await refresh()) notify(products.length ? "已刷新本店资料。" : "当前环境暂无本店资料；如其他电脑已保存，请先完成 BitBrowser 环境同步。");
    } catch (error) { failed(error); }
  });
  $("open-products").addEventListener("click", () => { locked = true; controls(); void refresh(); });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "PRODUCTS_CHANGED" && (!message.shops || message.shops.includes(shop)) &&
        (!$("view-products").hidden || !$("view-categories").hidden)) void refresh(captureContext(), true);
  });
  renderCategorySelect(); restoreDraft(initialDraft); controls();
  return { restoreDraft, refresh, flushDrafts: () => draftWrites,
    setLocked(value) {
      contextLocked = typeof value === "boolean" ? value : null;
      if (contextLocked === null || locked === contextLocked) return;
      locked = contextLocked; controls();
      if (shop) $("products-status").textContent = locked ? "任务运行中，资料只读" : "当前店铺环境的资料";
    },
    setContext(draft = {}) {
      refreshId++; operationId++;
      refreshPromise = null; refreshAgain = false; contextLocked = null;
      products = []; shop = null; selectedCategories = []; revision = 0; categoryRevision = null; locked = true; busy = false; refreshing = false;
      renderCategorySelect();
      restoreDraft(draft); render();
      $("legacy-products").replaceChildren();
      if (!$("view-categories").hidden) showPage("products");
    },
    async prepareToClose() { if (busy) throw new Error("资料正在保存，请稍后挂起。"); await draftWrites; },
  };
}
