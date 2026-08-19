/** dsh-orgos-im-dingtalk 导出入口(纯协议层,harness-agnostic) */
export { dingtalkEnvelopeToMessage, parseCardContent } from './events.ts'
export type { DingtalkEventResult } from './events.ts'
export { renderCard } from './cards.ts'
export type { AnyCard, DingtalkButton, DingtalkCardPayload } from './cards.ts'
export { segmentText, convertTables, convertLatex, splitByLength, DINGTALK_MAX } from './format.ts'
export type { SegmentOptions, TextSegment } from './format.ts'
export { DingtalkAdapter } from './DingtalkAdapter.ts'
export type { DingtalkAdapterOptions, DingtalkCredentials, DingtalkTransport } from './DingtalkAdapter.ts'
