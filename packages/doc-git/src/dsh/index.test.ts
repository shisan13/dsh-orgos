/**
 * doc-git dsh 行(绑定层)测试:Given-When-Then
 * vi.mock 协议层(mock 类必须用普通 function 而非箭头函数,`new` 调用才合法);
 * 覆盖注册 id、repoPath 缺失停用、凭据解析失败仅 warn 不 fail,以及真实适配器行为。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const mocks = {
  instances: [] as Array<{ args: unknown[]; instance: Record<string, unknown> }>,
  throwOnNew: false,
}
vi.mock('../index', () => ({
  GitWikiProvider: vi.fn(function (this: unknown, ...args: unknown[]) {
    if (mocks.throwOnNew) throw new Error('mock 构造失败')
    const instance = {
      listDocuments: vi.fn(),
      getDocument: vi.fn(),
      createDocument: vi.fn(),
      updateDocument: vi.fn(),
      searchDocuments: vi.fn(),
    }
    mocks.instances.push({ args, instance })
    return instance
  }),
}))

import { apply } from './index'
import type { FsLike, GitLike } from '../index'

function ctx() {
  const providerRef: { current?: unknown } = {}
  const logger = { info: vi.fn(), warn: vi.fn() }
  const credentials = { resolve: vi.fn() }
  const teamService = {
    registerDocumentProvider: vi.fn((p: unknown) => {
      providerRef.current = p
      return () => {}
    }),
  }
  return { providerRef, logger, credentials, teamService }
}

describe('doc-git dsh 行(绑定层)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.instances = []
    mocks.throwOnNew = false
  })

  it('GIVEN repoPath 配置且凭据解析成功 WHEN apply THEN 注册 id=git-wiki 且 new 收到 fs/git 适配与 sshKeyPath', async () => {
    const { providerRef, logger, credentials, teamService } = ctx()
    credentials.resolve.mockResolvedValue({ value: '/keys/id_rsa' })
    await apply(
      { credentials, teamService, logger } as never,
      { repoPath: '/repo', docsDir: 'docs', credentialRef: 'wiki-ssh' },
    )
    expect(teamService.registerDocumentProvider).toHaveBeenCalledTimes(1)
    const provider = providerRef.current as { id: string; label: string }
    expect(provider.id).toBe('git-wiki')
    expect(provider.label).toBe('Git Wiki 文档库')
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('git-wiki'))
    expect(mocks.instances).toHaveLength(1)
    const { args } = mocks.instances[0]!
    expect(args[0]).toBeTruthy() // fs 适配(node:fs)
    expect(args[1]).toBeTruthy() // git 适配(execFile)
    expect(args[2]).toMatchObject({ repoPath: '/repo', docsDir: 'docs', sshKeyPath: '/keys/id_rsa' })
  })

  it('GIVEN repoPath 缺失 WHEN apply THEN 不注册并告警,不实例化 provider', async () => {
    const { providerRef, logger, credentials, teamService } = ctx()
    await apply({ credentials, teamService, logger } as never, { docsDir: 'docs' } as never)
    expect(teamService.registerDocumentProvider).not.toHaveBeenCalled()
    expect(providerRef.current).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('缺 repoPath'))
    expect(mocks.instances).toHaveLength(0)
  })

  it('GIVEN 未配置 credentialRef WHEN apply THEN 注册且 sshKeyPath 为空(本地模式)', async () => {
    const { providerRef, credentials, teamService, logger } = ctx()
    await apply({ credentials, teamService, logger } as never, { repoPath: '/repo' })
    expect(providerRef.current).toBeTruthy()
    expect(credentials.resolve).not.toHaveBeenCalled()
    expect(mocks.instances[0]!.args[2]).toMatchObject({ sshKeyPath: undefined })
  })

  it('GIVEN credentialRef 解析失败 WHEN apply THEN 仅 warn 不 fail,仍注册本地模式', async () => {
    const { providerRef, logger, credentials, teamService } = ctx()
    credentials.resolve.mockRejectedValue(new Error('密钥库不可用'))
    await expect(
      apply({ credentials, teamService, logger } as never, { repoPath: '/repo', credentialRef: 'wiki-ssh' }),
    ).resolves.toBeUndefined()
    expect(providerRef.current).toBeTruthy()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('凭据解析失败'))
    expect(mocks.instances[0]!.args[2]).toMatchObject({ sshKeyPath: undefined })
  })

  it('GIVEN credentialRef 解析为空 WHEN apply THEN warn 未配置并继续本地模式', async () => {
    const { providerRef, logger, credentials, teamService } = ctx()
    credentials.resolve.mockResolvedValue(undefined)
    await apply({ credentials, teamService, logger } as never, { repoPath: '/repo', credentialRef: 'wiki-ssh' })
    expect(providerRef.current).toBeTruthy()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('未配置,继续本地模式'))
  })

  it('GIVEN 构造 provider 抛错 WHEN apply THEN warn 注册失败且不抛出', async () => {
    const { logger, credentials, teamService } = ctx()
    mocks.throwOnNew = true
    await expect(
      apply({ credentials, teamService, logger } as never, { repoPath: '/repo' }),
    ).resolves.toBeUndefined()
    expect(teamService.registerDocumentProvider).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('注册失败'))
  })

  it('GIVEN 真实适配器(临时目录)WHEN 调用 fs/git 封装 THEN 读写/目录/stat/git 执行正常', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-git-'))
    try {
      const { providerRef, logger, credentials, teamService } = ctx()
      credentials.resolve.mockResolvedValue(undefined)
      await apply({ credentials, teamService, logger } as never, { repoPath: dir })
      const { args } = mocks.instances[0]!
      const fsLike = args[0] as FsLike
      const gitLike = args[1] as GitLike
      await fsLike.writeFile(path.join(dir, 'a.txt'), 'hi')
      expect(await fsLike.readFile(path.join(dir, 'a.txt'))).toBe('hi')
      await fsLike.mkdir(path.join(dir, 'sub'), { recursive: true })
      expect(await fsLike.exists(path.join(dir, 'sub'))).toBe(true)
      expect(await fsLike.exists(path.join(dir, 'nope'))).toBe(false)
      expect((await fsLike.readdir(dir)).sort()).toEqual(['a.txt', 'sub'])
      expect((await fsLike.stat(path.join(dir, 'a.txt'))).mtimeMs).toBeGreaterThan(0)
      const out = await gitLike.run(['--version'], { env: {} })
      expect(out).toContain('git version')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
