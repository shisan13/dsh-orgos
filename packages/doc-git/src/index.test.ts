/**
 * GitWikiProvider 协议层测试:Given-When-Then(AGENTS.md §4 闸门)
 * 内存 Fs(mock 目录树)+ 假 Git(记录命令序列、可编程 HEAD/pull/push 失败)。
 */
import { describe, expect, it } from 'vitest'
import { GitWikiProvider } from './index.js'
import type { GitLike } from './index.js'

/** 内存文件系统:扁平 map 模拟目录树,可编程 mtime */
class MemFs {
  private files = new Map<string, string>()
  private mtimes = new Map<string, number>()
  private now = 1000

  constructor(seed: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(seed)) {
      this.files.set(p, c)
      this.mtimes.set(p, ++this.now)
    }
  }

  async readFile(p: string): Promise<string> {
    const v = this.files.get(p)
    if (v === undefined) throw new Error(`ENOENT: ${p}`)
    return v
  }

  async writeFile(p: string, content: string): Promise<void> {
    this.files.set(p, content)
    this.mtimes.set(p, ++this.now)
  }

  async mkdir(_p: string): Promise<void> {
    // 内存树无需真实目录,no-op
  }

  async readdir(p: string): Promise<string[]> {
    const dir = p.endsWith('/') ? p : `${p}/`
    const names = new Set<string>()
    for (const k of this.files.keys()) {
      if (!k.startsWith(dir)) continue
      const top = k.slice(dir.length).split('/')[0]
      if (top !== undefined && top !== '') names.add(top)
    }
    return [...names].sort()
  }

  async exists(p: string): Promise<boolean> {
    // 文件命中或目录命中(任何键以 'path/' 开头)
    if (this.files.has(p)) return true
    return [...this.files.keys()].some((k) => k.startsWith(`${p}/`))
  }

  async stat(p: string): Promise<{ mtimeMs: number }> {
    const m = this.mtimes.get(p)
    if (m === undefined) throw new Error(`ENOENT: ${p}`)
    return { mtimeMs: m }
  }

  content(p: string): string | undefined {
    return this.files.get(p)
  }

  remove(p: string): void {
    this.files.delete(p)
    this.mtimes.delete(p)
  }
}

/** 假 git:记录命令序列(含 env),commit 递增 HEAD,可编程 pull/push 失败 */
class FakeGit implements GitLike {
  calls: Array<{ args: string[]; env?: Record<string, string> }> = []
  headValue = 'h1'
  hasRemote = true
  private counter = 0
  failPull = false
  failPush = false
  private readonly repoPath = '/repo'

  constructor(private readonly mem: MemFs) {}

  async run(args: string[], opts?: { env?: Record<string, string> }): Promise<string> {
    this.calls.push({ args, env: opts?.env })
    if (this.failPull && args[0] === 'pull') throw new Error('fatal: 无法拉取远端 refs — stderr 演示')
    if (this.failPush && args[0] === 'push') throw new Error('! [rejected] main -> main (fetch first) — stderr 演示')
    if (args[0] === 'rev-parse') return `${this.headValue}\n`
    if (args[0] === 'remote') return this.hasRemote ? 'origin\n' : ''
    // commit 带 -c user.name/-c user.email 前缀,用 includes 识别
    if (args.includes('commit')) {
      this.headValue = `h${++this.counter + 1}`
      return this.headValue
    }
    if (args[0] === 'rm') {
      // 模拟 git rm:删除工作树文件并暂存
      const target = args[args.indexOf('--') + 1]
      if (target !== undefined) this.mem.remove(`${this.repoPath}/${target}`)
      return ''
    }
    return ''
  }

  allArgs(): string[][] {
    return this.calls.map((c) => c.args)
  }
}

function setup(seed: Record<string, string> = {}) {
  const mem = new MemFs(seed)
  const git = new FakeGit(mem)
  const provider = new GitWikiProvider(mem, git, { repoPath: '/repo' })
  return { mem, git, provider }
}

describe('GitWikiProvider(协议层)', () => {
  it('GIVEN docs 目录含 md/非 md/一层子目录 WHEN listDocuments THEN 只返回 md 且 id 为相对路径、version 为当前 HEAD', async () => {
    const { provider } = setup({
      '/repo/docs/a.md': 'A',
      '/repo/docs/readme.txt': 'txt',
      '/repo/docs/LICENSE': 'license',
      '/repo/docs/sub/c.md': 'C',
      '/repo/docs/sub/deep/d.md': 'D',
    })
    const refs = await provider.listDocuments({})
    expect(refs.map((r) => r.id)).toEqual(['a.md', 'sub/c.md'])
    expect(refs.map((r) => r.title)).toEqual(['a', 'c'])
    expect(refs.every((r) => r.version === 'h1')).toBe(true)
    expect(refs.every((r) => /^\d{4}-\d{2}-\d{2}T/.test(r.updatedAt ?? ''))).toBe(true)
  })

  it('GIVEN limit WHEN listDocuments THEN 截断返回', async () => {
    const { provider } = setup({ '/repo/docs/a.md': 'A', '/repo/docs/b.md': 'B' })
    expect(await provider.listDocuments({}, { limit: 1 })).toHaveLength(1)
  })

  it('GIVEN 文档存在 WHEN getDocument THEN 返回带当前 HEAD 的 ref 与正文', async () => {
    const { provider } = setup({ '/repo/docs/a.md': '内容A' })
    const doc = await provider.getDocument({ id: 'a.md', title: 'a' })
    expect(doc?.body).toBe('内容A')
    expect(doc?.ref).toMatchObject({ id: 'a.md', title: 'a', version: 'h1' })
  })

  it('GIVEN 文档不存在 WHEN getDocument THEN 返回 undefined', async () => {
    const { provider } = setup({ '/repo/docs/a.md': 'A' })
    expect(await provider.getDocument({ id: 'ghost.md', title: 'ghost' })).toBeUndefined()
  })

  it('GIVEN ref.id 含路径穿越 WHEN getDocument THEN 抛非法路径错误', async () => {
    const { provider } = setup({ '/repo/docs/a.md': 'A' })
    await expect(provider.getDocument({ id: '../secret.md', title: 'x' })).rejects.toThrow('非法文档路径')
  })

  it('GIVEN 新标题 WHEN createDocument THEN add→commit(-c 作者)→push→rev-parse 且返回新 HEAD 版本', async () => {
    const { mem, git, provider } = setup()
    const ref = await provider.createDocument({}, { title: 'My New Doc', body: 'hello' })
    expect(mem.content('/repo/docs/my-new-doc.md')).toBe('hello')
    expect(ref).toMatchObject({ id: 'my-new-doc.md', title: 'my-new-doc', version: 'h2' })
    const args = git.allArgs()
    expect(args[0]).toEqual(['add', '--', 'docs/my-new-doc.md'])
    expect(args[1]?.[0]).toBe('-c')
    expect(args[1]).toContain('user.name=dsh-orgos')
    expect(args[1]).toContain('user.email=orgos@local')
    expect(args[1]?.[4]).toBe('commit')
    expect(args[1]?.[6]).toBe('docs: 创建文档 My New Doc')
    expect(args[2]).toEqual(['remote'])
    expect(args[3]).toEqual(['push', 'origin', 'main'])
    expect(args[4]).toEqual(['rev-parse', 'HEAD'])
  })

  it('GIVEN 标题含路径分隔符与点段 WHEN createDocument THEN slug 化防穿越,文件落在 docs 内', async () => {
    const { mem, provider } = setup()
    const ref = await provider.createDocument({}, { title: '../evil/name', body: 'x' })
    expect(ref.id).toBe('evil-name.md')
    expect(ref.id).not.toContain('/')
    expect(ref.id).not.toContain('..')
    expect(mem.content('/repo/docs/evil-name.md')).toBe('x')
    expect(mem.content('/repo/../evil/name.md')).toBeUndefined()
  })

  it('GIVEN 标题全为非法字符 WHEN createDocument THEN 兜底为 untitled', async () => {
    const { provider } = setup()
    const ref = await provider.createDocument({}, { title: '!!!', body: 'x' })
    expect(ref.id).toBe('untitled.md')
  })

  it('GIVEN 同名文件已存在 WHEN createDocument THEN 明确报错已存在', async () => {
    const { provider } = setup({ '/repo/docs/hello-world.md': 'old' })
    await expect(provider.createDocument({}, { title: 'Hello World', body: 'new' })).rejects.toThrow('文档已存在:hello-world.md')
  })

  it('GIVEN 配置 sshKeyPath WHEN createDocument THEN git 命令携带 GIT_SSH_COMMAND(私钥路径)env', async () => {
    const mem = new MemFs()
    const git = new FakeGit(mem)
    const provider = new GitWikiProvider(mem, git, { repoPath: '/repo', sshKeyPath: '/keys/id_rsa' })
    await provider.createDocument({}, { title: 'ssh doc', body: 'x' })
    const push = git.calls.find((c) => c.args[0] === 'push')
    expect(push?.env?.GIT_SSH_COMMAND).toBe('ssh -i "/keys/id_rsa" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes')
  })

  it('GIVEN 仅 body 变更 WHEN updateDocument THEN 原文件覆盖并 add→commit→push,不触发重命名', async () => {
    const { mem, git, provider } = setup({ '/repo/docs/a.md': 'old' })
    const result = await provider.updateDocument({ id: 'a.md', title: 'a', version: 'h1' }, { body: 'new' })
    expect(result).toMatchObject({ ok: true, ref: { id: 'a.md', title: 'a', version: 'h2' } })
    expect(mem.content('/repo/docs/a.md')).toBe('new')
    const args = git.allArgs()
    expect(args).toContainEqual(['pull', '--rebase', 'origin', 'main'])
    expect(args).toContainEqual(['add', '--', 'docs/a.md'])
    expect(args.some((a) => a[0] === 'rm')).toBe(false)
    expect(args.some((a) => a[0] === 'add' && a[1] === '-A')).toBe(false)
    expect(args).toContainEqual(['push', 'origin', 'main'])
  })

  it('GIVEN title 变更 WHEN updateDocument THEN 写新文件 + git rm 旧文件 + add -A,返回新 id', async () => {
    const { mem, git, provider } = setup({ '/repo/docs/a.md': 'old body' })
    const result = await provider.updateDocument({ id: 'a.md', title: 'a', version: 'h1' }, { title: 'New Title' })
    expect(result).toMatchObject({ ok: true, ref: { id: 'new-title.md', title: 'new-title', version: 'h2' } })
    expect(mem.content('/repo/docs/new-title.md')).toBe('old body')
    expect(mem.content('/repo/docs/a.md')).toBeUndefined()
    const args = git.allArgs()
    expect(args).toContainEqual(['rm', '--', 'docs/a.md'])
    expect(args).toContainEqual(['add', '-A'])
  })

  it('GIVEN 期望版本 ≠ 当前 HEAD WHEN updateDocument THEN 返回 STALE_DOCUMENT 且不写文件不提交', async () => {
    const { mem, git, provider } = setup({ '/repo/docs/a.md': 'old' })
    const result = await provider.updateDocument({ id: 'a.md', title: 'a', version: 'h0' }, { body: 'new' })
    expect(result).toEqual({ ok: false, code: 'STALE_DOCUMENT', currentVersion: 'h1' })
    expect(mem.content('/repo/docs/a.md')).toBe('old')
    expect(git.allArgs().filter((a) => ['add', 'commit', 'push'].includes(a[0] ?? ''))).toEqual([])
  })

  it('GIVEN expectedVersion 显式传入 WHEN updateDocument THEN 以 expectedVersion 优先于 ref.version 判定', async () => {
    const { provider } = setup({ '/repo/docs/a.md': 'x' })
    // ref.version 与 HEAD 一致,但期望版本过期 → STALE
    const stale = await provider.updateDocument({ id: 'a.md', title: 'a', version: 'h1' }, { body: 'x' }, { expectedVersion: 'h0' })
    expect(stale).toMatchObject({ ok: false, code: 'STALE_DOCUMENT' })
    // ref.version 过期,但期望版本 = HEAD → 成功
    const ok = await provider.updateDocument({ id: 'a.md', title: 'a', version: 'h0' }, { body: 'y' }, { expectedVersion: 'h1' })
    expect(ok).toMatchObject({ ok: true, ref: { version: 'h2' } })
  })

  it('GIVEN 无任何变更 WHEN updateDocument THEN 返回当前状态且不产生空提交', async () => {
    const { git, provider } = setup({ '/repo/docs/a.md': 'x' })
    const result = await provider.updateDocument({ id: 'a.md', title: 'a', version: 'h1' }, {})
    expect(result).toMatchObject({ ok: true, ref: { version: 'h1' } })
    expect(git.allArgs().some((a) => a[0] === 'commit')).toBe(false)
  })

  it('GIVEN pull --rebase 失败 WHEN updateDocument THEN 抛错且错误带 git stderr 摘要', async () => {
    const { git, provider } = setup({ '/repo/docs/a.md': 'x' })
    git.failPull = true
    await expect(provider.updateDocument({ id: 'a.md', title: 'a' }, { body: 'y' })).rejects.toThrow(/pull.*无法拉取|无法拉取.*pull/)
  })

  it('GIVEN push 被拒 WHEN updateDocument THEN 抛错不吞', async () => {
    const { git, provider } = setup({ '/repo/docs/a.md': 'x' })
    git.failPush = true
    await expect(provider.updateDocument({ id: 'a.md', title: 'a' }, { body: 'y' })).rejects.toThrow(/push.*rejected|rejected.*push/)
  })

  it('GIVEN 仓库无 remote(本地模式)WHEN create/update THEN 跳过 pull/push 且 commit 正常', async () => {
    const { git, provider } = setup({ '/repo/docs/a.md': 'old' })
    git.hasRemote = false
    const created = await provider.createDocument({}, { title: '本地文档', body: 'x' })
    expect(created.id).toBe('本地文档.md')
    // create 已推进 HEAD:更新需携带最新 ref.version(与真实调用方行为一致)
    const fresh = await provider.getDocument({ id: 'a.md', title: 'a' })
    const updated = await provider.updateDocument(fresh?.ref ?? { id: 'a.md', title: 'a' }, { body: 'y' })
    expect(updated).toMatchObject({ ok: true })
    const all = git.allArgs()
    expect(all.some((a) => a[0] === 'pull' || a[0] === 'push')).toBe(false)
    expect(all.some((a) => a.includes('commit'))).toBe(true)
  })

  it('GIVEN 查询命中文件名 WHEN searchDocuments THEN 返回对应文档', async () => {
    const { provider } = setup({ '/repo/docs/roadmap.md': '2025 规划', '/repo/docs/note.md': '其他' })
    const hits = await provider.searchDocuments('road')
    expect(hits.map((r) => r.id)).toEqual(['roadmap.md'])
  })

  it('GIVEN 查询命中文件内容 WHEN searchDocuments THEN 返回对应文档', async () => {
    const { provider } = setup({ '/repo/docs/roadmap.md': '2025 规划', '/repo/docs/note.md': '里程碑 计划' })
    const hits = await provider.searchDocuments('里程碑')
    expect(hits.map((r) => r.id)).toEqual(['note.md'])
  })

  it('GIVEN 空查询 WHEN searchDocuments THEN 返回空列表', async () => {
    const { provider } = setup({ '/repo/docs/a.md': 'x' })
    expect(await provider.searchDocuments('  ')).toEqual([])
  })
})
