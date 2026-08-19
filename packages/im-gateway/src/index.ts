/** dsh-orgos-im-gateway 导出入口(seam 契约 + 规范化 + 幂等 + 出站队列 + 重连退避) */
export * from './types.ts'
export { normalizeMessage, dedupKey, IdempotencySet } from './normalize.ts'
export type { NormalizeIssue, NormalizeResult } from './normalize.ts'
export { OutboundQueue } from './outboundQueue.ts'
export type { EnqueueResult } from './outboundQueue.ts'
export { BackoffPolicy } from './backoff.ts'
export type { BackoffOptions } from './backoff.ts'
