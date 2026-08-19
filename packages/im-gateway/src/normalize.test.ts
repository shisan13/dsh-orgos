/**
 * im-gateway 测试:规范化/幂等/出站队列(§9.1/§9.2;T6 重放防护)
 */
import { describe, expect, it } from 'vitest'
import { normalizeMessage, dedupKey, IdempotencySet } from './normalize.ts'
import { OutboundQueue } from './outboundQueue.ts'
import type { NormalizedMessage } from './types.ts'

const VALID: NormalizedMessage = {
  channel: 'feishu',
  peer: { kind: 'group', id: 'oc_123' },
  sender: { id: 'ou_1', name: '张三' },
  kind: 'mention',
  content: '帮我看看这个 bug',
  messageId: 'om_abc',
  ts: '2026-08-19T08:00:00Z',
}

describe('Given 入站消息规范化(§9.2)', () => {
  it('When 合法消息 Then 收口为 NormalizedMessage(可选项缺省)', () => {
    const r = normalizeMessage(VALID)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.peer.kind).toBe('group')
    expect(r.msg.sender.name).toBe('张三')
    expect(r.msg.content).toBe('帮我看看这个 bug')
  })

  it('When 飞书私聊 Then kind=text / peer.kind=direct', () => {
    const r = normalizeMessage({ channel: 'feishu', peer: { kind: 'direct', id: 'ou_x' }, sender: { id: 'ou_x' }, kind: 'text', messageId: 'm1' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.peer.kind).toBe('direct')
  })

  it('When 审批回复 Then approval 结构化字段保留', () => {
    const r = normalizeMessage({ channel: 'feishu', peer: { kind: 'direct', id: 'ou_x' }, sender: { id: 'ou_x' }, kind: 'approval_reply', approval: { approvalId: 'ap_1', action: 'allow' }, messageId: 'm2' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.approval).toEqual({ approvalId: 'ap_1', action: 'allow' })
  })

  it('When 附件消息 Then attachment 引用保留', () => {
    const r = normalizeMessage({ channel: 'feishu', peer: { kind: 'group', id: 'g' }, sender: { id: 's' }, kind: 'attachment', attachment: { ref: 'file_1', name: 'a.png' }, messageId: 'm3' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.msg.attachment?.ref).toBe('file_1')
  })

  it('When 缺 messageId/kind/channel Then 字段级 issues(不抛异常)', () => {
    const r = normalizeMessage({ peer: { kind: 'group', id: 'g' }, sender: { id: 's' } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.issues.map((i) => i.field).sort()).toEqual(['channel', 'kind', 'messageId'])
  })

  it('When 非对象/peer 非法 Then 报错', () => {
    expect(normalizeMessage(null).ok).toBe(false)
    expect(normalizeMessage('x').ok).toBe(false)
    const r = normalizeMessage({ channel: 'feishu', peer: { kind: 'room', id: 'g' }, sender: { id: 's' }, kind: 'text', messageId: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issues[0]?.field).toBe('peer.kind')
  })
})

describe('Given 去重与幂等(T6 重放防护)', () => {
  it('Then dedupKey = channel:peer.id:messageId', () => {
    expect(dedupKey(VALID)).toBe('feishu:oc_123:om_abc')
    // 同一 peer 不同消息不同键
    expect(dedupKey({ ...VALID, messageId: 'om_2' })).not.toBe(dedupKey(VALID))
  })

  it('When 重复消息到达 Then 幂等集标记已见(首次 false,重复 true)', () => {
    const set = new IdempotencySet()
    const k = dedupKey(VALID)
    expect(set.seen(k)).toBe(false)
    expect(set.seen(k)).toBe(true)
    expect(set.size()).toBe(1)
  })

  it('When 超出容量 Then 淘汰最旧键(防无限增长)', () => {
    const set = new IdempotencySet(3)
    expect(set.seen('a')).toBe(false)
    expect(set.seen('b')).toBe(false)
    expect(set.seen('c')).toBe(false)
    expect(set.seen('d')).toBe(false)
    // a 已被淘汰:容量保持 3,重复键可识别,新键继续流转
    expect(set.seen('d')).toBe(true)
    expect(set.seen('c')).toBe(true)
    expect(set.size()).toBe(3)
    expect(set.seen('b')).toBe(true)
    expect(set.seen('a')).toBe(false)
    expect(set.size()).toBe(3)
  })
})

describe('Given 出站队列(§9.1 每 peer FIFO,at-least-once)', () => {
  const q = new OutboundQueue()
  const peer = { kind: 'group' as const, id: 'oc_1' }
  const peer2 = { kind: 'direct' as const, id: 'ou_1' }

  it('When 入队多条 Then 按 FIFO 出队且每 peer 独立', () => {
    expect(q.enqueue(peer, { target: peer, text: '1' }).ok).toBe(true)
    expect(q.enqueue(peer, { target: peer, text: '2' }).ok).toBe(true)
    expect(q.enqueue(peer2, { target: peer2, text: 'x' }).ok).toBe(true)
    expect(q.peek(peer)?.text).toBe('1')
    expect(q.dequeue(peer)?.text).toBe('1')
    expect(q.dequeue(peer)?.text).toBe('2')
    expect(q.dequeue(peer)).toBeUndefined()
    // peer2 不受 peer 影响
    expect(q.dequeue(peer2)?.text).toBe('x')
    expect(q.total()).toBe(0)
  })

  it('When 投递失败保留队首 Then 可重试(at-least-once)', () => {
    q.enqueue(peer, { target: peer, text: '重试测试' })
    // 模拟投递失败:peek 不消费
    const head = q.peek(peer)
    expect(head?.text).toBe('重试测试')
    expect(q.length(peer)).toBe(1)
    expect(q.dequeue(peer)?.text).toBe('重试测试')
  })

  it('When 队满 Then 拒绝入队且不丢已有内容', () => {
    const small = new OutboundQueue(2)
    small.enqueue(peer, { target: peer, text: '1' })
    small.enqueue(peer, { target: peer, text: '2' })
    const r = small.enqueue(peer, { target: peer, text: '3' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('已满')
    expect(small.length(peer)).toBe(2)
  })
})
