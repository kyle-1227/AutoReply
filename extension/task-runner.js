import { emptyTask, newReview, demoReviews, demoReply, STEP_MS, MANUAL_REASON, isActive } from "./model.js";
import { createQueue } from "./queue.js";
import { reviewIdentity, validateReviewBatch } from "./review-context.js";

// CDN signatures/hosts can rotate without the buyer editing the attached media.
const reviewContent = review => JSON.stringify({ ...review,
  attachments: review.attachments.map(({ kind, url }) => ({ kind, path: new URL(url).pathname })),
});

/**
 * One owner for a task queue. Storage, generation and browser reads are injected so
 * cancellation/recovery behavior can be checked without launching a browser.
 */
export class TaskRunner {
  constructor({ load, save, publish = () => {}, wakeup = async () => {}, now = Date.now,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer), stepMs = STEP_MS, canProcess = async () => true,
    readReviews, generateReply, canRead = async () => true }) {
    Object.assign(this, { load, save, publish, wakeup, now, setTimer, clearTimer, stepMs, canProcess, readReviews, generateReply, canRead });
    this.state = emptyTask();
    this.enqueue = createQueue();
    this.generation = 0;
    this.timer = null;
    this.work = null;
    this.needsScan = false;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  cancelTick() {
    this.generation += 1;
    this.state.generation = this.generation;
    this.clearTimer(this.timer);
    this.timer = null;
    this.work?.controller.abort(new DOMException("当前处理已停止。", "AbortError"));
    this.work = null;
    this.state.reading = false;
    this.state.callState = null;
  }

  resetCurrent() {
    const current = this.state.reviews.find(review => review.id === this.state.currentId);
    if (current?.status === "processing") {
      current.status = "pending";
      current.reply = "";
    }
    this.state.currentId = null;
    this.state.phase = 0;
    this.state.nextStepAt = null;
  }

  async restore({ newBrowserSession = false } = {}) {
    const saved = await this.load();
    if (saved?.version === 1 && Array.isArray(saved.reviews)) this.state = { ...emptyTask(), ...saved, reading: false, callState: null };
    this.generation = (this.state.generation || 0) + 1;
    this.state.generation = this.generation;
    if (this.state.status === "ended") this.resetCurrent();
    if (isActive(this.state) && (newBrowserSession || this.state.mode === "llm")) {
      this.resetCurrent();
      this.state.status = "paused";
      if (this.state.mode === "llm") this.state.error = "生成任务已恢复为暂停，请确认来源页后继续。";
    }
    if (this.state.status === "running") this.claimNext();
    await this.commit();
    return this.snapshot();
  }

  claimNext() {
    if (this.state.status !== "running" || this.state.currentId) return;
    const next = this.state.reviews.find(review => review.status === "pending");
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
    this.state.currentId = next.id;
    this.state.phase = 0;
    this.state.nextStepAt = this.now() + (this.state.mode === "llm" ? 0 : this.stepMs);
  }

  async commit() {
    this.state.revision += 1;
    try {
      await this.save(this.snapshot());
      await this.wakeup(this.state.status === "running");
    } catch (error) {
      this.cancelTick();
      this.resetCurrent();
      this.state.status = "paused";
      this.state.error = "本机保存或任务调度失败，已暂停。请重试；空间不足时可先清空本机记录。";
      this.publish(this.snapshot());
      throw error;
    }
    this.publish(this.snapshot());
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
        this.state.reviewSource.platform !== batch.source.platform)) throw new Error("当前任务的店铺发生变化，请结束任务并清空后重新读取。");
    if (this.state.mode !== "llm" && this.state.reviews.length) throw new Error("请先清空演示记录，再读取店铺评价。");
    this.state.mode = "llm";
    this.state.reviewSource = structuredClone(batch.source);
    this.state.pagination = { ...batch.pagination };
    const previous = new Map(this.state.reviews.filter(review => review.platformReview)
      .map(review => [reviewIdentity(review.source, review.platformReview), review]));
    const present = new Set(batch.reviews.map(review => reviewIdentity(batch.source, review)));
    for (const [key, review] of previous) {
      if (!present.has(key) && review.status === "pending") {
        review.status = "manual";
        review.manualReason = "本次未回复列表中已不存在该评价，请人工核对店铺状态。";
      }
    }
    let added = 0;
    for (const input of batch.reviews) {
      const identity = reviewIdentity(batch.source, input);
      let review = previous.get(identity);
      const eligible = input.platformReply.count === 0 && input.platformReply.canReply;
      if (!eligible) {
        if (review?.status === "pending") { review.status = "manual"; review.manualReason = "店铺评价已回复或当前不允许回复，请人工核对。"; }
        continue;
      }
      if (!review) {
        review = { id: crypto.randomUUID(), text: input.text, status: "pending", manualReason: "",
          reply: "", createdAt: this.now(), completedAt: null, source: { ...batch.source } };
        this.state.reviews.push(review);
        previous.set(identity, review);
        added++;
      } else if (reviewContent(review.platformReview) !== reviewContent(input)) {
        const manual = review.status === "manual";
        Object.assign(review, { text: input.text, status: manual ? "manual" : "pending",
          reply: "", generationRecord: null, completedAt: null, retryAt: null });
        if (!manual) { review.manualReason = ""; added++; }
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
        if (["ended", "completed"].includes(this.state.status)) this.state.status = "idle";
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
      if (review.retryAt > this.now()) throw Object.assign(new Error(`服务要求等待，请于 ${new Date(review.retryAt).toLocaleTimeString()} 后继续。`), { code: "RETRY_WAIT" });
      const generated = await this.generateReply(structuredClone(review), {
        source: this.state.reviewSource, signal: work.controller.signal,
        onStateChange: callState => {
          if (!current()) return;
          void this.enqueue(async () => {
            if (!current()) return;
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
        review.completedAt = this.now();
        review.retryAt = null;
        this.work = null;
        this.state.callState = null;
        this.state.currentId = null;
        this.claimNext();
        await this.commit();
      });
    } catch (error) {
      if (!current()) return;
      await this.enqueue(async () => {
        if (!current()) return;
        const known = ["INPUT_INVALID", "OUTPUT_INVALID", "CONTEXT_INVALID", "MEDIA_UNAVAILABLE", "KEY_MISSING", "RETRY_WAIT", "PAGE_READ_FAILED"];
        this.cancelTick();
        this.resetCurrent();
        this.state.status = "paused";
        this.state.error = known.includes(error.code) ? error.message : error.status
          ? `模型请求失败（HTTP ${error.status}），任务已暂停，请检查生成设置后继续。`
          : "评价读取或模型调用失败，任务已暂停，请检查页面、网络和生成设置后继续。";
        await this.commit();
      });
    }
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
          this.cancelTick();
          this.state.status = "running";
          this.needsScan = this.state.mode === "llm" && Boolean(this.state.reviewSource);
          this.state.endReason = "";
          this.claimNext();
          break;
        case "PAUSE":
          if (isActive(this.state) || this.work || this.state.status === "idle") {
            this.resetCurrent();
            this.state.status = "paused";
          }
          break;
        case "RECONNECTING":
          if (this.state.status === "running") {
            this.resetCurrent();
            this.state.status = "recovering";
          }
          break;
        case "RECONNECTED":
          if (this.state.status === "recovering") {
            this.state.status = "running";
            this.needsScan = this.state.mode === "llm" && Boolean(this.state.reviewSource);
            this.claimNext();
          }
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
          if (["completed", "ended"].includes(this.state.status)) this.state.status = "idle";
          this.claimNext();
          break;
        case "MANUAL": {
          const review = this.getReview(payload.id);
          if (review.status !== "pending") throw new Error("请先暂停当前处理，再标记尚未完成的评价。");
          review.status = "manual";
          review.manualReason = String(payload.reason || "").trim() || MANUAL_REASON;
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
          if (review.status !== "pending") throw new Error("只能移除尚未处理的评价。");
          this.state.reviews = this.state.reviews.filter(item => item.id !== review.id);
          break;
        }
        case "CLEAR":
          if (isActive(this.state)) throw new Error("请先暂停任务，再清空记录。");
          this.cancelTick();
          this.state = { ...emptyTask(), revision: this.state.revision, generation: this.generation,
            status: this.state.status === "paused" ? "paused" : "idle" };
          break;
        default:
          throw new Error("无法识别这个操作，请重新打开侧边栏后重试。");
      }
      await this.commit();
      return this.snapshot();
    });
  }

  getReview(id) {
    const review = this.state.reviews.find(item => item.id === id);
    if (!review) throw new Error("这条评价已经不存在，请刷新列表。");
    return review;
  }
}
