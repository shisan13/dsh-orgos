/**
 * im-slack 测试:Socket Mode 信封规范化/Block Kit 渲染/分段/适配器生命周期(record-replay)
 */
import { describe, expect, it, vi } from 'vitest'
import { slackEnvelopeToMessage, parseValue, slackTsToIso } from './events.ts'
import { renderCard } from './cards.ts'
import { segmentText, convertTables, convertLatex, splitByLength, SLACK_MAX } from './format.ts'
import { SlackAdapter, type SlackTransport } from './SlackAdapter.ts'
import { BackoffPolicy } from 'dsh-orgos-im-gateway'
import {
  BOT_USER_ID,
  badEnvelope,
  blockActionsEnvelope,
  fileMessageEnvelope,
  groupMentionEnvelope,
  groupPlainEnvelope,
  ignoredEnvelope,
  imMessageEnvelope,
  malformedEnvelope,
  threadReplyEnvelope,
} from './fixtures/slackEvents.ts'

describe('Given Slack 信封规范化(§9.2)', () => {
  it('When 私聊消息 Then kind=text / peer=direct', () => {
    const r = slackEnvelopeToMessage(imMessageEnvelope, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer).toEqual({ kind: 'direct', id: 'D123' })
    expect(r.msg.messageId).toBe('1720000000.000001')
  })

  it('When 群 @bot Then kind=mention / peer=group', () => {
    const r = slackEnvelopeToMessage(groupMentionEnvelope, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('mention')
    expect(r.msg.peer.kind).toBe('group')
    expect(r.msg.content).toContain('<@U0BOT>')
  })

  it('When 群未 @bot Then kind=text', () => {
    const r = slackEnvelopeToMessage(groupPlainEnvelope, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
  })

  it('When 线程回复 Then kind=reply 且 threadId=thread_ts', () => {
    const r = slackEnvelopeToMessage(threadReplyEnvelope, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('reply')
    expect(r.msg.peer.threadId).toBe('1720000001.000001')
  })

  it('When 文件消息 Then kind=attachment', () => {
    const r = slackEnvelopeToMessage(fileMessageEnvelope, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('attachment')
    expect(r.msg.attachment?.ref).toBe('F123')
    expect(r.msg.attachment?.name).toBe('report.pdf')
  })

  it('When 按钮交互 Then kind=approval_reply', () => {
    const r = slackEnvelopeToMessage(blockActionsEnvelope, BOT_USER_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('approval_reply')
    expect(r.msg.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
  })

  it('When 忽略/非法信封 Then 返回原因', () => {
    expect(slackEnvelopeToMessage(ignoredEnvelope).ok).toBe(false)
    expect(slackEnvelopeToMessage(badEnvelope).ok).toBe(false)
    expect(slackEnvelopeToMessage(malformedEnvelope).ok).toBe(false)
    expect(slackEnvelopeToMessage(null).ok).toBe(false)
  })

  it('When parseValue/slackTsToIso Then 兼容与边界', () => {
    expect(parseValue('{"approvalId":"x","action":"deny"}')).toEqual({ approvalId: 'x', action: 'deny' })
    expect(parseValue('bad')).toBeUndefined()
    expect(parseValue('{"a":"x","act":"hack"}')).toBeUndefined()
    expect(slackTsToIso('1720000000.000001')).toBe('2024-07-03T09:46:40.000Z')
    expect(slackTsToIso('not-a-ts')).toBeUndefined()
  })
})

describe('Given Slack Block Kit 渲染(§9.3)', () => {
  it('When 审批卡 Then actions 按钮 value 携带紧凑 JSON', () => {
    const card = renderCard({ kind: 'approval', approvalId: 'ap_1', title: '审批', body: '执行' })
    const elements = card.blocks[2] as { elements: { value: string; action_id: string }[] }
    expect(elements.elements.map((e) => e.value)).toEqual(['{"a":"ap_1","act":"allow"}', '{"a":"ap_1","act":"deny"}'])
  })

  it('When 任务卡/决策卡 Then 按钮齐全且 header/section 齐全', () => {
    const t = renderCard({ kind: 'task', taskId: 't_1', title: '任务', body: 'b', actions: ['accept', 'reject', 'report'] })
    expect((t.blocks[2] as { elements: unknown[] }).elements).toHaveLength(3)
    expect(t.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: '任务' } })
    const q = renderCard({ kind: 'question', questionId: 'q_1', title: 't', body: 'b', options: ['agree', 'reject', 'modify'] })
    expect((q.blocks[2] as { elements: unknown[] }).elements).toHaveLength(3)
  })
})

describe('Given Slack 长消息分段', () => {
  it('Then SLACK_MAX=30000;超长分段', () => {
    expect(SLACK_MAX).toBe(30000)
    expect(segmentText('a'.repeat(100) + '\n' + 'b'.repeat(40000)).length).toBeGreaterThan(1)
    expect(segmentText('hi')).toEqual([{ reason: 'length', text: 'hi' }])
  })

  it('Then 表格转列表/LaTeX 转代码块/代码块不拆', () => {
    const t = convertTables('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(t).toContain('• **A** | **B**')
    expect(t).toContain('• 1 | 2')
    expect(convertLatex('公式 $x^2$ 与 $$y$$')).toContain('`x^2`')
    const segs = splitByLength('x'.repeat(100) + '```\n' + 'y'.repeat(2500) + '\n```' + 'z'.repeat(10), 2000)
    expect(segs.some((sg) => sg.text.includes('```\n') && sg.text.endsWith('```'))).toBe(true)
  })
})

describe('Given SlackAdapter 生命周期', () => {
  function fakeTransport(): {
    transport: SlackTransport
    calls: { connect: number; sendMessage: unknown[] }
    emit: (payload: unknown) => void
    failConnect: boolean
  } {
    const state = {
      calls: { connect: 0, sendMessage: [] as unknown[] },
      emit: (_payload: unknown) => {},
      failConnect: false,
    }
    const transport: SlackTransport = {
      async connect(handlers) {
        state.calls.connect += 1
        if (state.failConnect) throw new Error('socket refused')
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

  it('When start + 事件到达 Then 规范化并通过 onInbound;重复信封去重', async () => {
    const t = fakeTransport()
    const inbound: string[] = []
    const adapter = new SlackAdapter({
      credentials: { botToken: 'xoxb', appToken: 'xapp' },
      transport: t.transport,
      onInbound: (msg) => {
        inbound.push(`${msg.kind}:${msg.peer.id}:${msg.messageId}`)
      },
    })
    await adapter.start()
    t.emit(imMessageEnvelope)
    t.emit(imMessageEnvelope) // 重放 → 去重
    t.emit(groupMentionEnvelope)
    t.emit(blockActionsEnvelope)
    await flush()
    expect(inbound).toEqual([
      'text:D123:1720000000.000001',
      'mention:C123:1720000001.000001',
      'approval_reply:D123:1720000005.000001',
    ])
    await adapter.stop()
  })

  it('When sendText 超长 Then 分段发送;sendCard Then blocks', async () => {
    const t = fakeTransport()
    const adapter = new SlackAdapter({ credentials: { botToken: 'x', appToken: 'y' }, transport: t.transport })
    await adapter.start()
    await adapter.sendText({ kind: 'direct', id: 'D123' }, 'x'.repeat(100) + '\n' + 'y'.repeat(40000))
    expect(t.calls.sendMessage.length).toBeGreaterThan(1)
    await adapter.sendCard({ kind: 'direct', id: 'D123' }, { kind: 'approval', approvalId: 'a1', title: 't', body: 'b' })
    const last = t.calls.sendMessage.at(-1) as { payload: { blocks?: unknown[] } }
    expect(last.payload.blocks).toBeTruthy()
    await adapter.stop()
  })

  it('When 连接失败 Then 退避重连;耗尽后 disconnected;start/stop 幂等', async () => {
    vi.useFakeTimers()
    try {
      const t = fakeTransport()
      t.failConnect = true
      const states: string[] = []
      const adapter = new SlackAdapter({
        credentials: { botToken: 'x', appToken: 'y' },
        transport: t.transport,
        backoff: new BackoffPolicy({ baseMs: 1000, maxMs: 4000, maxAttempts: 2 }),
        onConnection: (state, reason) => states.push(reason ? `${state}:${reason}` : state),
      })
      await adapter.start()
      expect(t.calls.connect).toBe(1)
      await adapter.start()
      expect(t.calls.connect).toBe(1)
      expect(adapter.reconnectAttempts()).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(t.calls.connect).toBe(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(t.calls.connect).toBe(3)
      await vi.advanceTimersByTimeAsync(4000)
      expect(states.some((s) => s.startsWith('disconnected'))).toBe(true)
      await adapter.stop()
      await adapter.stop()
      expect(adapter.isStarted()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
