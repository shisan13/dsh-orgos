/**
 * im-feishu 测试:事件规范化/卡片渲染/长消息分段/重连退避/适配器生命周期(record-replay,不真连 IM)
 */
import { describe, expect, it, vi } from 'vitest'
import { larkEventToMessage } from './events.ts'
import { renderApprovalCard, renderQuestionCard, renderTaskCard, renderCard } from './cards.ts'
import { segmentText, convertTables, convertLatex, splitByLength } from './format.ts'
import { BackoffPolicy } from './backoff.ts'
import { FeishuAdapter, type FeishuTransport } from './FeishuAdapter.ts'
import {
  BOT_OPEN_ID,
  badEvent,
  cardActionEvent,
  expectedGroupMention,
  fileEvent,
  groupMentionEvent,
  groupPlainEvent,
  p2pEvent,
  replyEvent,
} from './fixtures/larkEvents.ts'

describe('Given 飞书事件规范化(技术设计 §9.2)', () => {
  it('When 群消息 @bot Then kind=mention / peer=group', () => {
    const r = larkEventToMessage(groupMentionEvent, BOT_OPEN_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg).toEqual(expectedGroupMention)
  })

  it('When 群消息未 @bot Then kind=text(静默候选,路由层决定)', () => {
    const r = larkEventToMessage(groupPlainEvent, BOT_OPEN_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer.kind).toBe('group')
  })

  it('When 私聊 Then kind=text / peer=direct', () => {
    const r = larkEventToMessage(p2pEvent)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer).toEqual({ kind: 'direct', id: 'oc_p2p_1' })
  })

  it('When 回复消息 Then kind=reply 且 threadId 为父消息', () => {
    const r = larkEventToMessage(replyEvent, BOT_OPEN_ID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('reply')
    expect(r.msg.peer.threadId).toBe('om_group_1')
  })

  it('When 文件消息 Then kind=attachment 且引用保留', () => {
    const r = larkEventToMessage(fileEvent)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('attachment')
    expect(r.msg.attachment).toEqual({ ref: 'file_abc', name: 'report.pdf' })
  })

  it('When 卡片按钮回调 Then kind=approval_reply 且 approval 结构化', () => {
    const r = larkEventToMessage(cardActionEvent)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('approval_reply')
    expect(r.msg.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
  })

  it('When 非法事件 Then 返回原因(不抛异常)', () => {
    const r = larkEventToMessage(badEvent)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('message_id')
    expect(larkEventToMessage(null).ok).toBe(false)
    expect(larkEventToMessage({ header: { event_type: 'im.chat.updated' }, event: {} }).ok).toBe(false)
  })

  it('When 未知卡片动作 Then 拒绝', () => {
    const r = larkEventToMessage({
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_x' },
        action: { value: { hack: true } },
        context: { open_chat_id: 'oc_x', open_message_id: 'om_x' },
      },
    })
    expect(r.ok).toBe(false)
  })
})

describe('Given 卡片渲染(§4.7.1/§9.3;T6 一次性)', () => {
  it('When 审批卡 Then Allow/Deny 按钮携带 approvalId+action', () => {
    const card = renderApprovalCard({ kind: 'approval', approvalId: 'ap_1', title: '需要审批', body: '执行命令 rm -rf /tmp/x', timeoutMinutes: 10 })
    const actions = card.elements[1] as { actions: { value: Record<string, string> }[] }
    expect(JSON.parse(String(actions.actions[0]?.value))).toEqual({ approvalId: 'ap_1', action: 'allow' })
    expect(JSON.parse(String(actions.actions[1]?.value))).toEqual({ approvalId: 'ap_1', action: 'deny' })
  })

  it('When 决策卡 Then 同意/驳回/修改', () => {
    const card = renderQuestionCard({ kind: 'question', questionId: 'q_1', title: '是否继续', body: '折叠报告', options: ['agree', 'reject', 'modify'] })
    const actions = card.elements[1] as { actions: { value: Record<string, string>; text: { content: string } }[] }
    expect(actions.actions.map((a) => JSON.parse(String(a.value)))).toEqual([
      { questionId: 'q_1', action: 'agree' },
      { questionId: 'q_1', action: 'reject' },
      { questionId: 'q_1', action: 'modify' },
    ])
  })

  it('Given 卡片回调 value 双重字符串编码(飞书实测行为) When 规范化 Then 正确解包', () => {
    const inner = JSON.stringify({ approvalId: 'ap_2', action: 'allow' })
    const doubleEncoded = JSON.stringify(inner) // "\"{\"approvalId\":...}\"" 等价物
    const raw = {
      header: { event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_x' },
        action: { value: doubleEncoded },
        context: { open_chat_id: 'oc_g', open_message_id: 'om_m' },
      },
    }
    const result = larkEventToMessage(raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.msg.kind).toBe('approval_reply')
      expect(result.msg.approval).toEqual({ approvalId: 'ap_2', action: 'allow' })
    }
  })

  it('When 任务卡 Then 接受/拒绝/完成汇报 + 截止时间', () => {
    const card = renderTaskCard({ kind: 'task', taskId: 't_1', title: '实现登录页', body: '需求…', actions: ['accept', 'reject', 'report'], deadlineAt: Date.UTC(2026, 7, 20) })
    const actions = card.elements[1] as { actions: { value: Record<string, string> }[] }
    expect(actions.actions.map((a) => JSON.parse(String(a.value)))).toEqual([
      { taskId: 't_1', action: 'accept' },
      { taskId: 't_1', action: 'reject' },
      { taskId: 't_1', action: 'report' },
    ])
    expect(JSON.stringify(card)).toContain('截止时间')
  })

  it('Then renderCard 按 kind 分发', () => {
    expect(renderCard({ kind: 'approval', approvalId: 'a', title: 't', body: 'b' }).header?.title?.content).toBe('t')
    expect(renderCard({ kind: 'question', questionId: 'q', title: 't2', body: 'b', options: ['agree'] }).header?.title?.content).toBe('t2')
    expect(renderCard({ kind: 'task', taskId: 'x', title: 't3', body: 'b', actions: ['accept'] }).header?.title?.content).toBe('t3')
  })
})

describe('Given 长消息分段(openclaw 坑点:表格/LaTeX/超长)', () => {
  it('Then MD 表格转换为列表(表头加粗)', () => {
    const out = convertTables('| 任务 | 状态 |\n| --- | --- |\n| A | 完成 |')
    expect(out).toContain('• **任务** | **状态**')
    expect(out).toContain('• A | 完成')
    expect(out).not.toContain('| ---')
  })

  it('Then LaTeX 转代码块(行内 $ 与块级 $$)', () => {
    expect(convertLatex('公式 $E=mc^2$ 结束')).toBe('公式 `E=mc^2` 结束')
    expect(convertLatex('$$\nx^2 + y^2 = z^2\n$$')).toContain('```math')
  })

  it('Then 超长文本按行边界分段且代码块不拆', () => {
    // 第一段内含换行,应在换行处断开
    const long = 'a'.repeat(100) + '\n' + 'b'.repeat(200)
    const segs = splitByLength(long, 150)
    expect(segs.length).toBeGreaterThan(1)
    expect(segs[0]!.text.endsWith('\n')).toBe(true)

    const code = 'x'.repeat(100) + '```\n' + 'y'.repeat(5000) + '\n```' + 'z'.repeat(50)
    const out = segmentText(code, 3000)
    expect(out.length).toBeGreaterThan(1)
    // 代码块作为一个整体段,不被拆开
    expect(out.some((s) => s.text.includes('```\n') && s.text.endsWith('```'))).toBe(true)
  })

  it('Then 短文本单段返回', () => {
    expect(segmentText('你好')).toEqual([{ reason: 'length', text: '你好' }])
  })
})

describe('Given 重连退避(§9.1 指数退避)', () => {
  it('Then 退避序列 = base * 2^(n-1),封顶 max', () => {
    const p = new BackoffPolicy({ baseMs: 1000, maxMs: 8000, maxAttempts: 5 })
    expect(p.delayFor(1)).toBe(1000)
    expect(p.delayFor(2)).toBe(2000)
    expect(p.delayFor(3)).toBe(4000)
    expect(p.delayFor(4)).toBe(8000)
    expect(p.delayFor(5)).toBe(8000)
  })

  it('Then exhausted 判定:超过 maxAttempts 才放弃', () => {
    const p = new BackoffPolicy({ maxAttempts: 3 })
    expect(p.exhausted(1)).toBe(false)
    expect(p.exhausted(3)).toBe(false)
    expect(p.exhausted(4)).toBe(true)
    expect(p.delayFor(0)).toBe(0)
  })
})

describe('Given FeishuAdapter 生命周期(record-replay)', () => {
  function fakeTransport(): { transport: FeishuTransport; calls: { connect: number; sendText: string[]; sendCard: unknown[] }; emit: (payload: unknown) => void; failConnect: boolean } {
    const state = {
      calls: { connect: 0, sendText: [] as string[], sendCard: [] as unknown[] },
      emit: (_payload: unknown) => {},
      failConnect: false,
    }
    const transport: FeishuTransport = {
      async connect(handlers) {
        state.calls.connect += 1
        if (state.failConnect) throw new Error('ws refused')
        state.emit = (payload) => handlers.onEvent(payload)
        return { disconnect: async () => {}, selfOpenId: () => BOT_OPEN_ID }
      },
      async sendText(chatId, text) {
        state.calls.sendText.push(`${chatId}:${text}`)
      },
      async sendCard(chatId, card) {
        state.calls.sendCard.push({ chatId, card })
      },
    }
    return {
      transport,
      calls: state.calls,
      // 转发:connect 会替换 state.emit,测试侧必须始终调用最新回调
      emit: (payload: unknown) => state.emit(payload),
      get failConnect() {
        return state.failConnect
      },
      set failConnect(v: boolean) {
        state.failConnect = v
      },
    }
  }

  it('When start + 事件到达 Then 规范化并通过 onInbound 回调;重复消息去重', async () => {
    const t = fakeTransport()
    const inbound: string[] = []
    const adapter = new FeishuAdapter({
      credentials: { appId: 'a', appSecret: 's' },
      transport: t.transport,
      onInbound: (msg) => {
        inbound.push(`${msg.kind}:${msg.peer.id}:${msg.messageId}`)
      },
    })
    await adapter.start()
    t.emit(groupMentionEvent)
    t.emit(groupMentionEvent) // 重放 → 去重
    t.emit(p2pEvent)
    t.emit(cardActionEvent)
    await new Promise((r) => setTimeout(r, 0)) // onInbound 经微任务隔离(异常防护)
    expect(inbound).toEqual([
      'mention:oc_group_1:om_group_1',
      'text:oc_p2p_1:om_p2p_1',
      'approval_reply:oc_p2p_1:om_card_1',
    ])
    expect(adapter.isStarted()).toBe(true)
    await adapter.stop()
    expect(adapter.isStarted()).toBe(false)
  })

  it('When sendText 长消息 Then 分段逐段发送', async () => {
    const t = fakeTransport()
    const adapter = new FeishuAdapter({ credentials: { appId: 'a', appSecret: 's' }, transport: t.transport })
    await adapter.start()
    await adapter.sendText({ kind: 'group', id: 'oc_g' }, 'x'.repeat(2000) + '\n' + 'y'.repeat(2000))
    expect(t.calls.sendText.length).toBeGreaterThan(1)
    await adapter.stop()
  })

  it('When sendCard Then 渲染为飞书卡片 JSON', async () => {
    const t = fakeTransport()
    const adapter = new FeishuAdapter({ credentials: { appId: 'a', appSecret: 's' }, transport: t.transport })
    await adapter.start()
    await adapter.sendCard({ kind: 'direct', id: 'ou_x' }, { kind: 'approval', approvalId: 'ap_9', title: 't', body: 'b' })
    expect(t.calls.sendCard).toHaveLength(1)
    const sent = t.calls.sendCard[0] as { chatId: string; card: { header: { title: { content: string } } } }
    expect(sent.chatId).toBe('ou_x')
    expect(sent.card.header.title.content).toBe('t')
    await adapter.stop()
  })

  it('When 连接失败 Then 指数退避重连;start/stop 幂等', async () => {
    vi.useFakeTimers()
    try {
      const t = fakeTransport()
      t.failConnect = true
      const states: string[] = []
      const adapter = new FeishuAdapter({
        credentials: { appId: 'a', appSecret: 's' },
        transport: t.transport,
        backoff: new BackoffPolicy({ baseMs: 1000, maxMs: 4000, maxAttempts: 3 }),
        onConnection: (state, reason) => states.push(reason ? `${state}:${reason}` : state),
      })
      await adapter.start()
      expect(t.calls.connect).toBe(1)
      // 重连定时器推进:第一次重试 1s 后
      await vi.advanceTimersByTimeAsync(1000)
      expect(t.calls.connect).toBe(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(t.calls.connect).toBe(3)
      // 第四次失败耗尽 → disconnected
      await vi.advanceTimersByTimeAsync(4000)
      expect(t.calls.connect).toBe(4)
      expect(states.at(-1)).toBe('disconnected:ws refused')
      // 幂等:重复 start/stop 不重复建连
      await adapter.start()
      expect(t.calls.connect).toBe(4)
      await adapter.stop()
      await adapter.stop()
      expect(adapter.reconnectAttempts()).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('When start 后 setWatchChats Then 补偿拉取最近窗口并补投;重复 messageId 幂等跳过', async () => {
    const t = fakeTransport()
    const fetched: Array<{ chatId: string; startTimeMs: number }> = []
    const transport = {
      ...t.transport,
      async fetchRecentMessages(chatId: string, startTimeMs: number) {
        fetched.push({ chatId, startTimeMs })
        const event = (groupMentionEvent as { event: unknown }).event
        return [event, event] // 同一条重复(模拟与 WS 已到达消息重叠)→ 幂等跳过
      },
    }
    const inbound: string[] = []
    const adapter = new FeishuAdapter({
      credentials: { appId: 'a', appSecret: 's' },
      transport,
      onInbound: (msg) => inbound.push(`${msg.kind}:${msg.messageId}`),
    })
    await adapter.start()
    adapter.setWatchChats(['oc_group_1'])
    await new Promise((r) => setTimeout(r, 0))
    expect(fetched.length).toBe(1)
    expect(fetched[0]?.chatId).toBe('oc_group_1')
    expect(inbound).toEqual(['mention:om_group_1'])
    await adapter.stop()
  })

  it('When 未设置 watchChats Then 不发起补偿拉取', async () => {
    const t = fakeTransport()
    let fetchCalls = 0
    const transport = { ...t.transport, async fetchRecentMessages() { fetchCalls += 1; return [] } }
    const adapter = new FeishuAdapter({ credentials: { appId: 'a', appSecret: 's' }, transport })
    await adapter.start()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchCalls).toBe(0)
    await adapter.stop()
  })

  it('When 补偿拉取失败 Then 降级不崩,后续 WS 事件仍正常', async () => {
    const t = fakeTransport()
    const transport = {
      ...t.transport,
      async fetchRecentMessages() {
        throw new Error('permission denied(im:message:readonly 未开通)')
      },
    }
    const inbound: string[] = []
    const adapter = new FeishuAdapter({
      credentials: { appId: 'a', appSecret: 's' },
      transport,
      onInbound: (msg) => inbound.push(`${msg.kind}:${msg.messageId}`),
    })
    await adapter.start()
    adapter.setWatchChats(['oc_group_1'])
    await new Promise((r) => setTimeout(r, 0))
    t.emit(groupMentionEvent) // 主链路不受影响
    await new Promise((r) => setTimeout(r, 0))
    expect(inbound).toEqual(['mention:om_group_1'])
    await adapter.stop()
  })
})
