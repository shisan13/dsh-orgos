/**
 * im-discord 测试:Gateway 帧规范化/组件渲染/2000 分段/适配器生命周期(record-replay)
 */
import { describe, expect, it, vi } from 'vitest'
import { discordFrameToMessage, parseCustomId } from './events.ts'
import { renderCard } from './cards.ts'
import { segmentText, convertTables, convertLatex, splitByLength, DISCORD_MAX } from './format.ts'
import { DiscordAdapter, type DiscordTransport } from './DiscordAdapter.ts'
import { BackoffPolicy } from 'dsh-orgos-im-gateway'
import {
  BOT_USER_ID,
  attachmentFrame,
  badFrame,
  dmTextFrame,
  groupMentionFrame,
  groupPlainFrame,
  heartbeatFrame,
  interactionFrame,
  readyFrame,
  replyFrame,
} from './fixtures/discordEvents.ts'

describe('Given Discord Gateway 帧规范化(§9.2)', () => {
  it('When 群 @bot Then kind=mention / peer=group', () => {
    const r = discordFrameToMessage(groupMentionFrame, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('mention')
    expect(r.msg.peer).toEqual({ kind: 'group', id: 'ch_1' })
    expect(r.msg.sender.name).toBe('alice')
    expect(r.msg.messageId).toBe('msg_1')
  })

  it('When 私聊(DM 无 guild_id)Then kind=text / peer=direct', () => {
    const r = discordFrameToMessage(dmTextFrame, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer.kind).toBe('direct')
  })

  it('When 群未 @bot Then kind=text', () => {
    const r = discordFrameToMessage(groupPlainFrame, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer.kind).toBe('group')
  })

  it('When 回复消息 Then kind=reply 且 threadId=message_reference', () => {
    const r = discordFrameToMessage(replyFrame, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('reply')
    expect(r.msg.peer.threadId).toBe('msg_1')
  })

  it('When 附件消息 Then kind=attachment', () => {
    const r = discordFrameToMessage(attachmentFrame, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('attachment')
    expect(r.msg.attachment?.ref).toBe('at_1')
  })

  it('When 按钮交互 Then kind=approval_reply', () => {
    const r = discordFrameToMessage(interactionFrame, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('approval_reply')
    expect(r.msg.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
  })

  it('When 非 DISPATCH/非消息/非法帧 Then 返回原因', () => {
    expect(discordFrameToMessage(heartbeatFrame).ok).toBe(false)
    expect(discordFrameToMessage(readyFrame).ok).toBe(false)
    expect(discordFrameToMessage(badFrame).ok).toBe(false)
    expect(discordFrameToMessage(null).ok).toBe(false)
  })

  it('When parseCustomId Then 兼容/非法边界', () => {
    expect(parseCustomId('{"approvalId":"x","action":"deny"}')).toEqual({ approvalId: 'x', action: 'deny' })
    expect(parseCustomId('bad')).toBeUndefined()
    expect(parseCustomId('{"a":"x","act":"hack"}')).toBeUndefined()
  })
})

describe('Given Discord 组件渲染(§9.3)', () => {
  it('When 审批卡 Then components 按钮 custom_id 携带紧凑 JSON', () => {
    const card = renderCard({ kind: 'approval', approvalId: 'ap_1', title: '审批', body: '执行' })
    const buttons = card.components[0]?.components ?? []
    expect(buttons.map((b) => b.custom_id)).toEqual(['{"a":"ap_1","act":"allow"}', '{"a":"ap_1","act":"deny"}'])
    expect(card.embeds[0]?.title).toBe('审批')
  })

  it('When 任务卡/决策卡 Then 按钮齐全且样式分级', () => {
    const t = renderCard({ kind: 'task', taskId: 't_1', title: '任务', body: 'b', actions: ['accept', 'reject', 'report'] })
    const btns = t.components[0]?.components ?? []
    expect(btns).toHaveLength(3)
    expect(btns[1]?.style).toBe(4) // reject 危险色
    const q = renderCard({ kind: 'question', questionId: 'q_1', title: 't', body: 'b', options: ['agree', 'reject', 'modify'] })
    expect(q.components[0]?.components).toHaveLength(3)
  })
})

describe('Given Discord 长消息分段(2000 硬限制)', () => {
  it('Then DISCORD_MAX=2000;超长分段且每段 ≤2000', () => {
    expect(DISCORD_MAX).toBe(2000)
    const segs = segmentText('a'.repeat(100) + '\n' + 'b'.repeat(5000))
    expect(segs.length).toBeGreaterThan(1)
    for (const seg of segs) {
      expect(seg.text.length).toBeLessThanOrEqual(2000)
    }
  })

  it('Then 表格转列表/LaTeX 转代码块/代码块不拆', () => {
    const t = convertTables('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(t).toContain('• **A** | **B**')
    expect(t).toContain('• 1 | 2')
    expect(convertLatex('公式 $x^2$ 与 $$y$$')).toContain('`x^2`')
    const segs = splitByLength('x'.repeat(100) + '```\n' + 'y'.repeat(1500) + '\n```' + 'z'.repeat(10), 1200)
    expect(segs.some((sg) => sg.text.includes('```\n') && sg.text.endsWith('```'))).toBe(true)
  })
})

describe('Given DiscordAdapter 生命周期', () => {
  function fakeTransport(): {
    transport: DiscordTransport
    calls: { connect: number; sendMessage: unknown[] }
    emit: (payload: unknown) => void
    failConnect: boolean
  } {
    const state = {
      calls: { connect: 0, sendMessage: [] as unknown[] },
      emit: (_payload: unknown) => {},
      failConnect: false,
    }
    const transport: DiscordTransport = {
      async connect(handlers) {
        state.calls.connect += 1
        if (state.failConnect) throw new Error('gateway refused')
        state.emit = (payload) => handlers.onEvent(payload)
        return { disconnect: async () => {}, selfId: () => BOT_USER_ID }
      },
      async sendMessage(channelId, payload) {
        state.calls.sendMessage.push({ channelId, payload })
      },
    }
    return {
      transport,
      calls: state.calls,
      emit: (payload: unknown) => state.emit(payload),
      get failConnect() {
        return state.failConnect
      },
      set failConnect(v: boolean) {
        state.failConnect = v
      },
    }
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('When start + 帧到达 Then 规范化并通过 onInbound;重复帧去重;HEARTBEAT 帧被忽略', async () => {
    const t = fakeTransport()
    const inbound: string[] = []
    const adapter = new DiscordAdapter({
      credentials: { botToken: 'token' },
      transport: t.transport,
      onInbound: (msg) => {
        inbound.push(`${msg.kind}:${msg.peer.id}:${msg.messageId}`)
      },
    })
    await adapter.start()
    t.emit(groupMentionFrame)
    t.emit(groupMentionFrame) // 重放 → 去重
    t.emit(dmTextFrame)
    t.emit(heartbeatFrame) // 协议帧 → 忽略
    t.emit(interactionFrame)
    await flush()
    expect(inbound).toEqual(['mention:ch_1:msg_1', 'text:dm_1:msg_2', 'approval_reply:dm_1:msg_9'])
    await adapter.stop()
  })

  it('When sendText 超长 Then 分段发送;sendCard Then embeds+components', async () => {
    const t = fakeTransport()
    const adapter = new DiscordAdapter({ credentials: { botToken: 't' }, transport: t.transport })
    await adapter.start()
    await adapter.sendText({ kind: 'group', id: 'ch_1' }, 'x'.repeat(100) + '\n' + 'y'.repeat(5000))
    expect(t.calls.sendMessage.length).toBeGreaterThan(1)
    await adapter.sendCard({ kind: 'direct', id: 'dm_1' }, { kind: 'approval', approvalId: 'a1', title: 't', body: 'b' })
    const last = t.calls.sendMessage.at(-1) as { payload: { embeds?: unknown[] } }
    expect(last.payload.embeds).toBeTruthy()
    await adapter.stop()
  })

  it('When 连接失败 Then 退避重连;耗尽后 disconnected', async () => {
    vi.useFakeTimers()
    try {
      const t = fakeTransport()
      t.failConnect = true
      const states: string[] = []
      const adapter = new DiscordAdapter({
        credentials: { botToken: 't' },
        transport: t.transport,
        backoff: new BackoffPolicy({ baseMs: 1000, maxMs: 4000, maxAttempts: 2 }),
        onConnection: (state, reason) => states.push(reason ? `${state}:${reason}` : state),
      })
      await adapter.start()
      expect(t.calls.connect).toBe(1)
      // start 时首次连接失败已进入退避(attempt=1)
      expect(adapter.reconnectAttempts()).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(t.calls.connect).toBe(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(t.calls.connect).toBe(3)
      await vi.advanceTimersByTimeAsync(4000)
      expect(states.some((s) => s.startsWith('disconnected'))).toBe(true)
      await adapter.stop()
      expect(adapter.isStarted()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
