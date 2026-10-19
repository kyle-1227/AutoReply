import { $, element } from "./ui.js";
import { createQueue } from "./queue.js";

// The shared library is edited centrally; form drafts belong to the current task.
export async function initializeProducts({ notify, request, initialDraft = {} }) {
  const form = $("product-form");
  const enqueueDraft = createQueue();
  let products = [];
  let productsRevision = -1;
  let editingId = null;
  let editingVersion = 0;
  let busy = true;
  let draftWrites = Promise.resolve();

  function saveDraft() {
    const draft = { editingId, editingVersion, name: $("product-name").value,
      sku: $("product-sku").value, details: $("product-details").value };
    draftWrites = enqueueDraft(() => request("COMMAND", { command: "PRODUCT_DRAFT", payload: draft }));
    draftWrites.catch(() => showError("产品表单草稿保存失败，请重试。"));
  }

  function showError(message = "", field) {
    $("product-error").textContent = message;
    $("product-error").hidden = !message;
    for (const input of form.querySelectorAll("input, textarea")) input.removeAttribute("aria-invalid");
    if (field) {
      $(field).setAttribute("aria-invalid", "true");
      $(field).focus();
    }
  }

  function resetForm() {
    restoreDraft();
    saveDraft();
  }

  function setBusy(value) {
    busy = value;
    for (const control of document.querySelectorAll("#product-form input, #product-form textarea, #product-form button, #product-list button")) {
      control.disabled = value;
    }
  }

  function renderProducts() {
    $("product-count").textContent = products.length;
    $("products-empty").hidden = products.length > 0;
    $("product-list").replaceChildren(...products.map(product => {
      const card = element("article", "review-card");
      card.dataset.productId = product.id;
      card.append(element("h3", "product-name", product.name));
      if (product.sku) card.append(element("p", "product-sku", `产品编号 / SKU：${product.sku}`));
      card.append(element("p", "product-details", product.details));
      const actions = element("div", "card-actions");
      for (const [action, label] of [["edit", "编辑"], ["delete", "删除"]]) {
        const button = element("button", `button text-button${action === "delete" ? " danger-text" : ""}`, label);
        button.type = "button";
        button.dataset.productAction = action;
        button.dataset.id = product.id;
        actions.append(button);
      }
      card.append(actions);
      return card;
    }));
  }

  function applyProducts(next, revision) {
    if (revision < productsRevision) return;
    productsRevision = revision;
    products = next;
    renderProducts();
    setBusy(busy);
  }

  async function persist(action, payload) {
    setBusy(true);
    try {
      const response = await request("PRODUCTS", { action, payload });
      applyProducts(response.products, response.revision);
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    const name = $("product-name").value.trim();
    const sku = $("product-sku").value.trim();
    const details = $("product-details").value.trim();
    if (!name) return showError("请填写产品名称。", "product-name");
    if (!details) return showError("请填写产品资料。", "product-details");
    if (sku && products.some(product => product.id !== editingId && product.sku.toLowerCase() === sku.toLowerCase())) {
      return showError("该产品编号 / SKU 已存在，请编辑已有资料或使用其他编号。", "product-sku");
    }
    const product = { id: editingId, name, sku, details, previousUpdatedAt: editingVersion };
    showError();
    try {
      await persist("SAVE", product);
      resetForm();
      notify("产品资料已保存在本机。");
    } catch (error) {
      showError(error.message);
    }
  });

  $("reset-product").addEventListener("click", () => {
    if (busy) return;
    resetForm();
    $("product-name").focus();
  });

  $("product-list").addEventListener("click", async event => {
    const button = event.target.closest("[data-product-action]");
    if (!button || busy) return;
    const product = products.find(item => item.id === button.dataset.id);
    if (!product) return;
    if (button.dataset.productAction === "edit") {
      restoreDraft({ ...product, editingId: product.id, editingVersion: product.updatedAt });
      saveDraft();
      $("product-name").focus();
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    if (!confirm(`删除“${product.name}”的产品资料？`)) return;
    try {
      await persist("DELETE", { id: product.id });
      if (editingId === product.id) resetForm();
      showError();
      notify("已删除产品资料。");
    } catch (error) {
      showError(error.message);
    }
  });

  function restoreDraft(draft = {}) {
    editingId = products.some(product => product.id === draft.editingId) ? draft.editingId : null;
    editingVersion = editingId ? draft.editingVersion || 0 : 0;
    for (const field of ["name", "sku", "details"]) $(`product-${field}`).value = draft[field] || "";
    $("products-title").textContent = editingId ? "编辑产品资料" : "添加产品资料";
    $("save-product").textContent = editingId ? "保存修改" : "保存产品资料";
    $("reset-product").textContent = editingId ? "取消编辑" : "清空表单";
    showError();
  }
  form.addEventListener("input", saveDraft);
  chrome.runtime.onMessage.addListener(message => {
    if (message.type !== "PRODUCTS_CHANGED") return;
    applyProducts(message.products, message.revision);
  });
  setBusy(true);
  const initial = await request("PRODUCTS", { action: "LIST" });
  applyProducts(initial.products, initial.revision);
  restoreDraft(initialDraft);
  setBusy(false);
  return {
    restoreDraft,
    async prepareToClose() {
      if (busy) throw new Error("产品资料正在保存，请稍后再挂起。");
      await draftWrites;
    },
  };
}
