/**
 * im-telegram 测试:规范化/卡片/分段/长轮询生命周期(record-replay)
 */
import { describe, expect, it } from 'vitest'
import { telegramUpdateToMessage, parseData, textIncludesMention } from './events.ts'
import { renderApprovalCard, renderQuestionCard, renderTaskCard, renderCard } from './cards.ts'
import { segmentText, convertTables, convertLatex, splitByLength, TELEGRAM_MAX } from './format.ts'
import { TelegramAdapter, type TelegramTransport } from './TelegramAdapter.ts'
import { BackoffPolicy } from 'dsh-orgos-im-gateway'
import {
  BOT_USERNAME,
  callbackApprovalUpdate,
  expectedGroupMention,
  groupMentionUpdate,
  groupPlainUpdate,
  malformedUpdate,
  photoUpdate,
  privateTextUpdate,
  replyUpdate,
  unknownUpdate,
} from './fixtures/telegramEvents.ts'

describe('Given Telegram Update 规范化(§9.2)', () => {
  it('When 私聊文本 Then kind=text / peer=direct', () => {
    const r = telegramUpdateToMessage(privateTextUpdate, BOT_USERNAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer).toEqual({ kind: 'direct', id: '111' })
    expect(r.msg.sender.name).toBe('Alice')
  })

  it('When 群 @bot Then kind=mention', () => {
    const r = telegramUpdateToMessage(groupMentionUpdate, BOT_USERNAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect({ ...r.msg, ts: undefined }).toEqual({ ...expectedGroupMention, ts: undefined })
    expect(r.msg.ts).toBe(new Date(1720000001 * 1000).toISOString())
  })

  it('When 群未 @bot Then kind=text(路由层静默候选)', () => {
    const r = telegramUpdateToMessage(groupPlainUpdate, BOT_USERNAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer.kind).toBe('group')
  })

  it('When 回复消息 Then kind=reply 且 threadId 为被回复消息', () => {
    const r = telegramUpdateToMessage(replyUpdate)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('reply')
    expect(r.msg.peer.threadId).toBe('2')
  })

  it('When 图片消息 Then kind=attachment 且取最大尺寸 file_id', () => {
    const r = telegramUpdateToMessage(photoUpdate)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('attachment')
    expect(r.msg.attachment?.ref).toBe('big_1')
  })

  it('When 按钮回调 Then kind=approval_reply 且 approval 解析自紧凑 data', () => {
    const r = telegramUpdateToMessage(callbackApprovalUpdate)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('approval_reply')
    expect(r.msg.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
    expect(r.msg.messageId).toBe('cq_1')
  })

  it('When 非法 update Then 返回原因(不抛异常)', () => {
    expect(telegramUpdateToMessage(unknownUpdate).ok).toBe(false)
    expect(telegramUpdateToMessage(malformedUpdate).ok).toBe(false)
    expect(telegramUpdateToMessage(null).ok).toBe(false)
    expect(telegramUpdateToMessage({ update_id: 1, message: { message_id: 1 } }).ok).toBe(false)
  })

  it('When data 无法解析/动作非法 Then 拒绝', () => {
    expect(parseData('not-json')).toBeUndefined()
    expect(parseData('{"a":"x"}')).toBeUndefined()
    expect(parseData('{"a":"x","act":"hack"}')).toBeUndefined()
    // 兼容完整形态(与其他平台解析器同构返回)
    expect(parseData('{"approvalId":"x","action":"deny"}')).toEqual({ approvalId: 'x', action: 'deny' })
  })

  it('When 提及判定 Then entities 优先,无 entities 按文本前缀', () => {
    expect(textIncludesMention('@my_orgos_bot hi', BOT_USERNAME, [{ type: 'mention', offset: 0, length: 13 }])).toBe(true)
    expect(textIncludesMention('@other hi', BOT_USERNAME, [{ type: 'mention', offset: 0, length: 6 }])).toBe(false)
    expect(textIncludesMention('@my_orgos_bot hi', BOT_USERNAME)).toBe(true)
    expect(textIncludesMention('hi @my_orgos_bot', BOT_USERNAME)).toBe(true)
    expect(textIncludesMention('plain', BOT_USERNAME)).toBe(false)
    expect(textIncludesMention(undefined, BOT_USERNAME)).toBe(false)
  })
})

describe('Given Telegram 卡片渲染(§9.3)', () => {
  it('When 审批卡 Then 内联键盘按钮 callback_data 携带紧凑 JSON', () => {
    const card = renderApprovalCard({ kind: 'approval', approvalId: 'ap_1', title: '审批', body: '执行命令' })
    const buttons = card.reply_markup?.inline_keyboard[0]
    expect(buttons?.map((b) => b.callback_data)).toEqual([
      '{"a":"ap_1","act":"allow"}',
      '{"a":"ap_1","act":"deny"}',
    ])
  })

  it('When 决策卡/任务卡 Then 按钮齐全', () => {
    const q = renderQuestionCard({ kind: 'question', questionId: 'q_1', title: 't', body: 'b', options: ['agree', 'reject', 'modify'] })
    expect(q.reply_markup?.inline_keyboard[0]).toHaveLength(3)
    const t = renderTaskCard({ kind: 'task', taskId: 't_1', title: '任务', body: 'b', actions: ['accept', 'reject', 'report'] })
    expect(t.reply_markup?.inline_keyboard[0]).toHaveLength(3)
    expect(t.text).toContain('任务')
  })

  it('Then renderCard 按 kind 分发', () => {
    expect(renderCard({ kind: 'approval', approvalId: 'a', title: 't', body: 'b' }).text).toBe('t\nb')
    expect(renderCard({ kind: 'question', questionId: 'q', title: 't2', body: 'b', options: ['agree'] }).text).toBe('t2\nb')
  })
})

describe('Given Telegram 长消息分段(4096 限制)', () => {
  it('Then TELEGRAM_MAX = 4096;短文本单段', () => {
    expect(TELEGRAM_MAX).toBe(4096)
    expect(segmentText('你好')).toEqual([{ reason: 'length', text: '你好' }])
  })

  it('Then 超长按行边界分段且代码块不拆', () => {
    const long = 'a'.repeat(100) + '\n' + 'b'.repeat(5000)
    const segs = splitByLength(long, 150)
    expect(segs.length).toBeGreaterThan(1)
    expect(segs[0]!.text.endsWith('\n')).toBe(true)
    const code = 'x'.repeat(100) + '```\n' + 'y'.repeat(5000) + '\n```' + 'z'.repeat(50)
    const out = segmentText(code, 3000)
    expect(out.some((s) => s.text.includes('```\n') && s.text.endsWith('```'))).toBe(true)
  })

  it('Then MD 表格转列表、LaTeX 转代码块', () => {
    expect(convertTables('| A | B |\n| --- | --- |\n| 1 | 2 |')).toContain('• **A** | **B**')
    expect(convertTables('| A | B |\n| --- | --- |\n| 1 | 2 |')).toContain('• 1 | 2')
    expect(convertLatex('公式 $E=mc^2$')).toBe('公式 `E=mc^2`')
  })
})

describe('Given TelegramAdapter 长轮询生命周期', () => {
  function fakeTransport(): {
    transport: TelegramTransport
    calls: { getUpdates: number; sendMessage: unknown[]; answerCallback: number }
    pushUpdates(updates: unknown[]): void
    failNext: boolean
  } {
    const state: {
      calls: { getUpdates: number; sendMessage: unknown[]; answerCallback: number }
      pending: ((v: { updates: unknown[] }) => void) | undefined
      failNext: boolean
    } = {
      calls: { getUpdates: 0, sendMessage: [], answerCallback: 0 },
      pending: undefined,
      failNext: false,
    }
    const transport: TelegramTransport = {
      async getUpdates() {
        state.calls.getUpdates += 1
        if (state.failNext) {
          state.failNext = false
          throw new Error('network down')
        }
        // 挂起直到测试 pushUpdates(可控轮询节奏)
        return new Promise<{ updates: unknown[] }>((resolve) => {
          state.pending = resolve
        })
      },
      async sendMessage(chatId, payload) {
        state.calls.sendMessage.push({ chatId, payload })
      },
      async answerCallbackQuery() {
        state.calls.answerCallback += 1
      },
    }
    return {
      transport,
      calls: state.calls,
      get failNext() {
        return state.failNext
      },
      set failNext(v: boolean) {
        state.failNext = v
      },
      pushUpdates(updates) {
        const resolve = state.pending
        state.pending = undefined
        resolve?.({ updates })
      },
    }
  }

  /** 让事件循环跑几轮(处理 pollLoop 的异步迭代与 handleEvent 链) */
  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('When 轮询收到 update Then 规范化并通过 onInbound;重复 update 去重', async () => {
    const t = fakeTransport()
    const inbound: string[] = []
    const adapter = new TelegramAdapter({
      credentials: { token: 'bot:token' },
      transport: t.transport,
      botUsername: BOT_USERNAME,
      onInbound: (msg) => {
        inbound.push(`${msg.kind}:${msg.peer.id}:${msg.messageId}`)
      },
    })
    await adapter.start()
    expect(t.calls.getUpdates).toBe(1)
    // 第一轮:两条 update
    t.pushUpdates([groupMentionUpdate, privateTextUpdate])
    await flush()
    expect(inbound).toEqual(['mention:-100123:2', 'text:111:1'])
    // 第二轮:重复 update(重放)→ 去重 + 新按钮回调
    t.pushUpdates([groupMentionUpdate, callbackApprovalUpdate])
    await flush()
    expect(inbound).toEqual(['mention:-100123:2', 'text:111:1', 'approval_reply:111:cq_1'])
    // 第三轮:空(offset 持续推进)
    t.pushUpdates([])
    await flush()
    expect(adapter.isStarted()).toBe(true)
    await adapter.stop()
    expect(adapter.isStarted()).toBe(false)
  })

  it('When 轮询失败 Then 退避后重试;耗尽后 disconnected', async () => {
    const t = fakeTransport()
    const states: string[] = []
    const adapter = new TelegramAdapter({
      credentials: { token: 't' },
      transport: t.transport,
      backoff: new BackoffPolicy({ baseMs: 10, maxMs: 40, maxAttempts: 2 }),
      onConnection: (state, reason) => states.push(reason ? `${state}:${reason}` : state),
    })
    await adapter.start()
    expect(t.calls.getUpdates).toBe(1)
    // 第一次失败:本轮调用(2)→ 10ms 退避 → 重试(3,挂起)
    t.failNext = true
    t.pushUpdates([])
    await new Promise((r) => setTimeout(r, 30))
    expect(t.calls.getUpdates).toBe(3)
    expect(states.some((s) => s.startsWith('disconnected:network down'))).toBe(true)
    // 第二次失败:调用(4)→ 20ms 退避 → 重试(5,挂起)
    t.failNext = true
    t.pushUpdates([])
    await new Promise((r) => setTimeout(r, 40))
    expect(t.calls.getUpdates).toBe(5)
    // 第三次失败:attempt=3 > maxAttempts=2 → 耗尽,不再重试
    t.failNext = true
    t.pushUpdates([])
    await new Promise((r) => setTimeout(r, 80))
    const callsAfter = t.calls.getUpdates
    await new Promise((r) => setTimeout(r, 100))
    expect(t.calls.getUpdates).toBe(callsAfter)
    await adapter.stop()
  })

  it('When sendText 超长 Then 分段逐段发送;sendCard Then 内联键盘', async () => {
    const t = fakeTransport()
    const adapter = new TelegramAdapter({ credentials: { token: 't' }, transport: t.transport })
    await adapter.start()
    await adapter.sendText({ kind: 'direct', id: '111' }, 'x'.repeat(100) + '\n' + 'y'.repeat(5000))
    expect(t.calls.sendMessage.length).toBeGreaterThan(1)
    await adapter.sendCard({ kind: 'direct', id: '111' }, { kind: 'approval', approvalId: 'a1', title: 't', body: 'b' })
    const last = t.calls.sendMessage.at(-1) as { payload: { replyMarkup?: unknown } }
    expect(last.payload.replyMarkup).toBeTruthy()
    await adapter.stop()
  })

  it('Then start/stop 幂等;重复 start 不启动第二个轮询循环', async () => {
    const t = fakeTransport()
    const adapter = new TelegramAdapter({ credentials: { token: 't' }, transport: t.transport })
    await adapter.start()
    await adapter.start()
    await flush()
    expect(t.calls.getUpdates).toBe(1)
    await adapter.stop()
    await adapter.stop()
  })
})
