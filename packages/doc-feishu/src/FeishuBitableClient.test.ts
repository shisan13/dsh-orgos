/**
 * FeishuBitableClient 协议层测试:Given-When-Then(AGENTS.md §4 闸门)
 * fetch 注入 mock,覆盖 token 缓存/记录 CRUD/搜索/错误路径。
 */
import { describe, expect, it } from 'vitest'
import { FeishuBitableClient, type FetchLike } from './index.js'

interface Call {
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string }
}

function makeFetch(calls: Call[], handlers?: Record<string, unknown>): FetchLike {
  return async (url, init) => {
    calls.push({ url, init })
    if (url.includes('tenant_access_token')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, tenant_access_token: 'tok-1', expire: 7200 }) }
    }
    if (url.endsWith('/records') && init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}') as { fields: Record<string, unknown> }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { record: { record_id: 'rec-new', fields: body.fields } } }) }
    }
    if (url.includes('/records/search')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { items: [{ record_id: 'rec-2', fields: { 标题: '查询结果' } }] } }) }
    }
    if (url.includes('/records/rec-1')) {
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { record: { record_id: 'rec-1', fields: { 标题: '知识文档', 正文: '正文内容' } } } }) }
    }
    if (url.includes('/records/rec-ghost')) {
      return { ok: true, status: 200, json: async () => ({ code: 1240, msg: 'Record not found' }) }
    }
    if (url.includes('page_size')) {
      return { ok: true, status: 200, json: async () => (handlers?.list ?? { code: 0, data: { items: [{ record_id: 'rec-1', fields: { 标题: '知识文档' } }, { record_id: 'rec-2', fields: { 标题: '第二篇' } }] } }) }
    }
    return { ok: true, status: 200, json: async () => (handlers?.fallback ?? { code: 0, data: {} }) }
  }
}

const client = (calls: Call[], handlers?: Record<string, unknown>): FeishuBitableClient =>
  new FeishuBitableClient(
    { appId: 'cli_x', appSecret: 'sec', appToken: 'bascX', tableId: 'tblY' },
    makeFetch(calls, handlers),
  )

describe('FeishuBitableClient(协议层)', () => {
  it('GIVEN 首次请求 WHEN listRecords THEN 先取 token 再列记录', async () => {
    const calls: Call[] = []
    const records = await client(calls).listRecords(10)
    expect(calls[0]?.url).toContain('tenant_access_token')
    expect(calls[1]?.url).toContain('page_size=10')
    expect(calls[1]?.init?.headers?.Authorization).toBe('Bearer tok-1')
    expect(records.map((r) => r.recordId)).toEqual(['rec-1', 'rec-2'])
  })

  it('GIVEN token 未过期 WHEN 连续请求 THEN 复用缓存不重复取 token', async () => {
    const calls: Call[] = []
    const c = client(calls)
    await c.listRecords(10)
    await c.listRecords(10)
    expect(calls.filter((x) => x.url.includes('tenant_access_token')).length).toBe(1)
  })

  it('GIVEN 记录存在 WHEN getRecord THEN 返回字段', async () => {
    const record = await client([]).getRecord('rec-1')
    expect(record?.recordId).toBe('rec-1')
    expect(record?.fields['正文']).toBe('正文内容')
  })

  it('GIVEN 记录不存在(1240)WHEN getRecord THEN undefined', async () => {
    expect(await client([]).getRecord('rec-ghost')).toBeUndefined()
  })

  it('GIVEN 创建 WHEN createRecord THEN 标题/正文落对应字段', async () => {
    const calls: Call[] = []
    const record = await client(calls).createRecord({ 标题: '新文档', 正文: '内容' })
    expect(record.recordId).toBe('rec-new')
    const body = JSON.parse(calls.find((x) => x.url.includes('/records') && x.init?.method === 'POST')?.init?.body ?? '{}') as { fields: Record<string, unknown> }
    expect(body.fields).toEqual({ 标题: '新文档', 正文: '内容' })
  })

  it('GIVEN 更新 WHEN updateRecord THEN PUT 到记录路径', async () => {
    const calls: Call[] = []
    await client(calls).updateRecord('rec-1', { 正文: '改后' })
    const put = calls.find((x) => x.init?.method === 'PUT')
    expect(put?.url).toContain('/records/rec-1')
    expect(JSON.parse(put?.init?.body ?? '{}')).toEqual({ fields: { 正文: '改后' } })
  })

  it('GIVEN 搜索 WHEN searchRecords THEN 标题字段 contains 条件', async () => {
    const calls: Call[] = []
    const records = await client(calls).searchRecords('知识')
    expect(records[0]?.recordId).toBe('rec-2')
    const body = JSON.parse(calls.find((x) => x.url.includes('search'))?.init?.body ?? '{}') as { filter: { conditions: Array<{ field_name: string; operator: string; value: string[] }> } }
    expect(body.filter.conditions[0]).toEqual({ field_name: '标题', operator: 'contains', value: ['知识'] })
  })

  it('GIVEN token 接口失败 WHEN 请求 THEN 抛出可读错误', async () => {
    const failing: FetchLike = async () => ({ ok: true, status: 200, json: async () => ({ code: 999, msg: 'invalid app secret' }) })
    const c = new FeishuBitableClient({ appId: 'x', appSecret: 'bad', appToken: 'b', tableId: 't' }, failing)
    await expect(c.listRecords()).rejects.toThrow('invalid app secret')
  })

  it('GIVEN 业务 code 非 0 WHEN 请求 THEN 抛出带 code 错误', async () => {
    const calls: Call[] = []
    const handlers = { list: { code: 500, msg: 'internal error' } }
    await expect(client(calls, handlers).listRecords(10)).rejects.toThrow('500')
  })
})
