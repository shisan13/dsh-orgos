/** dsh-orgos-im-discord 导出入口(纯协议层,harness-agnostic) */
export { discordFrameToMessage, parseCustomId } from './events.ts'
export type { DiscordEventResult } from './events.ts'
export { renderCard } from './cards.ts'
export type { AnyCard, DiscordButton, DiscordCardPayload } from './cards.ts'
export { segmentText, convertTables, convertLatex, splitByLength, DISCORD_MAX } from './format.ts'
export type { SegmentOptions, TextSegment } from './format.ts'
export { DiscordAdapter } from './DiscordAdapter.ts'
export type { DiscordAdapterOptions, DiscordCredentials, DiscordTransport } from './DiscordAdapter.ts'
