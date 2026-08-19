/**
 * im-wecom 测试:加密协议/验签/URL 验证/XML 解析/规范化/回调生命周期
 * (安全设计 §6:✅ AES 解密验签;T3 凭据不落盘)
 */
import { describe, expect, it } from 'vitest'
import { createCipheriv, randomBytes } from 'node:crypto'
import { encrypt, decrypt, signature, verifySignature, verifyUrl, WecomCryptoError } from './crypto.ts'
import { parseXmlTags, xmlTag, wrapVerifyXml } from './xml.ts'
import { wecomXmlToMessage, parseEventKey } from './events.ts'
import { renderApprovalCard, renderTaskCard, renderCard } from './cards.ts'
import { segmentText, convertTables, convertLatex, splitByLength, WECOM_MAX } from './format.ts'
import { WecomAdapter, type WecomAdapterOptions, type WecomSendTransport } from './WecomAdapter.ts'
import {
  TEST_AES_KEY,
  TEST_AGENT_ID,
  TEST_BOT_NAME,
  TEST_CORP_ID,
  TEST_TOKEN,
  cardEventXml,
  envelopeXml,
  ignoredEventXml,
  imageXml,
  plainGroupMentionXml,
  plainTextXml,
} from './fixtures/wecomEvents.ts'

const CONFIG = { token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY, corpId: TEST_CORP_ID }

function makeAdapter(overrides?: Partial<WecomAdapterOptions>): {
  adapter: WecomAdapter
  sent: { text: unknown[]; card: unknown[] }
} {
  const sent = { text: [] as unknown[], card: [] as unknown[] }
  const transport: WecomSendTransport = {
    async sendText(userId, text, agentId) {
      sent.text.push({ userId, text, agentId })
    },
    async sendCard(userId, card, agentId) {
      sent.card.push({ userId, card, agentId })
    },
  }
  const adapter = new WecomAdapter({
    credentials: { agentId: TEST_AGENT_ID, corpId: TEST_CORP_ID, token: TEST_TOKEN, encodingAESKey: TEST_AES_KEY },
    transport,
    botName: TEST_BOT_NAME,
    ...overrides,
  })
  return { adapter, sent }
}

/** 便捷:带 onInbound 的适配器 */
function makeAdapterWithInbound(onInbound: WecomAdapterOptions['onInbound']): {
  adapter: WecomAdapter
  sent: { text: unknown[]; card: unknown[] }
} {
  const base = makeAdapter({ onInbound })
  return base
}

describe('Given 企业微信加密协议(安全设计 §6)', () => {
  it('When 加密 → 解密 Then 明文往返一致且 receiveId 校验通过', () => {
    const cipher = encrypt(CONFIG, plainTextXml)
    expect(decrypt(CONFIG, cipher)).toBe(plainTextXml)
  })

  it('When 验签 Then 正确签名通过、错误签名拒绝', () => {
    const cipher = encrypt(CONFIG, plainTextXml)
    const sig = signature(TEST_TOKEN, '1720000000', 'nonce1', cipher)
    expect(verifySignature(CONFIG, '1720000000', 'nonce1', cipher, sig)).toBe(true)
    expect(verifySignature(CONFIG, '1720000000', 'nonce1', cipher, 'deadbeef')).toBe(false)
    // 签名对排序敏感(时间戳换位后不同)
    const sig2 = signature(TEST_TOKEN, '1720000000', 'nonce2', cipher)
    expect(sig2).not.toBe(sig)
  })

  it('When URL 验证 Then 解密 echostr 返回明文;签名错误抛 WecomCryptoError', () => {
    const echostr = 'verify_me_plain'
    const cipher = encrypt(CONFIG, echostr)
    const sig = signature(TEST_TOKEN, '1720000000', 'nonce1', cipher)
    expect(verifyUrl(CONFIG, { msg_signature: sig, timestamp: '1720000000', nonce: 'nonce1', echostr: cipher })).toBe(echostr)
    expect(() =>
      verifyUrl(CONFIG, { msg_signature: 'bad', timestamp: '1720000000', nonce: 'nonce1', echostr: cipher }),
    ).toThrow(WecomCryptoError)
  })

  it('When 非法 encodingAESKey/密文 Then 抛 WecomCryptoError(fail-closed)', () => {
    expect(() => encrypt({ ...CONFIG, encodingAESKey: 'short' }, 'x')).toThrow(WecomCryptoError)
    expect(() => decrypt(CONFIG, '!!!not-base64!!!')).toThrow(WecomCryptoError)
  })

  it('When 明文长度非法/receiveId 不匹配 Then 抛 WecomCryptoError', () => {
    // 构造畸形密文:长度字段非法
    const key = Buffer.from(`${TEST_AES_KEY}=`, 'base64')
    const iv = key.subarray(0, 16)
    const bogus = Buffer.concat([randomBytes(16), Buffer.alloc(4), Buffer.from('x')])
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    const badLen = Buffer.concat([cipher.update(bogus), cipher.final()]).toString('base64')
    expect(() => decrypt(CONFIG, badLen)).toThrow(WecomCryptoError)
    // receiveId 不匹配:加密时用其他 corpId
    const otherCfg = { ...CONFIG, corpId: 'ww_other' }
    const cipher2 = encrypt(otherCfg, 'hello')
    expect(() => decrypt(CONFIG, cipher2)).toThrow(/receiveId/)
  })
})

describe('Given 轻量 XML 解析', () => {
  it('Then 标签/CDATA 提取与单值查询', () => {
    const map = parseXmlTags(envelopeXml('abc'))
    expect(map.get('ToUserName')).toBe('ww_test_corp_123')
    expect(map.get('Encrypt')).toBe('abc')
    expect(xmlTag('<xml><A>1</A></xml>', 'A')).toBe('1')
    expect(xmlTag('<xml></xml>', 'A')).toBeUndefined()
  })

  it('Then 响应信封包装', () => {
    const xml = wrapVerifyXml('enc1', 't1', 'n1', 'sig1')
    expect(xmlTag(xml, 'Encrypt')).toBe('enc1')
    expect(xmlTag(xml, 'MsgSignature')).toBe('sig1')
  })
})

describe('Given 明文 XML → NormalizedMessage(§9.2)', () => {
  it('When 私聊文本 Then kind=text / peer=direct', () => {
    const r = wecomXmlToMessage(plainTextXml, TEST_BOT_NAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('text')
    expect(r.msg.peer).toEqual({ kind: 'direct', id: 'zhangsan' })
    expect(r.msg.content).toBe('你好')
    expect(r.msg.messageId).toBe('1234567890')
  })

  it('When 群 @bot Then kind=mention / peer=group', () => {
    const r = wecomXmlToMessage(plainGroupMentionXml, TEST_BOT_NAME)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('mention')
    expect(r.msg.peer.kind).toBe('group')
  })

  it('When 图片 Then kind=attachment 且 MediaId 为 ref', () => {
    const r = wecomXmlToMessage(imageXml)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('attachment')
    expect(r.msg.attachment?.ref).toBe('media_abc')
  })

  it('When 卡片按钮回调 Then kind=approval_reply', () => {
    const r = wecomXmlToMessage(cardEventXml)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.kind).toBe('approval_reply')
    expect(r.msg.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
  })

  it('When 忽略事件/非法消息 Then 返回原因', () => {
    expect(wecomXmlToMessage(ignoredEventXml).ok).toBe(false)
    expect(wecomXmlToMessage('<xml></xml>').ok).toBe(false)
  })

  it('When EventKey 解析 Then 紧凑/完整 JSON 兼容,非法拒绝', () => {
    expect(parseEventKey('{"a":"x","act":"deny"}')).toEqual({ approvalId: 'x', action: 'deny' })
    expect(parseEventKey('{"approvalId":"y","action":"allow"}')).toEqual({ approvalId: 'y', action: 'allow' })
    expect(parseEventKey('not-json')).toBeUndefined()
    expect(parseEventKey('{"a":"x","act":"hack"}')).toBeUndefined()
  })
})

describe('Given 企业微信卡片渲染(§9.3)', () => {
  it('When 审批卡 Then template_card button_list 携带 key JSON', () => {
    const card = renderApprovalCard({ kind: 'approval', approvalId: 'ap_1', title: '审批', body: '执行' })
    expect(card.msgtype).toBe('template_card')
    const keys = card.template_card.button_list?.map((b) => b.key)
    expect(keys).toEqual(['{"a":"ap_1","act":"allow"}', '{"a":"ap_1","act":"deny"}'])
  })

  it('When 任务卡 Then 按钮齐全且 task_id 唯一', () => {
    const card = renderTaskCard({ kind: 'task', taskId: 't_1', title: '任务', body: 'b', actions: ['accept', 'reject', 'report'] })
    expect(card.template_card.button_list).toHaveLength(3)
    expect(card.template_card.task_id).toBe('task-t_1')
  })

  it('Then renderCard 按 kind 分发', () => {
    expect(renderCard({ kind: 'approval', approvalId: 'a', title: 't', body: 'b' }).template_card.main_title.title).toBe('t')
    expect(renderCard({ kind: 'question', questionId: 'q', title: 't2', body: 'b', options: ['agree'] }).template_card.task_id).toBe('question-q')
  })
})

describe('Given 企业微信长消息分段(2048)', () => {
  it('Then WECOM_MAX=2048;超长按行边界分段', () => {
    expect(WECOM_MAX).toBe(2048)
    const segs = segmentText('a'.repeat(100) + '\n' + 'b'.repeat(3000))
    expect(segs.length).toBeGreaterThan(1)
  })

  it('Then 表格转列表(表头加粗)与 LaTeX 转代码块', () => {
    const t = convertTables('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(t).toContain('• **A** | **B**')
    expect(t).toContain('• 1 | 2')
    expect(convertLatex('公式 $x^2$ 与 $$y$$')).toContain('`x^2`')
    expect(splitByLength('x'.repeat(100) + '```\n' + 'y'.repeat(3000) + '\n```' + 'z'.repeat(10), 150)[0]!.text.endsWith('\n')).toBe(true)
  })
})

describe('Given WecomAdapter 回调生命周期(webhook 模式)', () => {
  it('When GET URL 验证 Then 返回加密 XML(验签/解密/回显闭环)', async () => {
    const { adapter } = makeAdapter()
    await adapter.start()
    const echostr = 'echo_plain_123'
    const cipher = encrypt(CONFIG, echostr)
    const sig = signature(TEST_TOKEN, 't1', 'n1', cipher)
    const res = await adapter.handleRequest({ method: 'GET', query: { msg_signature: sig, timestamp: 't1', nonce: 'n1', echostr: cipher }, body: '' })
    expect(res.status).toBe(200)
    // 回显密文可解密回原文(验证响应闭环)
    const respEncrypt = xmlTag(res.body, 'Encrypt')
    expect(decrypt(CONFIG, respEncrypt ?? '')).toBe(echostr)
    await adapter.stop()
  })

  it('When GET 验签失败 Then 400(fail-closed)', async () => {
    const { adapter } = makeAdapter()
    await adapter.start()
    const res = await adapter.handleRequest({ method: 'GET', query: { msg_signature: 'bad', timestamp: 't', nonce: 'n', echostr: 'x' }, body: '' })
    expect(res.status).toBe(400)
  })

  it('When POST 消息回调 Then 验签解密 → 规范化 → onInbound;重复回调去重', async () => {
    const inbound: string[] = []
    const { adapter } = makeAdapterWithInbound((msg) => {
      inbound.push(`${msg.kind}:${msg.peer.id}:${msg.messageId}`)
    })
    await adapter.start()
    const cipher = encrypt(CONFIG, plainTextXml)
    const sig = signature(TEST_TOKEN, 't1', 'n1', cipher)
    const body = envelopeXml(cipher)
    const res1 = await adapter.handleRequest({ method: 'POST', query: { msg_signature: sig, timestamp: 't1', nonce: 'n1' }, body })
    expect(res1).toEqual({ status: 200, body: 'success' })
    // 重放同一回调 → 去重
    await adapter.handleRequest({ method: 'POST', query: { msg_signature: sig, timestamp: 't1', nonce: 'n1' }, body })
    expect(inbound).toEqual(['text:zhangsan:1234567890'])
    // 新消息(不同 MsgId)
    const cipher2 = encrypt(CONFIG, cardEventXml)
    const sig2 = signature(TEST_TOKEN, 't2', 'n2', cipher2)
    await adapter.handleRequest({ method: 'POST', query: { msg_signature: sig2, timestamp: 't2', nonce: 'n2' }, body: envelopeXml(cipher2) })
    expect(inbound).toEqual(['text:zhangsan:1234567890', 'approval_reply:ww_test_corp_123:1234567893'])
  })

  it('When POST 验签失败/解密失败 Then 400 且不触发 onInbound', async () => {
    const inbound: string[] = []
    const { adapter } = makeAdapterWithInbound((msg) => {
      inbound.push(msg.messageId)
    })
    await adapter.start()
    const res1 = await adapter.handleRequest({ method: 'POST', query: { msg_signature: 'bad', timestamp: 't', nonce: 'n' }, body: envelopeXml('x') })
    expect(res1.status).toBe(400)
    // 签名正确但密文损坏
    const sig = signature(TEST_TOKEN, 't', 'n', 'broken')
    const res2 = await adapter.handleRequest({ method: 'POST', query: { msg_signature: sig, timestamp: 't', nonce: 'n' }, body: envelopeXml('broken') })
    expect(res2.status).toBe(400)
    expect(inbound).toEqual([])
  })

  it('When 缺查询参数/缺 echostr/缺 Encrypt Then 400', async () => {
    const { adapter } = makeAdapter()
    await adapter.start()
    const res = await adapter.handleRequest({ method: 'POST', query: {}, body: '' })
    expect(res.status).toBe(400)
    expect(res.body).toContain('msg_signature')
    const resGet = await adapter.handleRequest({ method: 'GET', query: { msg_signature: 's', timestamp: 't', nonce: 'n' }, body: '' })
    expect(resGet.status).toBe(400)
    const sig = signature(TEST_TOKEN, 't', 'n', 'enc')
    const resNoEncrypt = await adapter.handleRequest({ method: 'POST', query: { msg_signature: sig, timestamp: 't', nonce: 'n' }, body: '<xml></xml>' })
    expect(resNoEncrypt.status).toBe(400)
  })

  it('When sendText 超长 Then 分段发送;sendCard Then template_card;start/stop 幂等', async () => {
    const { adapter, sent } = makeAdapter()
    await adapter.start()
    await adapter.start()
    expect(adapter.isStarted()).toBe(true)
    await adapter.sendText({ kind: 'direct', id: 'zhangsan' }, 'x'.repeat(100) + '\n' + 'y'.repeat(3000))
    expect(sent.text.length).toBeGreaterThan(1)
    expect((sent.text[0] as { agentId: string }).agentId).toBe(TEST_AGENT_ID)
    await adapter.sendCard({ kind: 'direct', id: 'zhangsan' }, { kind: 'approval', approvalId: 'a1', title: 't', body: 'b' })
    expect(sent.card).toHaveLength(1)
    await adapter.stop()
    await adapter.stop()
    expect(adapter.isStarted()).toBe(false)
  })
})
