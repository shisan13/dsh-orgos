import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 协议层:provider 只关心 client 的返回值;
// 注意:mock 类必须用普通 function(非箭头函数)构造,并同步 mock 出 FeishuDocsError(绑定层 instanceof 分支需要)
const mocks = {
  createDocument: vi.fn(),
  getMeta: vi.fn(),
  getRawContent: vi.fn(),
  setBody: vi.fn(),
  listDocuments: vi.fn(),
  searchDocuments: vi.fn(),
}

vi.mock('../index', () => {
  class MockFeishuDocsError extends Error {
    code: string
    msg: string
    constructor(code: string, msg: string) {
      super(`飞书云文档请求失败:code=${code} msg=${msg}`)
      this.code = code
      this.msg = msg
    }
  }
  return {
    FeishuDocsClient: vi.fn(function () {
      return { ...mocks }
    }),
    FeishuDocsError: MockFeishuDocsError,
  }
})

import { apply } from './index'
import { FeishuDocsError } from '../index'

interface Ctx {
  providerRef: { current?: unknown }
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
  credentials: { resolve: ReturnType<typeof vi.fn> }
  teamService: { registerDocumentProvider: ReturnType<typeof vi.fn> }
}

function ctx(): Ctx {
  const providerRef: { current?: unknown } = {}
  const logger = { info: vi.fn(), warn: vi.fn() }
  const credentials = { resolve: vi.fn().mockResolvedValue({ value: 'app-id:app-secret' }) }
  const teamService = {
    registerDocumentProvider: vi.fn((p: unknown) => {
      providerRef.current = p
      return () => {}
    }),
  }
  return { providerRef, logger, credentials, teamService }
}

/** apply 后取回 provider(供用例直接驱动) */
async function applyProvider(config: Record<string, unknown> = {}, c: Ctx = ctx()): Promise<unknown> {
  await apply(
    { credentials: c.credentials, teamService: c.teamService, logger: c.logger } as never,
    config as never,
  )
  return c.providerRef.current
}

describe('doc-feishu-docs dsh 行(绑定层)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GIVEN 凭据解析成功 WHEN apply THEN 注册 id=feishu-docs provider 且 listDocuments 透传 folderToken', async () => {
    const c = ctx()
    const provider = (await applyProvider({ credentialRef: 'feishu', folderToken: 'fldX' }, c)) as {
      id: string
      label: string
      listDocuments: (scope: unknown, opts?: unknown) => Promise<unknown>
    }
    expect(provider.id).toBe('feishu-docs')
    expect(provider.label).toBe('飞书云文档')
    expect(c.teamService.registerDocumentProvider).toHaveBeenCalledTimes(1)
    mocks.listDocuments.mockResolvedValue([{ id: 'doxc1', title: '周报' }])
    await expect(provider.listDocuments({}, { limit: 10 })).resolves.toEqual([{ id: 'doxc1', title: '周报' }])
    expect(mocks.listDocuments).toHaveBeenCalledWith('fldX', { limit: 10 })
    expect(c.logger.info).toHaveBeenCalled()
  })

  it('GIVEN 配置了 label WHEN apply THEN 使用自定义展示名', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu', label: '团队云文档' })) as { label: string }
    expect(provider.label).toBe('团队云文档')
  })

  it('GIVEN folderMap 命中 scope.teamId WHEN listDocuments THEN 按团队映射文件夹检索', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu', folderToken: 'fld-default', folderMap: { 'team-main': 'fld-main', 'team-b': 'fld-b' } })) as {
      listDocuments: (scope: unknown, opts?: unknown) => Promise<unknown>
    }
    mocks.listDocuments.mockResolvedValue([])
    await provider.listDocuments({ teamId: 'team-main' }, { limit: 5 })
    await provider.listDocuments({ teamId: 'team-b' }, { limit: 5 })
    await provider.listDocuments({}, { limit: 5 })
    await provider.listDocuments({ teamId: 'team-x' }, { limit: 5 })
    expect(mocks.listDocuments).toHaveBeenNthCalledWith(1, 'fld-main', { limit: 5 })
    expect(mocks.listDocuments).toHaveBeenNthCalledWith(2, 'fld-b', { limit: 5 })
    expect(mocks.listDocuments).toHaveBeenNthCalledWith(3, 'fld-default', { limit: 5 })
    expect(mocks.listDocuments).toHaveBeenNthCalledWith(4, 'fld-default', { limit: 5 })
  })

  it('GIVEN folderMap 命中团队 WHEN createDocument THEN 文档建到团队文件夹(body.folder_token)', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu', folderToken: 'fld-default', folderMap: { 'team-main': 'fld-main' } })) as {
      createDocument: (scope: unknown, doc: { title: string; body: string }) => Promise<unknown>
    }
    mocks.createDocument.mockResolvedValue({ documentId: 'doxc1', revision: '1' })
    mocks.getMeta.mockResolvedValue({ title: '周报', revision: '2', url: 'https://feishu.cn/docx/doxc1' })
    await provider.createDocument({ teamId: 'team-main' }, { title: '周报', body: '' })
    expect(mocks.createDocument).toHaveBeenCalledWith('周报', { folderToken: 'fld-main' })
  })

  it('GIVEN 无 folderToken 且无 folderMap 命中 WHEN listDocuments THEN 传 undefined(协议层返回空)', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      listDocuments: (scope: unknown, opts?: unknown) => Promise<unknown>
    }
    mocks.listDocuments.mockResolvedValue([])
    await provider.listDocuments({ teamId: 'team-main' }, { limit: 5 })
    expect(mocks.listDocuments).toHaveBeenCalledWith(undefined, { limit: 5 })
  })

  it('GIVEN 缺 credentialRef WHEN apply THEN 不注册并告警', async () => {
    const c = ctx()
    await applyProvider({ folderToken: 'fldX' }, c)
    expect(c.teamService.registerDocumentProvider).not.toHaveBeenCalled()
    expect(c.providerRef.current).toBeUndefined()
    expect(c.logger.warn).toHaveBeenCalled()
  })

  it('GIVEN 凭据缺 appSecret WHEN apply THEN 不注册并告警', async () => {
    const c = ctx()
    c.credentials.resolve.mockResolvedValue({ value: 'only-app-id' })
    await applyProvider({ credentialRef: 'feishu' }, c)
    expect(c.teamService.registerDocumentProvider).not.toHaveBeenCalled()
    expect(c.logger.warn).toHaveBeenCalled()
  })

  it('GIVEN 凭据缺 appId WHEN apply THEN 不注册并告警', async () => {
    const c = ctx()
    c.credentials.resolve.mockResolvedValue({ value: ':only-secret' })
    await applyProvider({ credentialRef: 'feishu' }, c)
    expect(c.teamService.registerDocumentProvider).not.toHaveBeenCalled()
  })

  it('GIVEN 凭据未配置(resolve 返回 undefined)WHEN apply THEN 不注册并告警', async () => {
    const c = ctx()
    c.credentials.resolve.mockResolvedValue(undefined)
    await applyProvider({ credentialRef: 'feishu' }, c)
    expect(c.teamService.registerDocumentProvider).not.toHaveBeenCalled()
    expect(c.logger.warn).toHaveBeenCalled()
  })

  it('GIVEN 服务器 revision 与期望版本不符 WHEN updateDocument THEN 返回 STALE_DOCUMENT 且不写库', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      updateDocument: (ref: unknown, patch: unknown, opts?: unknown) => Promise<{
        ok: boolean
        code?: string
        currentVersion?: string
        ref?: unknown
      }>
    }
    mocks.getMeta.mockResolvedValue({ title: '周报', revision: 'v3', url: 'https://feishu.cn/docx/doxc1' })
    const result = await provider.updateDocument(
      { id: 'doxc1', title: '周报', version: 'v1' },
      { body: '新内容' },
      { expectedVersion: 'v2' },
    )
    expect(result).toEqual({ ok: false, code: 'STALE_DOCUMENT', currentVersion: 'v3' })
    expect(mocks.setBody).not.toHaveBeenCalled()
  })

  it('GIVEN 版本匹配 WHEN updateDocument(body patch)THEN setBody 落库并返回新 ref(version=新 revision)', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      updateDocument: (ref: unknown, patch: unknown, opts?: unknown) => Promise<{ ok: boolean; ref?: unknown }>
    }
    mocks.getMeta.mockResolvedValue({ title: '周报', revision: 'v2', url: 'https://feishu.cn/docx/doxc1' })
    mocks.setBody.mockResolvedValue('v9')
    const result = await provider.updateDocument(
      { id: 'doxc1', title: '周报', version: 'v2', url: 'https://feishu.cn/docx/doxc1' },
      { body: '新内容' },
    )
    expect(result).toEqual({ ok: true, ref: { id: 'doxc1', title: '周报', version: 'v9', url: 'https://feishu.cn/docx/doxc1' } })
    expect(mocks.setBody).toHaveBeenCalledWith('doxc1', '新内容')
  })

  it('GIVEN 仅 title patch WHEN updateDocument THEN 忽略标题(官方无改标题接口)且不调 setBody', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      updateDocument: (ref: unknown, patch: unknown) => Promise<{ ok: boolean; ref?: unknown }>
    }
    mocks.getMeta.mockResolvedValue({ title: '周报', revision: 'v2', url: 'https://feishu.cn/docx/doxc1' })
    const result = await provider.updateDocument(
      { id: 'doxc1', title: '周报', version: 'v2' },
      { title: '新标题' },
    )
    expect(result).toEqual({ ok: true, ref: { id: 'doxc1', title: '周报', version: 'v2', url: 'https://feishu.cn/docx/doxc1' } })
    expect(mocks.setBody).not.toHaveBeenCalled()
  })

  it('GIVEN createDocument 带 body WHEN 调用 THEN create + setBody + getMeta 并返回完整 ref', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      createDocument: (scope: unknown, doc: { title: string; body: string }) => Promise<unknown>
    }
    mocks.createDocument.mockResolvedValue({ documentId: 'doxc1', revision: '1' })
    mocks.setBody.mockResolvedValue('3')
    mocks.getMeta.mockResolvedValue({ title: '周报', revision: '3', url: 'https://feishu.cn/docx/doxc1' })
    const ref = await provider.createDocument({}, { title: '周报', body: '内容' })
    expect(ref).toEqual({ id: 'doxc1', title: '周报', version: '3', url: 'https://feishu.cn/docx/doxc1' })
    expect(mocks.createDocument).toHaveBeenCalledWith('周报', { folderToken: undefined })
    expect(mocks.setBody).toHaveBeenCalledWith('doxc1', '内容')
  })

  it('GIVEN createDocument 空 body WHEN 调用 THEN 不调 setBody', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      createDocument: (scope: unknown, doc: { title: string; body: string }) => Promise<unknown>
    }
    mocks.createDocument.mockResolvedValue({ documentId: 'doxc1', revision: '1' })
    mocks.getMeta.mockResolvedValue({ title: '周报', revision: '1', url: 'https://feishu.cn/docx/doxc1' })
    await provider.createDocument({}, { title: '周报', body: '' })
    expect(mocks.setBody).not.toHaveBeenCalled()
  })

  it('GIVEN getDocument 正常 WHEN 调用 THEN 返回 raw_content 与最新 ref', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      getDocument: (ref: unknown) => Promise<unknown>
    }
    mocks.getMeta.mockResolvedValue({ title: '周报', revision: 'v4', url: 'https://feishu.cn/docx/doxc1' })
    mocks.getRawContent.mockResolvedValue('正文内容')
    const result = await provider.getDocument({ id: 'doxc1', title: '旧' })
    expect(result).toEqual({
      ref: { id: 'doxc1', title: '周报', version: 'v4', url: 'https://feishu.cn/docx/doxc1' },
      body: '正文内容',
    })
  })

  it('GIVEN 文档不存在(1770002)WHEN getDocument THEN 返回 undefined 且不取正文', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      getDocument: (ref: unknown) => Promise<unknown>
    }
    mocks.getMeta.mockRejectedValue(new FeishuDocsError('1770002', 'not found'))
    await expect(provider.getDocument({ id: 'ghost', title: '' })).resolves.toBeUndefined()
    expect(mocks.getRawContent).not.toHaveBeenCalled()
  })

  it('GIVEN 其它错误 WHEN getDocument THEN 继续上抛', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu' })) as {
      getDocument: (ref: unknown) => Promise<unknown>
    }
    mocks.getMeta.mockRejectedValue(new FeishuDocsError('1771001', 'server internal error'))
    await expect(provider.getDocument({ id: 'doxc1', title: '' })).rejects.toThrow('1771001')
  })

  it('GIVEN searchDocuments WHEN 调用 THEN 透传 folderToken(协议层保守空数组)', async () => {
    const provider = (await applyProvider({ credentialRef: 'feishu', folderToken: 'fldX' })) as {
      searchDocuments: (query: string, scope: unknown) => Promise<unknown>
    }
    mocks.searchDocuments.mockResolvedValue([])
    await expect(provider.searchDocuments('周报', {})).resolves.toEqual([])
    expect(mocks.searchDocuments).toHaveBeenCalledWith('周报', { folderToken: 'fldX' })
  })
})
