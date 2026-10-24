import { validateReviewBatch } from "./review-context.js";

export const isReviewPage = url => {
  try { const u = new URL(url); return /^https:\/\/seller-(my|sg)\.tiktok\.com$/.test(u.origin) && u.pathname === "/product/rating"; }
  catch { return false; }
};

/** Runs only in the bound page's MAIN world. No extension data or secrets enter it. */
export async function observeReviewPage(operationId) {
  const key = Symbol.for("autoreply.review-reader");
  if (window[key]) return { error: "此页面正在读取评价，请稍后重试。" };
  const originalUrl = location.href;
  const originalFetch = window.fetch;
  let waiter = null, stopped = false;
  const renderCancellations = new Set();
  const fail = message => { throw new Error(message); };
  const checked = node => node?.classList.contains("pulse-toggle-button-checked");
  const filter = () => document.querySelector('[data-id="product.rating.filter_awaiting_reply"]');
  const cancel = () => {
    stopped = true;
    waiter?.reject(new Error("评价读取已停止。"));
    for (const stop of renderCancellations) stop();
  };
  window[key] = { operationId, cancel };

  async function inspect(response, requestUrl) {
    const active = waiter;
    if (!active || stopped) return;
    try {
      if (!response.ok) fail("店铺评价请求失败，请检查登录或网络后重试。");
      const payload = await response.json();
      if (waiter !== active || stopped) return;
      const list = payload.data?.list ?? (payload.data?.total === 0 ? [] : null);
      if (payload.code !== 0 || !Array.isArray(list) ||
          !Number.isInteger(payload.data.total) || payload.data.total < 0) fail("店铺未返回完整评价列表，请检查登录或页面加载状态。");
      const shopId = requestUrl.searchParams.get("oec_seller_id");
      if (!shopId) fail("评价数据缺少店铺 ID，已停止读取。");
      const reviews = list.map(item => {
        // Accept the verified review_videos shape; unknown media must not be silently dropped.
        if (Object.entries(item).some(([name, value]) => /video/i.test(name) && !["has_video", "review_videos"].includes(name) &&
            value && (!Array.isArray(value) || value.length))) {
          fail("发现尚未核实的视频评价字段，已停止读取，请先适配视频样本。");
        }
        if (item.review_images !== undefined && !Array.isArray(item.review_images)) fail("买家图片字段格式已变化。");
        if (item.review_videos !== undefined && !Array.isArray(item.review_videos)) fail("买家视频字段格式已变化。");
        const images = item.review_images || [];
        const videos = item.review_videos || [];
        if (images.some(image => Object.entries(image || {}).some(([name, value]) => /video/i.test(name) && value) ||
            typeof image?.mime_type === "string" && image.mime_type.startsWith("video/"))) fail("发现尚未核实的视频附件，已停止读取。");
        if (item.has_imgs && !images.length) fail("评价含有未能读取的图片，已停止读取。");
        if (item.has_video && !videos.length) fail("评价含有未能读取的视频，已停止读取。");
        const videoAttachments = videos.map(video => {
          const url = Array.isArray(video?.video_infos) && video.video_infos.flatMap(info => [info?.main_url, info?.backup_url])
            .find(value => typeof value === "string" && value.startsWith("https://"));
          if (!url) fail("评价视频缺少可用的 HTTPS 地址，已停止读取。");
          return { kind: "video", url };
        });
        return {
          reviewId: item.main_review_id,
          product: {
            productId: item.product_info?.product_id, skuId: item.product_info?.sku_id ?? null,
            title: item.product_info?.product_name ?? null, variant: item.product_info?.sku_specification ?? null,
          },
          rating: item.star_level ?? null, text: item.review_text,
          attachments: [...images.map(image => ({ kind: "image", url: image.url_list?.find(url => typeof url === "string" && url.startsWith("https://")) ?? null })),
            ...videoAttachments],
          platformReply: { count: item.reply_count, canReply: item.can_reply },
          modifiedAt: item.last_modify_time ?? null,
        };
      });
      const market = new URL(originalUrl).hostname.split(".")[0].slice(7).toUpperCase();
      active.resolve({ source: { platform: "tiktok_shop", market, shopId }, reviews, total: payload.data.total });
    } catch (error) { active.reject(error instanceof SyntaxError ? new Error("店铺返回了无法解析的评价数据，请检查页面状态。") : error); }
  }

  function wrappedFetch(...args) {
    // Preserve the site's original fetch behavior, including unrelated failures.
    const result = Reflect.apply(originalFetch, this, args);
    let url;
    try { url = new URL(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0].url, location.href); }
    catch { return result; }
    if (url.origin === location.origin && url.pathname === "/api/v1/review/biz_backend/list") {
      const active = waiter;
      result.then(response => { if (active && waiter === active && !stopped) void inspect(response.clone(), url); }, () => {
        if (active && waiter === active && !stopped) active.reject(new Error("评价列表请求失败，请检查网络后重试。"));
      });
    }
    return result;
  }

  function query(trigger) {
    if (stopped || location.href !== originalUrl) fail("来源页面已改变或读取已停止。");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => waiter.reject(new Error("评价列表读取超时，请重试。")), 15000);
      waiter = { resolve: value => { clearTimeout(timeout); waiter = null; resolve(value); },
        reject: error => { clearTimeout(timeout); waiter = null; reject(error); } };
      try { trigger(); } catch (error) { waiter.reject(error); }
    });
  }

  function renderReady(test) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("评价分页未恢复，请重试。")), 8000);
      const observer = new MutationObserver(check);
      const stop = () => finish(new Error("评价读取已停止。"));
      renderCancellations.add(stop);
      function finish(error) { clearTimeout(timeout); observer.disconnect(); renderCancellations.delete(stop); error ? reject(error) : resolve(); }
      function check() {
        if (stopped || location.href !== originalUrl) return finish(new Error("评价读取已停止或来源页面已改变。"));
        if (test()) finish();
      }
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
    });
  }

  try {
    if (!filter()) fail("请打开 TikTok Shop 马来西亚站或新加坡站的商品评分页面。");
    window.fetch = wrappedFetch;
    const otherFilters = [...document.querySelectorAll('[data-id^="product.rating.filter_"]')]
      .some(node => checked(node) && node !== filter());
    const inputs = [...document.querySelectorAll('input[placeholder]')]
      .some(node => /搜索订单|日期范围|^自$|^至$/.test(node.placeholder) && node.value.trim());
    if (otherFilters || inputs) {
      const reset = document.querySelector('[data-id="product.rating.filter_reset"]');
      if (!reset) fail("无法清除评价筛选条件，已停止读取。");
      await query(() => reset.click());
      await renderReady(() => !checked(filter()));
    }
    if (checked(filter())) {
      await query(() => filter().click());
      await renderReady(() => !checked(filter()));
    }
    let batch = await query(() => filter().click());
    const source = batch.source;
    const reviews = [], seen = new Set();
    let page = 1, pageSize = 0;
    while (true) {
      await renderReady(() => checked(filter()) && (batch.total === 0 ||
        (Number(document.querySelector('[data-tid="m4b_pagination"] [aria-current="true"]')?.textContent) === page &&
        document.querySelector('[data-tid="rating-list"]')?.children.length === batch.reviews.length)));
      if (batch.source.shopId !== source.shopId) fail("读取期间店铺发生变化，已停止读取。");
      const pagination = document.querySelector('[data-tid="m4b_pagination"]');
      pageSize = Number(pagination?.querySelector('input')?.value.match(/^\d+/)?.[0]) || (batch.total === 0 ? 50 : 0);
      if (!pageSize) fail("无法识别每页评价数量。");
      let added = 0;
      for (const review of batch.reviews) {
        if (!seen.has(review.reviewId)) { seen.add(review.reviewId); reviews.push(review); added++; }
      }
      const next = pagination?.querySelector('[aria-label="下一个"], [aria-label="Next"]');
      const disabled = !next || next.getAttribute("aria-disabled") === "true" || next.classList.contains("core-pagination-item-disabled");
      if (disabled) {
        if (reviews.length !== batch.total) fail("读取数量与店铺总数不一致，请重试，未将本轮标记为完成。");
        return { source, reviews, pagination: { page, pageSize, total: batch.total } };
      }
      if (!added || reviews.length >= batch.total) fail("评价分页与总数不一致，已停止循环。");
      batch = await query(() => next.click());
      page++;
    }
  } catch (error) { return { error: error.message }; }
  finally {
    stopped = true;
    if (window.fetch === wrappedFetch) window.fetch = originalFetch;
    if (window[key]?.operationId === operationId) delete window[key];
  }
}

export async function readReviews(source, { browser = chrome, signal } = {}) {
  if (!isReviewPage(source.url)) throw new Error("请在 TikTok Shop 马来西亚站或新加坡站的商品评分页面读取评价。");
  const check = async () => {
    const tab = await browser.tabs.get(source.tabId);
    if (tab.url !== source.url || tab.windowId !== source.windowId || tab.status === "loading") throw new Error("来源页面已改变或正在加载，请稍后重试。");
  };
  await check();
  signal?.throwIfAborted();
  const operationId = crypto.randomUUID();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => {
      reject(signal.reason);
      void browser.scripting.executeScript({ target: { tabId: source.tabId }, world: "MAIN",
        func: id => { const active = window[Symbol.for("autoreply.review-reader")]; if (active?.operationId === id) active.cancel(); },
        args: [operationId] }).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    const injected = browser.scripting.executeScript({ target: { tabId: source.tabId }, world: "MAIN", func: observeReviewPage, args: [operationId] });
    const results = await Promise.race([injected, cancelled]);
    signal?.throwIfAborted();
    await check();
    const batch = results.find(item => item.frameId === 0)?.result;
    if (batch?.error) throw Object.assign(new Error(batch.error), { code: "PAGE_READ_FAILED" });
    return validateReviewBatch(batch);
  } finally { signal?.removeEventListener("abort", abort); }
}
