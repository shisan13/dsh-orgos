/**
 * im-dingtalk 测试:Stream 信封规范化/卡片渲染/分段/适配器生命周期(record-replay)
 */
import { describe, expect, it, vi } from 'vitest'
import { dingtalkEnvelopeToMessage, parseCardContent } from './events.ts'
import { renderCard } from './cards.ts'
import { segmentText, convertTables, convertLatex, splitByLength, DINGTALK_MAX } from './format.ts'
import { DingtalkAdapter, type DingtalkTransport } from './DingtalkAdapter.ts'
import { BackoffPolicy } from 'dsh-orgos-im-gateway'
import {
  badMessageEnvelope,
  cardCallbackEnvelope,
  groupMentionEnvelope,
  groupPlainEnvelope,
  ignoredEnvelope,
  malformedEnvelope,
  pictureEnvelope,
  privateTextEnvelope,
} from './fixtures/dingtalkEvents.ts'

const BOT_NAME = 'orgos-bot'

describe('Given 钉钉 Stream 信封规范化(§9.2)', () => {
  it('When 群 @bot(isInAtList)Then kind=mention / peer=group', () => {
    const r = dingtalkEnvelopeToMessage(groupMentionEnvelope, BOT_NAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('mention')
    expect(r.msg.peer).toEqual({ kind: 'group', id: 'cid_group_1' })
    expect(r.msg.sender.name).toBe('张三')
    expect(r.msg.content).toBe('@orgos-bot 帮我查一下')
  })

  it('When 私聊文本 Then kind=text / peer=direct', () => {
    const r = dingtalkEnvelopeToMessage(privateTextEnvelope, BOT_NAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer.kind).toBe('direct')
    expect(r.msg.ts).toBe(new Date(1720000000001).toISOString())
  })

  it('When 群未 @(非 isInAtList 且不以 @ 开头)Then kind=text', () => {
    const r = dingtalkEnvelopeToMessage(groupPlainEnvelope, BOT_NAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer.kind).toBe('group')
  })

  it('When 图片消息 Then kind=attachment 且 downloadCode 为 ref', () => {
    const r = dingtalkEnvelopeToMessage(pictureEnvelope)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('attachment')
    expect(r.msg.attachment?.ref).toBe('dl_abc')
  })

  it('When 卡片按钮回调 Then kind=approval_reply(多层转义 params 解析)', () => {
    const r = dingtalkEnvelopeToMessage(cardCallbackEnvelope)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('approval_reply')
    expect(r.msg.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
  })

  it('When 非法/忽略信封 Then 返回原因', () => {
    expect(dingtalkEnvelopeToMessage(ignoredEnvelope).ok).toBe(false)
    expect(dingtalkEnvelopeToMessage(malformedEnvelope).ok).toBe(false)
    expect(dingtalkEnvelopeToMessage(badMessageEnvelope).ok).toBe(false)
    expect(dingtalkEnvelopeToMessage(null).ok).toBe(false)
  })

  it('When parseCardContent Then 兼容完整/紧凑 JSON,非法拒绝', () => {
    expect(parseCardContent(JSON.stringify({ cardPrivateData: { params: JSON.stringify({ approvalId: 'x', action: 'deny' }) } }))).toEqual({ approvalId: 'x', action: 'deny' })
    expect(parseCardContent('not-json')).toBeUndefined()
    expect(parseCardContent(JSON.stringify({ cardPrivateData: { params: JSON.stringify({ a: 'x', act: 'hack' }) } }))).toBeUndefined()
  })
})

describe('Given 钉钉卡片渲染(§9.3)', () => {
  it('When 审批卡 Then interactive 模板变量按钮携带 key JSON', () => {
    const card = renderCard({ kind: 'approval', approvalId: 'ap_1', title: '审批', body: '执行' })
    expect(card.msgtype).toBe('interactive')
    const keys = card.card.data.template_variable.buttons.map((b) => b.key)
    expect(keys).toEqual(['{"a":"ap_1","act":"allow"}', '{"a":"ap_1","act":"deny"}'])
  })

  it('When 任务卡/决策卡 Then 按钮齐全;template_id 可覆盖', () => {
    const t = renderCard({ kind: 'task', taskId: 't_1', title: '任务', body: 'b', actions: ['accept', 'reject', 'report'] })
    expect(t.card.data.template_variable.buttons).toHaveLength(3)
    const q = renderCard({ kind: 'question', questionId: 'q_1', title: 't', body: 'b', options: ['agree', 'reject', 'modify'] }, 'my_template')
    expect(q.card.data.template_id).toBe('my_template')
  })
})

describe('Given 钉钉长消息分段', () => {
  it('Then DINGTALK_MAX=4000;超长分段;表格/LaTeX 转换', () => {
    expect(DINGTALK_MAX).toBe(4000)
    expect(segmentText('a'.repeat(100) + '\n' + 'b'.repeat(5000)).length).toBeGreaterThan(1)
    expect(segmentText('你好')).toEqual([{ reason: 'length', text: '你好' }])
  })

  it('Then 表格转列表/LaTeX 转代码块/代码块不拆', () => {
    const t = convertTables('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(t).toContain('• **A** | **B**')
    expect(t).toContain('• 1 | 2')
    expect(convertLatex('公式 $x^2$')).toContain('`x^2`')
    const segs = splitByLength('x'.repeat(100) + '```\n' + 'y'.repeat(2500) + '\n```' + 'z'.repeat(10), 2000)
    expect(segs.some((sg) => sg.text.includes('```\n') && sg.text.endsWith('```'))).toBe(true)
  })
})

describe('Given DingtalkAdapter 生命周期', () => {
  function fakeTransport(): {
    transport: DingtalkTransport
    calls: { connect: number; sendMessage: unknown[] }
    emit: (payload: unknown) => void
    failConnect: boolean
  } {
    const state = {
      calls: { connect: 0, sendMessage: [] as unknown[] },
      emit: (_payload: unknown) => {},
      failConnect: false,
    }
    const transport: DingtalkTransport = {
      async connect(handlers) {
        state.calls.connect += 1
        if (state.failConnect) throw new Error('stream refused')
        state.emit = (payload) => handlers.onEvent(payload)
        return { disconnect: async () => {}, selfId: () => 'bt_1' }
      },
      async sendMessage(conversationId, payload) {
        state.calls.sendMessage.push({ conversationId, payload })
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

  /** onInbound 经 Promise 微任务链,emit 后需让事件循环推进 */
  async function flush(): Promise<void> {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  }

  it('When start + 事件到达 Then 规范化并通过 onInbound;重复信封去重;stop 幂等', async () => {
    const t = fakeTransport()
    const inbound: string[] = []
    const adapter = new DingtalkAdapter({
      credentials: { appKey: 'a', appSecret: 's' },
      transport: t.transport,
      botName: BOT_NAME,
      onInbound: (msg) => {
        inbound.push(`${msg.kind}:${msg.peer.id}:${msg.messageId}`)
      },
    })
    await adapter.start()
    t.emit(groupMentionEnvelope)
    t.emit(groupMentionEnvelope) // 重放 → 去重
    t.emit(privateTextEnvelope)
    t.emit(cardCallbackEnvelope)
    await flush()
    expect(inbound).toEqual(['mention:cid_group_1:msg_1', 'text:cid_p2p_1:msg_2', 'approval_reply:cid_p2p_1:msg_5'])
    expect(adapter.selfId()).toBe('bt_1')
    await adapter.stop()
    await adapter.stop()
    expect(adapter.isStarted()).toBe(false)
  })

  it('When sendText 超长 Then 分段发送;sendCard Then interactive 卡片', async () => {
    const t = fakeTransport()
    const adapter = new DingtalkAdapter({ credentials: { appKey: 'a', appSecret: 's' }, transport: t.transport })
    await adapter.start()
    await adapter.sendText({ kind: 'group', id: 'cid_g' }, 'x'.repeat(100) + '\n' + 'y'.repeat(5000))
    expect(t.calls.sendMessage.length).toBeGreaterThan(1)
    await adapter.sendCard({ kind: 'direct', id: 'cid_p' }, { kind: 'approval', approvalId: 'a1', title: 't', body: 'b' })
    const last = t.calls.sendMessage.at(-1) as { payload: { msgtype: string } }
    expect(last.payload.msgtype).toBe('interactive')
    await adapter.stop()
  })

  it('When 连接失败 Then 退避重连;耗尽后 disconnected', async () => {
    vi.useFakeTimers()
    try {
      const t = fakeTransport()
      t.failConnect = true
      const states: string[] = []
      const adapter = new DingtalkAdapter({
        credentials: { appKey: 'a', appSecret: 's' },
        transport: t.transport,
        backoff: new BackoffPolicy({ baseMs: 1000, maxMs: 4000, maxAttempts: 2 }),
        onConnection: (state, reason) => states.push(reason ? `${state}:${reason}` : state),
      })
      await adapter.start()
      expect(t.calls.connect).toBe(1)
      await vi.advanceTimersByTimeAsync(1000)
      expect(t.calls.connect).toBe(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(t.calls.connect).toBe(3)
      await vi.advanceTimersByTimeAsync(4000)
      expect(states.some((s) => s.startsWith('disconnected'))).toBe(true)
      await adapter.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
