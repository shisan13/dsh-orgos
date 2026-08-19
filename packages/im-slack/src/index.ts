/** dsh-orgos-im-slack 导出入口(纯协议层,harness-agnostic) */
export { slackEnvelopeToMessage, parseValue, slackTsToIso } from './events.ts'
export type { SlackEventResult } from './events.ts'
export { renderCard } from './cards.ts'
export type { AnyCard, SlackBlock, SlackCardPayload } from './cards.ts'
export { segmentText, convertTables, convertLatex, splitByLength, SLACK_MAX } from './format.ts'
export type { SegmentOptions, TextSegment } from './format.ts'
export { SlackAdapter } from './SlackAdapter.ts'
export type { SlackAdapterOptions, SlackCredentials, SlackTransport } from './SlackAdapter.ts'
