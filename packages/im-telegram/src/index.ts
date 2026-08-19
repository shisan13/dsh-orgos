/** dsh-orgos-im-telegram 导出入口(纯协议层,harness-agnostic) */
export { telegramUpdateToMessage, parseData, textIncludesMention } from './events.ts'
export type { TelegramEventResult } from './events.ts'
export { renderCard, renderApprovalCard, renderQuestionCard, renderTaskCard } from './cards.ts'
export type { AnyCard, TelegramCardPayload, TelegramInlineButton } from './cards.ts'
export { segmentText, convertTables, convertLatex, splitByLength, TELEGRAM_MAX } from './format.ts'
export type { SegmentOptions, TextSegment } from './format.ts'
export { TelegramAdapter } from './TelegramAdapter.ts'
export type { TelegramAdapterOptions, TelegramCredentials, TelegramTransport } from './TelegramAdapter.ts'
