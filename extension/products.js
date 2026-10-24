import { $, element, downloadJson } from "./ui.js";
import { createQueue } from "./queue.js";

export function initializeProducts({ notify, request, initialDraft = {} }) {
  const form = $("product-form"), enqueueDraft = createQueue();
  let products = [], editingId = null, editingVersion = 0, busy = false, locked = true, shop = null;
  let draftWrites = Promise.resolve(), refreshId = 0;
  const fields = { name: "product-name", aliases: "product-aliases", skuNotes: "product-notes", details: "product-details", productIds: "product-platform-id" };
  function values() { return Object.fromEntries(Object.entries(fields).map(([key, id]) => [key, $(id).value])); }
  function saveDraft() {
    draftWrites = enqueueDraft(() => request("COMMAND", { command: "PRODUCT_DRAFT", payload: { ...values(), editingId, editingVersion } }));
    draftWrites.catch(() => showError("草稿保存失败，请重试。"));
  }
  function showError(message = "") { $("product-error").textContent = message; $("product-error").hidden = !message; }
  function controls() {
    for (const node of document.querySelectorAll("#product-form input, #product-form textarea, #product-form button, #product-list button, #legacy-products button")) node.disabled = busy || locked;
    for (const node of $("product-transfer").querySelectorAll("button, input")) node.disabled = busy || locked || !shop;
  }
  function restoreDraft(draft = {}) {
    editingId = draft.editingId || null; editingVersion = draft.editingVersion || 0;
    for (const [key, id] of Object.entries(fields)) $(id).value = Array.isArray(draft[key]) ? draft[key].join("\n") : draft[key] || "";
    $("products-title").textContent = editingId ? "编辑产品资料" : "添加产品资料";
    $("save-product").textContent = editingId ? "保存修改" : "保存产品资料";
    $("reset-product").textContent = editingId ? "取消编辑" : "清空表单";
    showError();
  }
  function render() {
    $("product-count").textContent = products.length;
    $("products-empty").hidden = products.length > 0;
    $("product-list").replaceChildren(...products.map(product => {
      const card = element("article", "review-card");
      card.append(element("h3", "product-name", product.name));
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
  async function refresh() {
    const expected = ++refreshId;
    try {
      const data = await request("PRODUCTS", { action: "LIST" });
      if (expected !== refreshId) return;
      if (shop && shop !== data.shop) { restoreDraft(); }
      shop = data.shop; products = data.products; locked = data.locked;
      $("products-status").textContent = data.message || (locked ? "任务运行中，资料只读" : "当前店铺环境的资料");
      render();
      $("legacy-products").replaceChildren(...(data.legacyProducts || []).map(item => {
        const button = element("button", "button secondary", `导入旧资料：${item.name}`);
        button.type = "button"; button.disabled = locked || busy;
        button.addEventListener("click", async () => {
          try { await persist("IMPORT_LEGACY_PRODUCT", { id: item.id }); }
          catch (error) { showError(error.message); }
        });
        return button;
      }));
    } catch (error) {
      if (expected !== refreshId) return;
      locked = true; controls(); $("products-status").textContent = error.message;
    }
  }
  async function persist(action, payload) {
    busy = true; controls();
    try { await request("PRODUCTS", { action, payload }); await refresh(); }
    finally { busy = false; controls(); }
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || locked) return;
    try {
      await persist("SAVE", { ...values(), id: editingId, version: editingVersion });
      restoreDraft(); saveDraft(); notify("商品资料已保存。");
    } catch (error) { showError(error.message); }
  });
  $("reset-product").addEventListener("click", () => { restoreDraft(); saveDraft(); });
  $("export-products").addEventListener("click", async () => {
    try {
      const { backup } = await request("PRODUCTS", { action: "EXPORT" });
      downloadJson(backup, `AutoReply-${backup.source.shopId}-products.json`);
    } catch (error) { showError(error.message); }
  });
  $("import-products").addEventListener("click", () => $("product-backup").click());
  $("product-backup").addEventListener("change", async event => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file || locked || busy) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("资料备份不能超过 10 MB。");
      let backup;
      try { backup = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())); }
      catch { throw new Error("备份不是有效的 UTF-8 JSON 文件。"); }
      await persist("IMPORT_BACKUP", backup);
      showError(); notify("本店资料已导入。");
    } catch (error) { showError(error.message); }
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
    } catch (error) { showError(error.message); }
  });
  // TXT is plain product material: its name supplies a default title, never hidden instructions.
  $("product-file").addEventListener("change", async event => {
    const file = event.target.files[0]; event.target.value = "";
    if (!file || locked || busy) return;
    try {
      showError();
      if (!/\.txt$/i.test(file.name) || file.size > 400000) throw new Error("请选择不超过 400 KB 的 UTF-8 TXT 文件。");
      const bytes = await file.arrayBuffer();
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("文件编码无法识别，请另存为 UTF-8 TXT 后重新导入。"); }
      if (!text.trim()) throw new Error("资料文件为空。");
      $("product-details").value = text;
      if (!$("product-name").value.trim()) $("product-name").value = file.name.replace(/\.txt$/i, "");
      saveDraft();
    } catch (error) { showError(error.message); }
  });
  form.addEventListener("input", saveDraft);
  $("open-products").addEventListener("click", () => { locked = true; controls(); void refresh(); });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "PRODUCTS_CHANGED" && (!message.shop || message.shop === shop)) void refresh();
    if (message.type === "STATE_CHANGED" && !$("view-products").hidden) void refresh();
  });
  restoreDraft(initialDraft); controls();
  return { restoreDraft, async prepareToClose() { if (busy) throw new Error("资料正在保存，请稍后挂起。"); await draftWrites; } };
}
