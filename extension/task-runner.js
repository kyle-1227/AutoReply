import { emptyTask, newReview, demoReviews, demoReply, STEP_MS, MANUAL_REASON, isActive } from "./model.js";
import { createQueue } from "./queue.js";

/**
 * One owner for the demo queue. Storage and browser wake-ups are injected so the
 * cancellation/recovery behavior can be checked without launching a browser.
 */
export class TaskRunner {
  constructor({ load, save, publish = () => {}, wakeup = async () => {}, now = Date.now,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = timer => clearTimeout(timer), stepMs = STEP_MS, canProcess = async () => true }) {
    Object.assign(this, { load, save, publish, wakeup, now, setTimer, clearTimer, stepMs, canProcess });
    this.state = emptyTask();
    this.enqueue = createQueue();
    this.generation = 0;
    this.timer = null;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  cancelTick() {
    this.generation += 1;
    this.state.generation = this.generation;
    this.clearTimer(this.timer);
    this.timer = null;
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
    if (saved?.version === 1 && Array.isArray(saved.reviews)) this.state = saved;
    this.generation = (this.state.generation || 0) + 1;
    this.state.generation = this.generation;
    if (this.state.status === "ended") this.resetCurrent();
    if (isActive(this.state) && newBrowserSession) {
      this.resetCurrent();
      this.state.status = "paused";
    }
    if (this.state.status === "running") this.claimNext();
    await this.commit();
    return this.snapshot();
  }

  claimNext() {
    if (this.state.status !== "running" || this.state.currentId) return;
    const next = this.state.reviews.find(review => review.status === "pending");
    if (!next) {
      this.state.status = "completed";
      this.state.nextStepAt = null;
      return;
    }
    next.status = "processing";
    this.state.currentId = next.id;
    this.state.phase = 0;
    this.state.nextStepAt = this.now() + this.stepMs;
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
      this.state.error = "本机保存或任务调度失败，已暂停。请重试；空间不足时可先清空演示记录。";
      this.publish(this.snapshot());
      throw error;
    }
    this.publish(this.snapshot());
    this.schedule();
  }

  schedule() {
    this.clearTimer(this.timer);
    this.timer = null;
    if (this.state.status !== "running") return;
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

  command(type, payload = {}) {
    // Invalidate a queued/late timer before waiting for any pending storage write.
    if (["PAUSE", "END", "RECONNECTING"].includes(type)) this.cancelTick();
    return this.enqueue(async () => {
      this.state.error = "";
      switch (type) {
        case "START":
          if (this.state.status === "running") return this.snapshot();
          this.cancelTick();
          this.state.status = "running";
          this.state.endReason = "";
          this.claimNext();
          break;
        case "PAUSE":
          if (isActive(this.state)) {
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
          if (isActive(this.state)) throw new Error("请先暂停演示，再清空记录。");
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
