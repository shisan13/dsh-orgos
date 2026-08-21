/**
 * FeishuDocsClient 协议层测试:Given-When-Then(AGENTS.md §4 闸门)
 * fetch 注入 mock(响应形状按已核实的官方 docx-v1/drive-v1 API 构造),
 * 覆盖 token 缓存与 401 刷新、create/getMeta/rawContent/setBody 双路径/list/search/错误传播。
 */
import { describe, expect, it } from 'vitest'
import { FeishuDocsClient, FeishuDocsError, type FetchLike } from './index.js'

interface Call {
  url: string
  init?: { method?: string; headers?: Record<string, string>; body?: string }
}

/** 构造统一 mock 响应(默认业务成功) */
function respond(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

/**
 * 路由式 fetch mock:按 URL/method 分发,handlers 可逐项覆盖。
 * 响应形状全部对齐已核实官方文档:
 * - 块列表:data.items[] { block_id, block_type, parent_id, children, text }
 * - batch_update:data.document_revision_id;children 创建/删除:data.document_revision_id
 * - drive/files:data.files[] { token, name, type, url, modified_time }
 */
function makeFetch(calls: Call[], handlers: Record<string, unknown> = {}): FetchLike {
  return async (url, init) => {
    calls.push({ url, init })
    if (url.includes('tenant_access_token')) {
      return respond(handlers.token ?? { code: 0, tenant_access_token: 'tok-1', expire: 7200 })
    }
    if (init?.method === 'POST' && /\/documents$/.test(url)) {
      return respond(handlers.create ?? { code: 0, data: { document: { document_id: 'doxcABC123', revision_id: 1, title: '周报' } } })
    }
    if (init?.method === 'GET' && /\/documents\/[^/]+$/.test(url)) {
      return respond(handlers.meta ?? { code: 0, data: { document: { document_id: 'doxcABC123', revision_id: 5, title: '团队周报' } } })
    }
    if (url.includes('raw_content')) {
      return respond(handlers.raw ?? { code: 0, data: { content: '第一行\n第二行\n' } })
    }
    if (init?.method === 'PATCH' && url.includes('batch_update')) {
      return respond(handlers.patch ?? { code: 0, data: { document_revision_id: 6 } })
    }
    if (init?.method === 'DELETE' && url.includes('batch_delete')) {
      return respond(handlers.delete ?? { code: 0, data: { document_revision_id: 7 } })
    }
    if (init?.method === 'POST' && url.includes('/children')) {
      return respond(handlers.children ?? { code: 0, data: { children: [{ block_id: 'b-new', block_type: 2 }], document_revision_id: 3 } })
    }
    if (init?.method === 'GET' && url.includes('/blocks')) {
      return respond(handlers.blocks ?? {
        code: 0,
        data: { items: [
          { block_id: 'root', block_type: 1, parent_id: '', children: ['b1'] },
          { block_id: 'b1', block_type: 2, parent_id: 'root', text: { elements: [{ text_run: { content: '旧内容' } }] } },
        ] },
      })
    }
    if (url.includes('drive/v1/files')) {
      return respond(handlers.files ?? {
        code: 0,
        data: { files: [
          { token: 'doxcA', name: '方案A', type: 'docx', url: 'https://feishu.cn/docx/doxcA', modified_time: '1700000000' },
          { token: 'shtB', name: '表格B', type: 'sheet' },
        ] },
      })
    }
    return respond(handlers.fallback ?? { code: 0, data: {} })
  }
}

const client = (calls: Call[], handlers?: Record<string, unknown>): FeishuDocsClient =>
  new FeishuDocsClient({ appId: 'cli_x', appSecret: 'sec' }, makeFetch(calls, handlers))

describe('FeishuDocsClient(协议层)', () => {
  it('GIVEN 首次创建 WHEN createDocument THEN 先取 token 再 POST /documents 并返回 documentId/revision', async () => {
    const calls: Call[] = []
    const created = await client(calls).createDocument('周报')
    expect(calls[0]?.url).toContain('tenant_access_token')
    expect(calls[1]?.url).toMatch(/\/documents$/)
    expect(calls[1]?.init?.method).toBe('POST')
    expect(calls[1]?.init?.headers?.Authorization).toBe('Bearer tok-1')
    expect(JSON.parse(calls[1]?.init?.body ?? '{}')).toEqual({ title: '周报' })
    expect(created).toEqual({ documentId: 'doxcABC123', revision: '1' })
  })

  it('GIVEN token 未过期 WHEN 连续两次请求 THEN 复用缓存只取一次 token', async () => {
    const calls: Call[] = []
    const c = client(calls)
    await c.createDocument('一')
    await c.createDocument('二')
    expect(calls.filter((x) => x.url.includes('tenant_access_token')).length).toBe(1)
  })

  it('GIVEN 业务请求 401 WHEN 首次请求 THEN 刷新 token 后重试成功', async () => {
    const calls: Call[] = []
    let tokenHits = 0
    let businessHits = 0
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('tenant_access_token')) {
        tokenHits += 1
        // 不返回 expire,覆盖 expire ?? 7200 兜底分支
        return respond({ code: 0, tenant_access_token: tokenHits === 1 ? 'tok-1' : 'tok-2' })
      }
      businessHits += 1
      if (businessHits === 1) return { ok: false, status: 401, json: async () => ({ code: 99991668, msg: 'token expired' }) }
      return respond({ code: 0, data: { document: { document_id: 'doxcABC123', revision_id: 1 } } })
    }
    const created = await new FeishuDocsClient({ appId: 'cli_x', appSecret: 'sec' }, fetchImpl).createDocument('周报')
    expect(created.documentId).toBe('doxcABC123')
    expect(calls.filter((x) => x.url.includes('tenant_access_token')).length).toBe(2)
    const auths = calls.filter((x) => !x.url.includes('tenant_access_token')).map((x) => x.init?.headers?.Authorization)
    expect(auths).toEqual(['Bearer tok-1', 'Bearer tok-2'])
  })

  it('GIVEN 刷新后仍 401 WHEN 请求 THEN 抛出带 code 错误且不无限重试', async () => {
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('tenant_access_token')) return respond({ code: 0, tenant_access_token: 'tok-1' })
      return { ok: false, status: 401, json: async () => ({ code: 99991668, msg: 'token expired' }) }
    }
    const c = new FeishuDocsClient({ appId: 'cli_x', appSecret: 'sec' }, fetchImpl)
    await expect(c.createDocument('周报')).rejects.toThrow('99991668')
    expect(calls.filter((x) => !x.url.includes('tenant_access_token')).length).toBe(2)
  })

  it('GIVEN token 接口失败(500 无 code)WHEN 请求 THEN 抛出带 HTTP 状态码摘要的错误', async () => {
    const failing: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({ msg: 'internal' }) })
    const c = new FeishuDocsClient({ appId: 'x', appSecret: 'bad' }, failing)
    await expect(c.createDocument('周报')).rejects.toThrow('500')
  })

  it('GIVEN 文档存在 WHEN getMeta THEN 返回 title/revision 与 feishu.cn 打开链接', async () => {
    const meta = await client([]).getMeta('doxcABC123')
    expect(meta).toEqual({ title: '团队周报', revision: '5', url: 'https://feishu.cn/docx/doxcABC123' })
  })

  it('GIVEN 响应缺 document 字段 WHEN getMeta THEN 抛文档不存在(1770002)', async () => {
    await expect(client([], { meta: { code: 0, data: {} } }).getMeta('doxcABC123')).rejects.toThrow('1770002')
  })

  it('GIVEN 空 document 对象 WHEN getMeta THEN title 兜底空串、revision 兜底 1', async () => {
    const meta = await client([], { meta: { code: 0, data: { document: {} } } }).getMeta('doxcABC123')
    expect(meta.title).toBe('')
    expect(meta.revision).toBe('1')
  })

  it('GIVEN 文档存在 WHEN getRawContent THEN 返回纯文本内容', async () => {
    expect(await client([]).getRawContent('doxcABC123')).toBe('第一行\n第二行\n')
  })

  it('GIVEN raw_content 响应缺 content WHEN 请求 THEN 兜底返回空串', async () => {
    expect(await client([], { raw: { code: 0, data: {} } }).getRawContent('doxcABC123')).toBe('')
  })

  it('GIVEN 存在单个文本块 WHEN setBody THEN PATCH batch_update 整块替换且不删除', async () => {
    const calls: Call[] = []
    const revision = await client(calls).setBody('doxcABC123', '新正文')
    expect(revision).toBe('6')
    const patch = calls.find((x) => x.init?.method === 'PATCH')
    expect(patch?.url).toContain('/blocks/batch_update')
    const body = JSON.parse(patch?.init?.body ?? '{}') as { requests: Array<{ block_id: string; update_text_elements: { elements: Array<{ text_run: { content: string } }> } }> }
    expect(body.requests[0]?.block_id).toBe('b1')
    expect(body.requests[0]?.update_text_elements.elements[0]?.text_run.content).toBe('新正文')
    expect(calls.some((x) => x.init?.method === 'DELETE')).toBe(false)
  })

  it('GIVEN 存在文本块与其它子块 WHEN setBody THEN 替换首块并 batch_delete 其余子块(整块替换)', async () => {
    const calls: Call[] = []
    const handlers = {
      blocks: {
        code: 0,
        data: { items: [
          { block_id: 'root', block_type: 1, parent_id: '', children: ['b1', 'b2'] },
          { block_id: 'b1', block_type: 2, parent_id: 'root', text: { elements: [{ text_run: { content: '旧' } }] } },
          { block_id: 'b2', block_type: 22, parent_id: 'root' },
        ] },
      },
    }
    const revision = await client(calls, handlers).setBody('doxcABC123', '整块正文')
    expect(revision).toBe('7')
    const del = calls.find((x) => x.init?.method === 'DELETE')
    expect(del?.url).toContain('/children/batch_delete')
    expect(JSON.parse(del?.init?.body ?? '{}')).toEqual({ start_index: 1, end_index: 2 })
  })

  it('GIVEN 无正文块 WHEN setBody THEN create children 追加一个 text 块', async () => {
    const calls: Call[] = []
    const handlers = {
      blocks: { code: 0, data: { items: [{ block_id: 'root', block_type: 1, parent_id: '', children: [] }] } },
    }
    const revision = await client(calls, handlers).setBody('doxcABC123', '追加正文')
    expect(revision).toBe('3')
    const created = calls.find((x) => x.init?.method === 'POST' && x.url.includes('/children'))
    const body = JSON.parse(created?.init?.body ?? '{}') as { children: Array<{ block_type: number; text: { elements: Array<{ text_run: { content: string } }> } }> }
    expect(body.children[0]?.block_type).toBe(2)
    expect(body.children[0]?.text.elements[0]?.text_run.content).toBe('追加正文')
  })

  it('GIVEN 空 body WHEN setBody THEN 不写任何块只返回当前版本', async () => {
    const calls: Call[] = []
    const revision = await client(calls).setBody('doxcABC123', '')
    expect(revision).toBe('5')
    // 排除 token 请求本身(POST)后,不应有任何块写操作(PATCH/POST/DELETE)
    const writes = calls.filter((x) => !x.url.includes('tenant_access_token'))
    expect(writes.some((x) => ['PATCH', 'POST', 'DELETE'].includes(x.init?.method ?? ''))).toBe(false)
  })

  it('GIVEN 写响应缺 document_revision_id WHEN setBody(追加)THEN 回退 getMeta 返回当前版本', async () => {
    const calls: Call[] = []
    const handlers = {
      blocks: { code: 0, data: { items: [{ block_id: 'root', block_type: 1, parent_id: '', children: [] }] } },
      children: { code: 0, data: { children: [] } },
    }
    expect(await client(calls, handlers).setBody('doxcABC123', '正文')).toBe('5')
  })

  it('GIVEN 写响应均缺 revision WHEN setBody(替换多子块)THEN 回退 getMeta 返回当前版本', async () => {
    const handlers = {
      blocks: {
        code: 0,
        data: { items: [
          { block_id: 'root', block_type: 1, parent_id: '', children: ['b1', 'b2'] },
          { block_id: 'b1', block_type: 2, parent_id: 'root' },
          { block_id: 'b2', block_type: 2, parent_id: 'root' },
        ] },
      },
      patch: { code: 0, data: {} },
      delete: { code: 0, data: {} },
    }
    expect(await client([], handlers).setBody('doxcABC123', '正文')).toBe('5')
  })

  it('GIVEN 文档无根页面块 WHEN setBody THEN 抛文档不存在(1770002)', async () => {
    const handlers = { blocks: { code: 0, data: { items: [{ block_id: 'x', block_type: 2 }] } } }
    await expect(client([], handlers).setBody('doxcABC123', '正文')).rejects.toThrow('1770002')
  })

  it('GIVEN 配置了 folderToken WHEN listDocuments THEN GET drive/files 且仅返回 docx', async () => {
    const calls: Call[] = []
    const refs = await client(calls).listDocuments('fldX', { limit: 20 })
    expect(calls[1]?.url).toContain('/open-apis/drive/v1/files')
    expect(calls[1]?.url).toContain('folder_token=fldX')
    expect(calls[1]?.url).toContain('page_size=20')
    expect(refs).toEqual([
      { id: 'doxcA', title: '方案A', url: 'https://feishu.cn/docx/doxcA', updatedAt: new Date(1700000000 * 1000).toISOString() },
    ])
  })

  it('GIVEN 文件缺 url/modified_time WHEN listDocuments THEN url 回退拼接、updatedAt 缺省/原样', async () => {
    const handlers = {
      files: {
        code: 0,
        data: { files: [
          { token: 'doxcN', name: '无链接', type: 'docx' },
          { token: 'doxcM', name: '坏时间', type: 'docx', modified_time: 'not-a-time' },
        ] },
      },
    }
    const refs = await client([], handlers).listDocuments('fldX')
    expect(refs[0]).toEqual({ id: 'doxcN', title: '无链接', url: 'https://feishu.cn/docx/doxcN', updatedAt: undefined })
    expect(refs[1]?.updatedAt).toBe('not-a-time')
  })

  it('GIVEN 未配置 folderToken WHEN listDocuments THEN 返回空数组且不发请求(不虚构实现)', async () => {
    const calls: Call[] = []
    expect(await client(calls).listDocuments(undefined)).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('GIVEN 文件夹超过一页 WHEN listDocuments THEN 按 page_token 循环取全且合并 docx', async () => {
    const calls: Call[] = []
    const pages = [
      { code: 0, data: { files: [
        { token: 'doxc1', name: '第1篇', type: 'docx' },
        { token: 'doxc2', name: '第2篇', type: 'docx' },
        { token: 'sht1', name: '表格', type: 'sheet' },
      ], has_more: true, page_token: 'pt-2' } },
      { code: 0, data: { files: [
        { token: 'doxc3', name: '第3篇', type: 'docx' },
      ], has_more: false } },
    ]
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('tenant_access_token')) return respond({ code: 0, tenant_access_token: 'tok-1', expire: 7200 })
      const page = url.includes('page_token=pt-2') ? 1 : 0
      return respond(pages[page] as never)
    }
    const refs = await new FeishuDocsClient({ appId: 'cli_x', appSecret: 's' }, fetchImpl).listDocuments('fldX', { limit: 50 })
    expect(refs.map((r) => r.title)).toEqual(['第1篇', '第2篇', '第3篇'])
    expect(calls.some((c) => c.url.includes('page_token=pt-2'))).toBe(true)
    // 分页请求的 page_size 按剩余量收敛(50-2=48)
    expect(calls[2]?.url).toContain('page_size=48')
  })

  it('GIVEN limit 小于单页 WHEN listDocuments THEN 只请求一页且截断到 limit', async () => {
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('tenant_access_token')) return respond({ code: 0, tenant_access_token: 'tok-1', expire: 7200 })
      return respond({ code: 0, data: { files: [
        { token: 'doxc1', name: 'A', type: 'docx' },
        { token: 'doxc2', name: 'B', type: 'docx' },
        { token: 'doxc3', name: 'C', type: 'docx' },
      ], has_more: true, page_token: 'pt-2' } })
    }
    const refs = await new FeishuDocsClient({ appId: 'cli_x', appSecret: 's' }, fetchImpl).listDocuments('fldX', { limit: 2 })
    expect(refs.map((r) => r.title)).toEqual(['A', 'B'])
    expect(calls.filter((c) => c.url.includes('drive/v1/files'))).toHaveLength(1)
  })

  it('GIVEN 后端 next page_token 恒同 WHEN listDocuments THEN 防御性终止不死循环', async () => {
    const calls: Call[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init })
      if (url.includes('tenant_access_token')) return respond({ code: 0, tenant_access_token: 'tok-1', expire: 7200 })
      return respond({ code: 0, data: { files: [{ token: 'doxc1', name: 'A', type: 'docx' }], has_more: true, page_token: 'same' } })
    }
    const refs = await new FeishuDocsClient({ appId: 'cli_x', appSecret: 's' }, fetchImpl).listDocuments('fldX')
    // 第二页(重复 token)仍被收集一次,但循环终止:drive 请求恰好 2 次,不死循环
    expect(calls.filter((c) => c.url.includes('drive/v1/files'))).toHaveLength(2)
    expect(refs.length).toBeLessThanOrEqual(2)
  })

  it('GIVEN createDocument 带 folderToken WHEN 创建 THEN body 携带 folder_token;不带则无该字段', async () => {
    const calls: Call[] = []
    const c = client(calls)
    await c.createDocument('带目录文档', { folderToken: 'fld-9' })
    await c.createDocument('默认目录文档')
    const createBodies = calls
      .filter((x) => x.init?.method === 'POST' && /\/documents$/.test(x.url))
      .map((x) => JSON.parse(x.init?.body ?? '{}'))
    expect(createBodies[0]).toEqual({ title: '带目录文档', folder_token: 'fld-9' })
    expect(createBodies[1]).toEqual({ title: '默认目录文档' })
  })

  it('GIVEN 未核实搜索端点 WHEN searchDocuments THEN 保守返回空数组', async () => {
    const calls: Call[] = []
    expect(await client(calls).searchDocuments('周报')).toEqual([])
    expect(calls.length).toBe(0)
  })

  it('GIVEN 业务 code 非 0 WHEN 请求 THEN 抛出带 code 的错误', async () => {
    await expect(client([], { meta: { code: 1770002, msg: 'not found' } }).getMeta('doxcABC123')).rejects.toThrow('1770002')
  })

  it('GIVEN 创建响应缺 document_id WHEN createDocument THEN 抛 EMPTY_RESPONSE', async () => {
    await expect(client([], { create: { code: 0, data: {} } }).createDocument('周报')).rejects.toThrow('EMPTY_RESPONSE')
  })

  it('GIVEN 错误对象 WHEN 捕获 THEN 携带 code/msg 且不含凭据', async () => {
    try {
      await client([], { meta: { code: 1770002, msg: 'not found' } }).getMeta('doxcABC123')
      expect.unreachable('应抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(FeishuDocsError)
      const e = error as FeishuDocsError
      expect(e.code).toBe('1770002')
      expect(e.msg).toBe('not found')
      expect(String(error)).not.toContain('sec')
      expect(String(error)).not.toContain('cli_x')
    }
  })
})
