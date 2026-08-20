import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock 协议层:provider 只关心 client 的返回值
const mocks = {
  listRecords: vi.fn(),
  getRecord: vi.fn(),
  createRecord: vi.fn(),
  updateRecord: vi.fn(),
  searchRecords: vi.fn(),
}
vi.mock('../index', () => ({
  FeishuBitableClient: vi.fn(function () {
    return { titleField: '标题', bodyField: '正文', ...mocks }
  }),
}))

import { apply } from './index'

function ctx() {
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

describe('doc-feishu dsh 行(绑定层)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GIVEN 凭据解析成功 WHEN apply THEN 注册 feishu-bitable provider 并返回文档引用列表', async () => {
    const { providerRef, logger, credentials, teamService } = ctx()
    await apply(
      { credentials, teamService, logger } as never,
      { credentialRef: 'feishu', appToken: 'app-tok', tableId: 'tbl-1' },
    )
    expect(teamService.registerDocumentProvider).toHaveBeenCalledTimes(1)
    const provider = providerRef.current as {
      id: string
      listDocuments: () => Promise<Array<{ id: string; title: string }>>
    }
    expect(provider.id).toBe('feishu-bitable')
    mocks.listRecords.mockResolvedValue([{ recordId: 'rec-1', fields: { 标题: '周报', 正文: 'x' } }])
    await expect(provider.listDocuments()).resolves.toEqual([{ id: 'rec-1', title: '周报' }])
    expect(logger.info).toHaveBeenCalled()
  })

  it('GIVEN expectedVersion 与 ref.version 不一致 WHEN updateDocument THEN 返回 STALE_DOCUMENT 且不写库', async () => {
    const { providerRef } = ctx()
    await apply({ credentials: { resolve: async () => ({ value: 'a:b' }) }, teamService: { registerDocumentProvider: (p: unknown) => { providerRef.current = p; return () => {} } }, logger: { info: vi.fn(), warn: vi.fn() } } as never, {
      credentialRef: 'feishu', appToken: 'app-tok', tableId: 'tbl-1',
    })
    const provider = providerRef.current as {
      updateDocument: (ref: unknown, patch: unknown, opts?: unknown) => Promise<{
        ok: boolean
        code?: string
        currentVersion?: string
        ref?: unknown
      }>
    }
    const result = await provider.updateDocument(
      { id: 'rec-1', title: '周报', version: 'v1' },
      { title: '新周报' },
      { expectedVersion: 'v2' },
    )
    expect(result).toEqual({ ok: false, code: 'STALE_DOCUMENT', currentVersion: 'v1' })
    expect(mocks.updateRecord).not.toHaveBeenCalled()
  })

  it('GIVEN patch 含标题与正文 WHEN updateDocument 成功 THEN 返回 ok 与最新引用', async () => {
    const { providerRef } = ctx()
    await apply({ credentials: { resolve: async () => ({ value: 'a:b' }) }, teamService: { registerDocumentProvider: (p: unknown) => { providerRef.current = p; return () => {} } }, logger: { info: vi.fn(), warn: vi.fn() } } as never, {
      credentialRef: 'feishu', appToken: 'app-tok', tableId: 'tbl-1',
    })
    mocks.updateRecord.mockResolvedValue({ recordId: 'rec-1', fields: { 标题: '新周报', 正文: '内容' } })
    const provider = providerRef.current as {
      updateDocument: (ref: unknown, patch: unknown, opts?: unknown) => Promise<{ ok: boolean; ref?: unknown }>
    }
    const result = await provider.updateDocument({ id: 'rec-1', title: '周报' }, { title: '新周报', body: '内容' })
    expect(result).toEqual({ ok: true, ref: { id: 'rec-1', title: '新周报' } })
    expect(mocks.updateRecord).toHaveBeenCalledWith('rec-1', { 标题: '新周报', 正文: '内容' })
  })

  it('GIVEN 配置缺失 credentialRef WHEN apply THEN 不注册并告警', async () => {
    const { providerRef, logger, credentials, teamService } = ctx()
    await apply({ credentials, teamService, logger } as never, { appToken: 'a', tableId: 'b' } as never)
    expect(teamService.registerDocumentProvider).not.toHaveBeenCalled()
    expect(providerRef.current).toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
  })
})
