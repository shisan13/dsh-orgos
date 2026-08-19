/**
 * im-whatsapp 测试:webhook 验签/解包规范化/按钮渲染/分段/适配器生命周期(record-replay)
 * (安全设计 §6:✅ X-Hub-Signature-256)
 */
import { describe, expect, it } from 'vitest'
import { computeHubSignature, verifyWebhookSignature } from './verify.ts'
import { whatsappWebhookToMessages, parseButtonId } from './events.ts'
import { renderCard } from './cards.ts'
import { segmentText, convertTables, convertLatex, splitByLength, WHATSAPP_MAX } from './format.ts'
import { WhatsappAdapter, type WhatsappAdapterOptions, type WhatsappSendTransport } from './WhatsappAdapter.ts'
import {
  buttonReplyWebhook,
  emptyWebhook,
  imageWebhook,
  multiMessageWebhook,
  statusWebhook,
  textWebhook,
  wrongObjectWebhook,
} from './fixtures/whatsappEvents.ts'

const APP_SECRET = 'test_app_secret_123'

function makeAdapter(overrides?: Partial<WhatsappAdapterOptions>): {
  adapter: WhatsappAdapter
  sent: { text: unknown[]; card: unknown[] }
} {
  const sent = { text: [] as unknown[], card: [] as unknown[] }
  const transport: WhatsappSendTransport = {
    async sendMessage(to, payload) {
      const p = payload as { type?: string }
      if (p.type === 'interactive') sent.card.push({ to, payload })
      else sent.text.push({ to, payload })
    },
  }
  const adapter = new WhatsappAdapter({
    credentials: { phoneNumberId: 'pn_1', accessToken: 'token', appSecret: APP_SECRET },
    transport,
    ...overrides,
  })
  return { adapter, sent }
}

function signedBody(payload: unknown): { rawBody: string; signature: string } {
  const rawBody = JSON.stringify(payload)
  return { rawBody, signature: computeHubSignature(APP_SECRET, rawBody) }
}

describe('Given WhatsApp webhook 验签(安全设计 §6)', () => {
  it('When 签名正确 Then 通过;错误/缺失 Then 拒绝', () => {
    const { rawBody, signature } = signedBody(textWebhook)
    expect(verifyWebhookSignature(APP_SECRET, rawBody, signature)).toBe(true)
    expect(verifyWebhookSignature(APP_SECRET, rawBody, 'sha256=deadbeef')).toBe(false)
    expect(verifyWebhookSignature(APP_SECRET, rawBody, undefined)).toBe(false)
    expect(verifyWebhookSignature('wrong_secret', rawBody, signature)).toBe(false)
    expect(verifyWebhookSignature(APP_SECRET, rawBody + 'x', signature)).toBe(false)
  })
})

describe('Given webhook 解包规范化(§9.2)', () => {
  it('When 文本消息 Then kind=text / peer=direct(from)', () => {
    const r = whatsappWebhookToMessages(textWebhook)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.messages).toHaveLength(1)
    const msg = r.messages[0]!
    expect(msg.kind).toBe('text')
    expect(msg.peer).toEqual({ kind: 'direct', id: '8613800000000' })
    expect(msg.content).toBe('你好,在吗')
  })

  it('When 图片消息 Then kind=attachment 且媒体 id 为 ref', () => {
    const r = whatsappWebhookToMessages(imageWebhook)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.messages[0]!.kind).toBe('attachment')
    expect(r.messages[0]!.attachment?.ref).toBe('media_2')
  })

  it('When 按钮回复 Then kind=approval_reply', () => {
    const r = whatsappWebhookToMessages(buttonReplyWebhook)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.messages[0]!.kind).toBe('approval_reply')
    expect(r.messages[0]!.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
  })

  it('When 一条 webhook 多条消息 Then 逐条规范化', () => {
    const r = whatsappWebhookToMessages(multiMessageWebhook)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.messages.map((m) => m.messageId)).toEqual(['wamid.4', 'wamid.5'])
  })

  it('When 非消息/非法 webhook Then 返回原因', () => {
    expect(whatsappWebhookToMessages(statusWebhook).ok).toBe(false)
    expect(whatsappWebhookToMessages(wrongObjectWebhook).ok).toBe(false)
    expect(whatsappWebhookToMessages(emptyWebhook).ok).toBe(false)
    expect(whatsappWebhookToMessages(null).ok).toBe(false)
  })

  it('When parseButtonId Then 兼容/非法边界', () => {
    expect(parseButtonId('{"approvalId":"x","action":"deny"}')).toEqual({ approvalId: 'x', action: 'deny' })
    expect(parseButtonId('bad')).toBeUndefined()
    expect(parseButtonId('{"a":"x","act":"hack"}')).toBeUndefined()
  })
})

describe('Given WhatsApp 按钮渲染(§9.3)', () => {
  it('When 审批卡 Then interactive buttons id 携带紧凑 JSON', () => {
    const card = renderCard({ kind: 'approval', approvalId: 'ap_1', title: '审批', body: '执行' })
    expect(card.interactive.type).toBe('button')
    expect(card.interactive.action.buttons.map((b) => b.reply.id)).toEqual(['{"a":"ap_1","act":"allow"}', '{"a":"ap_1","act":"deny"}'])
  })

  it('When 任务卡/决策卡 Then 按钮齐全', () => {
    const t = renderCard({ kind: 'task', taskId: 't_1', title: '任务', body: 'b', actions: ['accept', 'reject', 'report'] })
    expect(t.interactive.action.buttons).toHaveLength(3)
    const q = renderCard({ kind: 'question', questionId: 'q_1', title: 't', body: 'b', options: ['agree', 'reject', 'modify'] })
    expect(q.interactive.action.buttons).toHaveLength(3)
  })
})

describe('Given WhatsApp 长消息分段(4096)', () => {
  it('Then WHATSAPP_MAX=4096;超长分段', () => {
    expect(WHATSAPP_MAX).toBe(4096)
    expect(segmentText('a'.repeat(100) + '\n' + 'b'.repeat(6000)).length).toBeGreaterThan(1)
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

describe('Given WhatsappAdapter webhook 生命周期', () => {
  it('When 验签通过 Then 逐条规范化入站;重复消息去重;返回 200 OK', async () => {
    const inbound: string[] = []
    const { adapter } = makeAdapter({
      onInbound: (msg) => {
        inbound.push(`${msg.kind}:${msg.peer.id}:${msg.messageId}`)
      },
    })
    await adapter.start()
    const req1 = signedBody(multiMessageWebhook)
    const res1 = await adapter.handleWebhook(req1)
    expect(res1).toEqual({ status: 200, body: 'OK' })
    // 重放同一 webhook → 去重
    await adapter.handleWebhook(req1)
    expect(inbound).toEqual(['text:8613800000000:wamid.4', 'text:8613800000000:wamid.5'])
    // 按钮回复
    await adapter.handleWebhook(signedBody(buttonReplyWebhook))
    expect(inbound).toHaveLength(3)
    expect(inbound[2]).toBe('approval_reply:8613800000000:wamid.3')
    await adapter.stop()
  })

  it('When 验签失败 Then 401 且不处理(fail-closed)', async () => {
    const inbound: string[] = []
    const { adapter } = makeAdapter({ onInbound: (m) => inbound.push(m.messageId) })
    await adapter.start()
    const res = await adapter.handleWebhook({ rawBody: JSON.stringify(textWebhook), signature: 'sha256=bad' })
    expect(res.status).toBe(401)
    expect(inbound).toEqual([])
    const res2 = await adapter.handleWebhook({ rawBody: JSON.stringify(textWebhook) })
    expect(res2.status).toBe(401)
  })

  it('When 非法 JSON/非消息变更 Then 对应响应(不抛异常)', async () => {
    const { adapter } = makeAdapter()
    await adapter.start()
    const bad = await adapter.handleWebhook({ rawBody: 'not-json', signature: computeHubSignature(APP_SECRET, 'not-json') })
    expect(bad.status).toBe(400)
    const status = await adapter.handleWebhook(signedBody(statusWebhook))
    expect(status.status).toBe(200)
    await adapter.stop()
  })

  it('When sendText 超长 Then 分段发送;sendCard Then interactive;start/stop 幂等', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.start()
    await adapter.start()
    expect(adapter.isStarted()).toBe(true)
    await adapter.sendText({ kind: 'direct', id: '8613800000000' }, 'x'.repeat(100) + '\n' + 'y'.repeat(6000))
    expect(sent.text.length).toBeGreaterThan(1)
    await adapter.sendCard({ kind: 'direct', id: '8613800000000' }, { kind: 'approval', approvalId: 'a1', title: 't', body: 'b' })
    expect(sent.card).toHaveLength(1)
    await adapter.stop()
    await adapter.stop()
    expect(adapter.isStarted()).toBe(false)
  })
})
