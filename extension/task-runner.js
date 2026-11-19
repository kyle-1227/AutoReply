import { emptyTask, newReview, demoReviews, demoReply, STEP_MS, MANUAL_REASON, isActive, isFinished, hasFailedReviews } from "./model.js";
import { createQueue } from "./queue.js";
import { reviewIdentity, validateReviewBatch, readFailureRecord } from "./review-context.js";
import { pendingReviews, reviewProductId } from "./review-queue.js";

// CDN signatures/hosts can rotate without the buyer editing the attached media.
// Explicit fields keep comparisons stable when browser storage reorders object keys.
const reviewContent = review => JSON.stringify([review.reviewId, review.text, review.rating, review.modifiedAt,
  review.product.productId, review.product.skuId, review.product.title, review.product.variant,
  review.platformReply.count, review.platformReply.canReply,
  review.attachments.map(({ kind, url }) => [kind, new URL(url).pathname]),
]);
const publishUncertain = "无法确认这条评价是否已发布。请先在店铺评价页核对，任务不会自动重发这条回复。";
const publishManual = {
  ineligible: "评价已回复、已移出未回复列表或当前不允许回复，请在店铺评价页核对。",
  changed: "评价内容或商品信息已变化，请在店铺评价页核对后处理。",
  duplicate: "其他任务已处理这条评价或正在发布，请在店铺评价页核对。",
};

/**
 * One owner for a task queue. Storage, generation and browser reads are injected so
 * cancellation/recovery behavior can be checked without launching a browser.
 */
export class TaskRunner {
  constructor({ load, save, onChange = () => {}, wakeup = async () => {}, now = Date.now,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer), stepMs = STEP_MS, canProcess = async () => true,
    readReviews, generateReply, publishReply, canRead = async () => true, controlRun = async () => {} }) {
    Object.assign(this, { load, save, onChange, wakeup, now, setTimer, clearTimer, stepMs, canProcess, readReviews, generateReply, publishReply, canRead, controlRun });
    this.state = emptyTask();
    this.enqueue = createQueue();
    this.timer = null;
    this.work = null;
    this.controlAbort = null;
    this.lastControl = "";
    this.needsScan = false;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  get generation() { return this.state.generation; }

  cancelTick() {
    this.state.generation += 1;
    this.clearTimer(this.timer);
    this.timer = null;
    this.controlAbort?.abort();
    this.work?.controller.abort(new DOMException("当前处理已停止。", "AbortError"));
    this.work = null;
    this.state.reading = false;
    this.state.callState = null;
  }

  resetCurrent() {
    const current = this.state.reviews.find(review => review.id === this.state.currentId);
    if (current?.status === "processing") {
      if (this.state.mode === "llm") this.state.queueCursor = { productId: reviewProductId(current), reviewId: current.id };
      if (current.publishState === "dispatching") {
        current.status = "manual";
        current.publishState = "uncertain";
        current.manualReason = publishUncertain;
      } else {
        current.status = "pending";
        if (current.publishState !== "ready") current.reply = "";
      }
    }
    this.state.currentId = null;
    this.state.phase = 0;
    this.state.nextStepAt = null;
  }

  async restore({ newBrowserSession = false } = {}) {
    const saved = await this.load();
    if (saved?.version === 1 && Array.isArray(saved.reviews)) this.state = { ...emptyTask(), ...saved, reading: false, callState: null };
    this.state.generation = (this.state.generation || 0) + 1;
    if (this.state.status === "ended") this.resetCurrent();
    if (isActive(this.state) && (newBrowserSession || this.state.mode === "llm")) {
      this.resetCurrent();
      this.state.status = "paused";
      if (this.state.mode === "llm") this.state.error = "店铺任务已恢复为暂停，请确认来源页和待人工事项后继续。";
    }
    if (this.state.status === "running") this.claimNext();
    if (this.state.mode === "llm" && this.state.reviewSource) {
      const key = this.lastControl = `${this.generation}:${this.state.status}`;
      void this.controlRun({ source: this.state.reviewSource, generation: this.generation, status: this.state.status }).catch(() => {
        if (this.lastControl === key) this.lastControl = "";
      });
    }
    await this.commit();
    return this.snapshot();
  }

  claimNext() {
    if (this.state.status !== "running" || this.state.currentId) return;
    const next = pendingReviews(this.state)[0];
    if (!next) {
      if (this.state.mode === "llm" && this.state.reviewSource) {
        this.state.nextStepAt = this.now();
        return; // Re-read once at the end to include newly arrived, unseen reviews.
      }
      this.state.status = "completed";
      this.state.nextStepAt = null;
      return;
    }
    next.status = "processing";
    if (this.state.mode === "llm") this.state.queueCursor = { productId: reviewProductId(next), reviewId: next.id };
    this.state.currentId = next.id;
    this.state.phase = 0;
    this.state.nextStepAt = this.now() + (this.state.mode === "llm" ? 0 : this.stepMs);
  }

  async syncRun() {
    if (this.state.mode !== "llm" || !this.state.reviewSource) return;
    if (!["running", "recovering", "paused", "ended", "completed"].includes(this.state.status)) return;
    const key = `${this.generation}:${this.state.status}`;
    if (key === this.lastControl) return;
    const controller = new AbortController();
    this.controlAbort = controller;
    try {
      const result = await this.controlRun({ source: this.state.reviewSource, generation: this.generation, status: this.state.status }, controller.signal);
      if (result?.expiresAt && !hasFailedReviews(this.state)) this.state.expiresAt = result.expiresAt;
      controller.signal.throwIfAborted();
      this.lastControl = key;
    } finally { if (this.controlAbort === controller) this.controlAbort = null; }
  }

  async commit() {
    if (isFinished(this.state)) this.state.queueCursor = null;
    if (hasFailedReviews(this.state)) delete this.state.expiresAt;
    this.state.revision += 1;
    try {
      try { await this.syncRun(); }
      catch (error) {
        if (isActive(this.state)) throw error;
        this.state.error ||= "本机处理已停止，组件连接恢复后可继续。";
      }
      await this.save(this.snapshot());
      await this.wakeup(this.state.status === "running");
    } catch (error) {
      this.cancelTick();
      this.resetCurrent();
      this.state.status = "paused";
      this.state.error = error.name === "AbortError" ? "已停止当前操作。" : error.message;
      // Local cancellation stays immediate even when the backend is unavailable.
      void this.syncRun().catch(() => {});
      await this.save(this.snapshot()).catch(() => {});
      this.onChange();
      throw error;
    }
    this.onChange();
    this.schedule();
  }

  schedule() {
    this.clearTimer(this.timer);
    this.timer = null;
    if (this.state.status !== "running" || this.work) return;
    const expected = this.generation;
    const delay = Math.max(0, this.state.nextStepAt - this.now());
    this.timer = this.setTimer(() => {
      this.tick(expected).catch(() => {}); // commit publishes any storage error.
    }, delay);
  }

  tick(expected = this.generation) {
    return this.enqueue(async () => {
      if (expected !== this.generation || this.state.status !== "running") return;
      if (!await this.canProcess()) return;
      if (expected !== this.generation || this.state.status !== "running") return;
      if (this.state.mode === "llm") {
        this.launchGeneration(expected);
        return;
      }
      this.claimNext();
      if (this.state.status !== "running") return this.commit();
      if (this.now() < this.state.nextStepAt) return this.schedule();
      const current = this.state.reviews.find(review => review.id === this.state.currentId);
      if (this.state.phase < 2) {
        this.state.phase += 1;
        if (this.state.phase === 2) current.reply = demoReply(current);
        this.state.nextStepAt = this.now() + this.stepMs;
      } else {
        current.status = "replied";
        current.completedAt = this.now();
        this.state.currentId = null;
        this.state.phase = 0;
        this.state.nextStepAt = null;
        this.claimNext();
      }
      await this.commit();
    });
  }

  mergeBatch(batch) {
    validateReviewBatch(batch);
    if (this.state.reviewSource && (this.state.reviewSource.shopId !== batch.source.shopId ||
        this.state.reviewSource.platform !== batch.source.platform || this.state.reviewSource.market !== batch.source.market)) {
      throw new Error("当前任务的店铺发生变化，请结束任务并清空后重新读取。");
    }
    if (this.state.mode !== "llm" && this.state.reviews.length) throw new Error("请先清空演示记录，再读取店铺评价。");
    this.state.mode = "llm";
    this.state.reviewSource = structuredClone(batch.source);
    this.state.pagination = { ...batch.pagination };
    const previous = new Map(this.state.reviews.filter(review => review.platformReview)
      .map(review => [reviewIdentity(review.source, review.platformReview), review]));
    const present = new Set(batch.reviews.map(review => reviewIdentity(batch.source, review)));
    for (const [key, review] of previous) {
      if (!present.has(key) && ["pending", "failed"].includes(review.status)) {
        review.status = "manual";
        review.manualReason = "本次未回复列表中已不存在该评价，请人工核对店铺状态。";
        if (review.publishState === "ready") review.publishState = "skipped";
        delete this.state.expiresAt;
      }
    }
    let added = 0;
    for (const input of batch.reviews) {
      const identity = reviewIdentity(batch.source, input);
      let review = previous.get(identity);
      const eligible = input.platformReply.count === 0 && input.platformReply.canReply;
      if (!eligible) {
        if (["pending", "failed"].includes(review?.status)) {
          review.status = "manual";
          review.manualReason = "店铺评价已回复或当前不允许回复，请人工核对。";
          if (review.publishState === "ready") review.publishState = "skipped";
          delete this.state.expiresAt;
        }
        continue;
      }
      if (!review) {
        review = { id: crypto.randomUUID(), text: input.text, status: "pending", manualReason: "",
          reply: "", createdAt: this.now(), completedAt: null, source: { ...batch.source } };
        this.state.reviews.push(review);
        previous.set(identity, review);
        added++;
      } else if (reviewContent(review.platformReview) !== reviewContent(input)) {
        if (review.status === "replied" || (review.publishState && review.status === "manual") ||
            (this.publishReply && review.status === "generated")) continue;
        const preserved = ["manual", "failed"].includes(review.status);
        Object.assign(review, { text: input.text, status: preserved ? review.status : "pending",
          reply: "", generationRecord: null, completedAt: null, retryAt: null });
        delete review.publishState;
        if (!preserved) { review.manualReason = ""; added++; }
      }
      // Refresh signed media URLs even when the review itself has not changed.
      review.platformReview = structuredClone(input);
      review.attachments = input.attachments.map((attachment, index) => ({ ...attachment, id: `${review.id}:${index}` }));
    }
    return added;
  }

  async read() {
    if (this.work || isActive(this.state)) throw new Error("请先暂停当前处理，再重新读取评价。");
    if (!this.readReviews) throw new Error("当前来源页无法读取评价。");
    const work = { generation: this.generation, controller: new AbortController() };
    this.work = work;
    this.state.reading = true;
    this.state.error = "";
    const current = () => this.work === work && this.generation === work.generation;
    try {
      await this.enqueue(() => this.commit());
      if (!current()) throw new DOMException("评价读取已停止。", "AbortError");
      if (!await this.canRead()) throw new Error("当前来源页无法读取评价。");
      if (!current()) throw new DOMException("评价读取已停止。", "AbortError");
      const batch = await this.readReviews({ signal: work.controller.signal });
      await this.enqueue(async () => {
        if (!current() || !await this.canRead() || !current()) throw new DOMException("来源页已改变。", "AbortError");
        this.mergeBatch(batch);
        this.state.reading = false;
        this.state.endReason = "";
        if (isFinished(this.state)) this.state.status = "idle";
        await this.commit();
      });
      return this.snapshot();
    } catch (error) {
      if (current()) await this.enqueue(async () => {
        if (!current()) return;
        this.state.reading = false;
        this.state.error = error.message;
        await this.commit();
      });
      throw error;
    } finally { if (this.work === work) this.work = null; }
  }

  launchGeneration(expected) {
    if (this.work) return;
    const work = { generation: expected, controller: new AbortController() };
    this.work = work;
    void this.runGeneration(work).catch(() => {}); // commit publishes storage failures.
  }

  advanceAfterReview(review) {
    this.state.queueCursor = { productId: reviewProductId(review), reviewId: null };
    this.work = null;
    this.state.callState = null;
    this.state.currentId = null;
    this.claimNext();
    return this.commit();
  }

  async runPublication(review, work, current) {
    const failure = message => Object.assign(new Error(message), { code: "PUBLISH_FAILED" });
    const result = await this.publishReply(structuredClone(review), {
      signal: work.controller.signal,
      beforeSubmit: () => this.enqueue(async () => {
        if (!current() || !await this.canProcess() || !current()) throw new DOMException("已停止发布，来源页已改变。", "AbortError");
        review.publishState = "dispatching";
        await this.commit();
      }),
    });
    await this.enqueue(async () => {
      if (!current() || !await this.canProcess() || !current()) return;
      if (result.state === "published" && review.publishState === "dispatching") {
        review.status = "replied";
        review.completedAt = this.now();
        delete review.publishState;
      } else if (Object.hasOwn(publishManual, result.state)) {
        review.status = "manual";
        review.manualReason = publishManual[result.state];
        review.publishState = "skipped";
      } else if (result.state === "blocked") {
        review.publishState = "ready";
        throw failure(result.message || "发布前校验失败，已暂停任务。");
      } else if (result.state === "rejected") {
        review.status = "manual";
        review.publishState = "rejected";
        review.manualReason = "平台拒绝提交这条回复，请在店铺评价页检查账号权限和评价状态。";
        throw failure(review.manualReason);
      } else {
        throw failure(publishUncertain);
      }
      await this.advanceAfterReview(review);
    });
  }

  async runGeneration(work) {
    const current = () => this.work === work && work.generation === this.generation && this.state.status === "running";
    const review = this.state.reviews.find(item => item.id === this.state.currentId);
    try {
      if (!current()) return;
      if (!review || this.needsScan) {
        const batch = await this.readReviews({ signal: work.controller.signal });
        await this.enqueue(async () => {
          if (!current() || !await this.canProcess() || !current()) return;
          this.resetCurrent();
          const added = this.mergeBatch(batch);
          const firstScan = this.needsScan;
          this.needsScan = false;
          this.work = null;
          if (!firstScan && !added && !this.state.reviews.some(item => item.status === "pending")) this.state.status = "completed";
          else this.claimNext();
          await this.commit();
        });
        return;
      }
      if (review.publishState === "ready" && this.publishReply) {
        await this.runPublication(review, work, current);
        return;
      }
      if (review.retryAt > this.now()) throw Object.assign(new Error(`服务要求等待，请于 ${new Date(review.retryAt).toLocaleTimeString()} 后继续。`), { code: "RETRY_WAIT" });
      const generated = await this.generateReply(structuredClone(review), {
        source: this.state.reviewSource, generation: work.generation, signal: work.controller.signal,
        onStateChange: callState => {
          if (!current()) return;
          void this.enqueue(async () => {
            if (!current() || review.publishState) return;
            this.state.callState = callState;
            review.retryAt = callState.nextRetryAt;
            await this.commit();
          }).catch(() => {});
        },
      });
      await this.enqueue(async () => {
        if (!current() || !await this.canProcess() || !current()) return;
        review.reply = generated.result.replyText;
        review.status = generated.result.decision === "reply" ? "generated" : "manual";
        review.manualReason = generated.result.reason;
        review.generationRecord = { ...generated.record, result: generated.result };
        delete review.failureRecord;
        review.completedAt = this.now();
        review.retryAt = null;
        if (this.publishReply && review.platformReview && review.status === "generated") {
          review.status = "processing";
          review.publishState = "ready";
          review.completedAt = null;
          this.state.callState = null;
          await this.commit();
          return;
        }
        await this.advanceAfterReview(review);
      });
      if (current() && review.publishState === "ready") await this.runPublication(review, work, current);
    } catch (error) {
      if (!current()) return;
      await this.enqueue(async () => {
        if (!current()) return;
        const failure = error.code === "VIDEO_FALLBACK_FAILED" && readFailureRecord(error.failureRecord);
        if (failure && review) {
          if (!await this.canProcess() || !current()) return;
          Object.assign(review, { status: "failed", failureRecord: failure, reply: "", completedAt: null, retryAt: null, generationRecord: null });
          await this.advanceAfterReview(review);
          return;
        }
        const dispatching = review?.publishState === "dispatching";
        const known = ["INPUT_INVALID", "OUTPUT_INVALID", "MODEL_REFUSED", "CONTEXT_INVALID", "MEDIA_UNAVAILABLE", "KEY_MISSING", "RETRY_WAIT", "PAGE_READ_FAILED", "GENERATION_FAILED", "COST_STORAGE_FAILED", "PUBLISH_FAILED"];
        this.cancelTick();
        this.resetCurrent();
        this.state.status = "paused";
        let message = "评价读取或模型调用失败，任务已暂停，请检查页面、网络和本机组件后继续。";
        if (dispatching) message = publishUncertain;
        else if (known.includes(error.code)) message = error.message;
        else if (review?.publishState === "ready") message = "准备发布时无法连接原评价页，任务已暂停，生成的回复已保留。";
        else if (error.status) message = `模型请求失败（HTTP ${error.status}），任务已暂停，请负责人检查模型账户后继续。`;
        this.state.error = message;
        await this.commit();
      });
    }
  }

  startProcessing() {
    this.cancelTick();
    this.state.status = "running";
    this.needsScan = this.state.mode === "llm" && Boolean(this.state.reviewSource);
    this.claimNext();
  }

  command(type, payload = {}) {
    // Invalidate a queued/late timer before waiting for any pending storage write.
    if (["PAUSE", "END", "RECONNECTING"].includes(type)) this.cancelTick();
    return this.enqueue(async () => {
      this.state.error = "";
      if (this.state.reading && !["PAUSE", "END"].includes(type)) throw new Error("正在读取评价，请稍后操作或立即暂停。");
      switch (type) {
        case "START":
          if (this.state.status === "running") return this.snapshot();
          delete this.state.expiresAt;
          this.state.endReason = "";
          this.startProcessing();
          break;
        case "PAUSE":
          if (isActive(this.state) || this.work || this.state.status === "idle") {
            this.resetCurrent();
            this.state.status = "paused";
          }
          this.state.error = payload.reason || "";
          break;
        case "RECONNECTING":
          if (this.state.status === "running") {
            const dispatching = this.state.reviews.find(review => review.id === this.state.currentId)?.publishState === "dispatching";
            this.resetCurrent();
            this.state.status = dispatching ? "paused" : "recovering";
            if (dispatching) this.state.error = publishUncertain;
          }
          break;
        case "RECONNECTED":
          if (this.state.status === "recovering") this.startProcessing();
          break;
        case "END":
          this.resetCurrent();
          this.state.status = "ended";
          this.state.endReason = payload.reason || "已手动结束任务。";
          break;
        case "ADD":
        case "SAMPLES":
          if (type === "SAMPLES" && this.state.mode === "llm") throw new Error("请先清空店铺记录，再载入演示评价。");
          if (type === "ADD" && this.state.mode === "llm" && payload.attachments?.length) throw new Error("手动附件当前用于演示；真实生成请读取店铺评价附件。");
          this.state.reviews.push(...(type === "ADD" ? [newReview(payload)] : demoReviews()));
          this.state.endReason = "";
          if (isFinished(this.state)) this.state.status = "idle";
          this.claimNext();
          break;
        case "RETRY_FAILED": {
          const selected = this.retryReviews(payload);
          selected.forEach(review => { review.status = "pending"; review.retryAt = null; });
          delete this.state.expiresAt;
          this.state.endReason = "";
          if (isActive(this.state)) this.claimNext();
          else this.startProcessing();
          break;
        }
        case "MANUAL": {
          const review = this.getReview(payload.id);
          if (!["pending", "failed"].includes(review.status)) throw new Error("请先暂停当前处理，再标记尚未完成的评价。");
          review.status = "manual";
          review.manualReason = String(payload.reason || "").trim() || MANUAL_REASON;
          if (review.publishState === "ready") review.publishState = "skipped";
          delete this.state.expiresAt;
          break;
        }
        case "ATTACHMENTS": {
          const review = this.getReview(payload.id);
          if (review.platformReview) throw new Error("店铺附件由评价页读取，不能用本地文件替换。");
          review.attachments = payload.attachments;
          break;
        }
        case "REMOVE": {
          const review = this.getReview(payload.id);
          if (!["pending", "failed"].includes(review.status)) throw new Error("只能移除待处理或失败的评价。");
          this.state.reviews = this.state.reviews.filter(item => item.id !== review.id);
          delete this.state.expiresAt;
          break;
        }
        case "CLEAR": {
          if (isActive(this.state)) throw new Error("请先暂停任务，再清空记录。");
          const paused = this.state.status === "paused";
          const costEpoch = (this.state.costEpoch || 0) + 1;
          if (this.state.mode === "llm") {
            this.state.status = "ended";
            await this.syncRun();
          }
          this.cancelTick();
          this.state = { ...emptyTask(), revision: this.state.revision, generation: this.generation,
            costEpoch, status: paused ? "paused" : "idle" };
          break;
        }
        default:
          throw new Error("无法识别这个操作，请重新打开侧边栏后重试。");
      }
      await this.commit();
      return this.snapshot();
    });
  }

  retryReviews(payload) {
    const selected = payload?.all === true && Object.keys(payload).length === 1 ? this.state.reviews.filter(review => review.status === "failed") :
      typeof payload?.id === "string" && Object.keys(payload).length === 1 ? [this.getReview(payload.id)] : [];
    if (!selected.length || selected.some(review => review.status !== "failed")) throw new Error("没有可重试的失败评价，请刷新列表。");
    return selected;
  }

  getReview(id) {
    const review = this.state.reviews.find(item => item.id === id);
    if (!review) throw new Error("这条评价已经不存在，请刷新列表。");
    return review;
  }
}
