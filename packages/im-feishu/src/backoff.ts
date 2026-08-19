/**
 * 重连退避策略 —— 已公共化到 dsh-orgos-im-gateway(§9.1 通用约定)
 * 此处 re-export 保持 im-feishu 既有导出面兼容(M1 已发布面)。
 */
export { BackoffPolicy } from 'dsh-orgos-im-gateway'
export type { BackoffOptions } from 'dsh-orgos-im-gateway'
