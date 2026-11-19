import { isReviewPage, readReviews } from "./review-reader.js";
import { reviewIdentity } from "./review-context.js";

const publishError = message => Object.assign(new Error(message), { code: "PUBLISH_FAILED" });

// Serialized by chrome.scripting. Uses the seller center's own reply controls.
export async function publishOnReviewPage(operationId, expectedUrl, shop, review, reply = null) {
  const key = Symbol.for("autoreply.review-publisher");
  const awaiting = '[data-id="product.rating.filter_awaiting_reply"]';
  const editor = 'textarea[data-tid="m4b_input_textarea"]';
  const visible = node => node.isConnected && node.getClientRects().length > 0;
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')].filter(visible);
  const fiberOf = node => node[Object.keys(node).find(name => name.startsWith("__reactFiber$"))];
  const findProps = (node, matches) => {
    for (let fiber = fiberOf(node); fiber; fiber = fiber.return) {
      if (matches(fiber)) return fiber.memoizedProps;
    }
    return null;
  };
  const action = (root, label, selector, check = () => true) => {
    const nodes = [...root.querySelectorAll(selector)].filter(node =>
      visible(node) && label.test(node.textContent.trim()) && check(node));
    return nodes.length === 1 ? nodes[0] : null;
  };
  const checkShop = () => {
    if (location.href !== expectedUrl) return false;
    try {
      const base = document.getElementById("atlas_inject_workbench-base-info");
      const seller = JSON.parse(base?.textContent || "{}").seller_base_info?.seller;
      return seller?.seller_id === shop.shopId && seller.region_code === shop.market;
    } catch { return false; }
  };
  const inspect = () => {
    if (!checkShop()) return { state: "blocked", message: "评价来源页或店铺身份已改变。" };
    if (dialogs().length) return { state: "blocked", message: "请先关闭评价页上已打开的弹窗。" };
    if (!document.querySelector(awaiting)?.classList.contains("pulse-toggle-button-checked")) return { state: "missing" };
    const rows = document.querySelector('[data-tid="rating-list"]')?.children;
    const identified = [...(rows || [])].map(row => [row, findProps(row, fiber =>
      fiber.key === review.reviewId && fiber.memoizedProps?.itemInfo?.main_review_id === review.reviewId)?.itemInfo]);
    const matches = identified.filter(([, item]) => item);
    if (!matches.length) return { state: "missing" };
    if (matches.length !== 1) return { state: "blocked", message: "评价编号重复，无法安全定位回复框。" };
    const [row, item] = matches[0];
    if (item.reply_count !== 0 || item.can_reply !== true) return { state: "ineligible" };
    if (item.review_text !== review.text || (item.star_level ?? null) !== review.rating ||
        item.product_info?.product_id !== review.product.productId ||
        (item.product_info?.sku_id ?? null) !== review.product.skuId ||
        (item.last_modify_time ?? null) !== review.modifiedAt) return { state: "changed" };
    const button = action(row, /^(回复|回覆|reply)$/i, "div,button,a,[role=button]",
      node => typeof fiberOf(node)?.memoizedProps?.onClick === "function");
    if (!button) return { state: "ineligible" };
    return { state: "ready", button };
  };

  const { button, ...result } = inspect();
  if (reply === null || result.state !== "ready") return result;
  if (window[key]) return { state: "blocked", message: "此页面已有正在执行的发布操作。" };
  let stopped = false, clicked = false, completed = false, ownedEditor;
  let installedFetch, originalFetch;
  window[key] = { operationId, cancel: () => { stopped = true; } };
  const stillHere = () => !stopped && checkShop();
  const waitFor = async (check, timeout) => {
    const expires = Date.now() + timeout;
    while (stillHere() && Date.now() < expires) {
      const value = check();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  };
  const ownEditor = () => {
    const active = dialogs();
    if (active.length !== 1) return null;
    const inputs = [...active[0].querySelectorAll(editor)].filter(node => visible(node) &&
      findProps(node, fiber => fiber.memoizedProps?.reviewId === review.reviewId && fiber.memoizedProps?.isFirstReply === true));
    return inputs.length === 1 ? inputs[0] : null;
  };
  const blocked = message => ({ state: "blocked", message });
  try {
    if (!stillHere()) return blocked("停止发布前，来源页已改变。");
    button.click();
    ownedEditor = await waitFor(ownEditor, 8000);
    if (!ownedEditor || ownedEditor.value || ownedEditor.disabled || ownedEditor.readOnly ||
        !Number.isInteger(ownedEditor.maxLength) || ownedEditor.maxLength < reply.length) {
      return blocked("未能验证目标评价的空白回复框或字数限制，请检查评价页。");
    }
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setValue.call(ownedEditor, reply);
    ownedEditor.dispatchEvent(new Event("input", { bubbles: true }));
    const submit = await waitFor(() => {
      if (ownEditor() !== ownedEditor || ownedEditor.value !== reply) return null;
      const node = action(ownedEditor.closest('[role="dialog"]'), /^(提交|提交回覆|submit)$/i, "button");
      return node && !node.disabled && node.getAttribute("aria-disabled") !== "true" ? node : null;
    }, 4000);
    if (!submit || !stillHere()) return blocked("未能验证目标评价的提交按钮，请检查评价页。");

    originalFetch = window.fetch;
    let attempted = false, outcome = null;
    installedFetch = function (input, init) {
      let url;
      try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href); }
      catch { return Reflect.apply(originalFetch, this, arguments); }
      if (url.pathname !== "/api/v1/review/biz_backend/reply") return Reflect.apply(originalFetch, this, arguments);
      if (attempted) return Promise.reject(new Error("AutoReply blocked a duplicate reply request."));
      attempted = true;
      const receiver = this, args = arguments;
      return (async () => {
        let payload;
        try { payload = typeof init?.body === "string" ? JSON.parse(init.body) : await input.clone().json(); }
        catch { /* An unknown request shape cannot be submitted automatically. */ }
        const requestShop = url.searchParams.get("oec_seller_id");
        if (!stillHere() || url.origin !== location.origin || (requestShop && requestShop !== shop.shopId) ||
            (init?.method || input?.method || "").toUpperCase() !== "POST" ||
            payload?.review_id !== review.reviewId || payload?.text !== reply) {
          outcome ||= blocked("平台回复请求与当前评价或正文不匹配，已拦截。");
          throw new Error("AutoReply blocked an unverified reply request.");
        }
        try {
          const response = await Reflect.apply(originalFetch, receiver, args);
          if (response.ok) {
            void response.clone().json().then(body => {
              if (typeof body?.code === "number") outcome = { state: body.code === 0 ? "published" : "rejected" };
            }).catch(() => {});
          }
          return response;
        } catch (error) {
          outcome = { state: "uncertain" };
          throw error;
        }
      })();
    };
    window.fetch = installedFetch;
    clicked = true;
    submit.click();
    const received = await waitFor(() => outcome, 15000);
    completed = received?.state === "published" || received?.state === "rejected" || received?.state === "blocked";
    if (received?.state === "published") await waitFor(() => !ownedEditor.isConnected || !visible(ownedEditor), 3000);
    return received || { state: "uncertain" };
  } catch {
    return clicked ? { state: "uncertain" } : blocked("评价页结构发生变化，无法提交回复。");
  } finally {
    if (installedFetch && window.fetch === installedFetch) window.fetch = originalFetch;
    if ((!clicked || completed) && checkShop() && ownedEditor && ownEditor() === ownedEditor &&
        (!ownedEditor.value || ownedEditor.value === reply)) {
      action(ownedEditor.closest('[role="dialog"]'), /^(取消|cancel)$/i, "button")?.click();
    }
    if (window[key]?.operationId === operationId) delete window[key];
  }
}

export async function publishReply(context, item, { browser = chrome, signal, beforeSubmit }) {
  const source = { tabId: context.tabId, windowId: context.windowId, url: context.url };
  const review = item.platformReview, shop = item.source, text = item.reply;
  if (!isReviewPage(source.url) || !shop || shop.platform !== "tiktok_shop" ||
      !["MY", "SG"].includes(shop.market) || !/^\d{1,50}$/.test(shop.shopId) ||
      new URL(source.url).hostname !== `seller-${shop.market.toLowerCase()}.tiktok.com` ||
      !review || !/^\d{1,50}$/.test(review.reviewId) || typeof text !== "string" || !text.trim() || text.length > 300 ||
      item.generationRecord?.result?.decision !== "reply" || item.generationRecord.result.replyText !== text) {
    throw publishError("回复或店铺评价身份无效，请核对生成记录。");
  }
  const checkTab = async () => {
    signal?.throwIfAborted();
    const tab = await browser.tabs.get(source.tabId);
    signal?.throwIfAborted();
    if (tab.url !== source.url || tab.windowId !== source.windowId || tab.status !== "complete" || tab.discarded || tab.frozen) {
      throw publishError("原评价页未就绪，已停止发布。");
    }
  };
  const operationId = crypto.randomUUID();
  let documentId;
  async function run(replyText) {
    await checkTab();
    const target = { tabId: source.tabId, ...(documentId ? { documentIds: [documentId] } : { frameIds: [0] }) };
    const cancel = () => {
      void browser.scripting.executeScript({ target, world: "MAIN", func: id => {
        const active = window[Symbol.for("autoreply.review-publisher")];
        if (active?.operationId === id) active.cancel();
      }, args: [operationId] }).catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const results = await browser.scripting.executeScript({ target, world: "MAIN", func: publishOnReviewPage,
        args: [operationId, source.url, shop, review, replyText] });
      signal?.throwIfAborted();
      const result = results.find(entry => entry.frameId === 0);
      if (!result?.documentId || !result.result) throw publishError("评价页未返回可验证的发布结果。");
      documentId = result.documentId;
      return result.result;
    } finally { signal?.removeEventListener("abort", cancel); }
  }
  let ready = await run(null);
  if (ready.state === "missing") {
    const found = await readReviews(source, { browser, signal, lookup: { url: source.url, shopId: shop.shopId, reviewId: review.reviewId } });
    if (!found) return { state: "ineligible" };
    ready = await run(null);
  }
  if (ready.state === "blocked") throw publishError(ready.message);
  if (ready.state === "missing") throw publishError("未能核对已定位的评价行，请检查店铺页面。");
  if (ready.state !== "ready") return ready;
  await beforeSubmit();
  return run(text);
}

export function publicationKey(review) {
  return review?.source && review.platformReview ? reviewIdentity(review.source, review.platformReview) : null;
}
