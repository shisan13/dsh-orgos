/**
 * 重连退避策略(技术设计 §9.1:连接失败指数退避重连,上限后发 im-disconnected)
 *
 * - 指数退避:delay = base * 2^attempt,封顶 maxDelay;
 * - maxAttempts 后放弃:适配器发 team/im-disconnected(由绑定层消费);
 * - 确定性(无随机抖动),fixture 可精确断言退避序列。
 */

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
  maxAttempts?: number
}

export class BackoffPolicy {
  readonly baseMs: number
  readonly maxMs: number
  readonly maxAttempts: number

  constructor(opts?: BackoffOptions) {
    this.baseMs = opts?.baseMs ?? 1000
    this.maxMs = opts?.maxMs ?? 60_000
    this.maxAttempts = opts?.maxAttempts ?? 5
  }

  /** 第 attempt 次失败后的等待毫秒(attempt 从 1 起) */
  delayFor(attempt: number): number {
    if (attempt < 1) return 0
    const exp = Math.pow(2, attempt - 1)
    return Math.min(this.baseMs * exp, this.maxMs)
  }

  /** 是否已超过重试上限(继续重连无意义) */
  exhausted(attempt: number): boolean {
    return attempt > this.maxAttempts
  }
}
