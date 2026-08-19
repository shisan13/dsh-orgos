/**
 * 出站队列(技术设计 §9.1):每 peer FIFO、至少一次投递语义的纯逻辑层。
 *
 * - 每 peer 独立 FIFO(群/私聊互不阻塞);
 * - at-least-once:投递失败(适配器抛错)保留在队首等待重试,由调用方决定重试时机;
 * - 队列容量上限(默认 1000/peer)防止失控,超限拒绝入队并报告(错误反馈给上层)。
 */
import type { OutboundPayload, PeerRef } from './types.ts'

export type EnqueueResult = { ok: true } | { ok: false; reason: string }

export class OutboundQueue {
  private readonly queues = new Map<string, OutboundPayload[]>()
  private readonly capacity: number

  constructor(capacity = 1000) {
    this.capacity = capacity
  }

  private key(target: PeerRef): string {
    return `${target.kind}:${target.id}`
  }

  /** 入队(FIFO 尾部);队满返回失败,不丢已入队内容 */
  enqueue(target: PeerRef, payload: OutboundPayload): EnqueueResult {
    const k = this.key(target)
    const q = this.queues.get(k) ?? []
    if (q.length >= this.capacity) {
      return { ok: false, reason: `peer ${target.id} 出站队列已满(${this.capacity})` }
    }
    q.push(payload)
    this.queues.set(k, q)
    return { ok: true }
  }

  /** 取队首(FIFO 头部);空返回 undefined */
  peek(target: PeerRef): OutboundPayload | undefined {
    const q = this.queues.get(this.key(target))
    return q?.[0]
  }

  /** 出队成功(投递完成 ack);返回被移除的负载 */
  dequeue(target: PeerRef): OutboundPayload | undefined {
    const k = this.key(target)
    const q = this.queues.get(k)
    const head = q?.shift()
    if (q !== undefined && q.length === 0) this.queues.delete(k)
    return head
  }

  /** 队首失败:不动队列(保留重试),由调用方决定重试时机 */
  length(target: PeerRef): number {
    return this.queues.get(this.key(target))?.length ?? 0
  }

  total(): number {
    let n = 0
    for (const q of this.queues.values()) n += q.length
    return n
  }
}
