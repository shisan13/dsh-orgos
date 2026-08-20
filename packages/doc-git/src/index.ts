/**
 * dsh-orgos-doc-git 协议层 —— Git Wiki 文档 provider(harness-agnostic)
 *
 * 以「一个 git 仓库的 docs/ 目录」作为团队知识库:每个 .md 文件是一篇文档,
 * git commit hash 即文档版本(变更审计 + CAS 冲突检测)。
 *
 * 分层纪律:本文件零 DSH import、零 node:fs/child_process 依赖;文件系统与 git
 * 均通过注入的 FsLike/GitLike 访问(测试可 mock,绑定层用 node:fs + execFile 适配)。
 *
 * 设计要点(自选并注释):
 * - 目录深度:listDocuments 只遍历一层子目录(足够覆盖「主题分组」场景,
 *   深层目录演进为递归或由 git ls-files 驱动,避免 O(目录树) 放大);
 * - 版本语义:version = commit 短语义(完整 HEAD 值),提交后重新 rev-parse 取新 HEAD;
 * - CAS 时机:updateDocument 先 pull --rebase 再以「当前 HEAD」判定期望版本
 *   (期望版本为空 → best-effort 直接覆盖:分布式无锁场景无法原子 CAS,注释说明);
 * - 重命名策略:title 变更 = 写新文件 + git rm 旧文件(删除并暂存)+ git add -A,
 *   由 git 在提交中识别 rename(无需 FsLike 提供 unlink 能力);
 * - 搜索:文件名 contains + 内容 contains 的顺序遍历,O(n);大规模演进为 git grep。
 *
 * 安全:一切外部相对路径(ref.id)经 assertSafeRel 防 ../ 穿越;slug 化保证
 * 生成文件名不含路径分隔符;代码与日志零敏感信息(ssh 私钥仅以路径形式存在 env)。
 */
export interface FsLike {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<{ mtimeMs: number }>
}

/** git 命令执行器(在 repoPath 下执行;opts.env 与默认 env 合并) */
export interface GitLike {
  run(args: string[], opts?: { env?: Record<string, string> }): Promise<string>
}

export interface GitWikiConfig {
  /** git 仓库绝对路径(绑定层保证非空;协议层防御性 strip 尾部 '/' ) */
  repoPath: string
  /** 文档目录相对 repoPath(默认 'docs') */
  docsDir?: string
  /** 提交作者(默认 'dsh-orgos' / 'orgos@local') */
  authorName?: string
  authorEmail?: string
  /** 推送/拉取的目标远端分支(默认 'main') */
  remoteBranch?: string
  /** ssh 私钥文件路径(可选):设置后 git 命令携带 GIT_SSH_COMMAND 走指定 key */
  sshKeyPath?: string
}

/** 与 dsh-orgos-core DocumentRef 同构的最小形状(协议层不依赖 core) */
export interface GitDocRef {
  id: string
  title: string
  updatedAt?: string
  version?: string
}

export interface GitDocContent {
  ref: GitDocRef
  body: string
}

export type GitDocUpdateResult =
  | { ok: true; ref: GitDocRef }
  | { ok: false; code: 'STALE_DOCUMENT'; currentVersion?: string }

export class GitWikiProvider {
  readonly repoPath: string
  readonly docsDir: string
  private readonly authorName: string
  private readonly authorEmail: string
  private readonly remoteBranch: string
  private readonly sshKeyPath: string | undefined

  constructor(
    private readonly fs: FsLike,
    private readonly git: GitLike,
    config: GitWikiConfig,
  ) {
    this.repoPath = config.repoPath.trim().replace(/\/+$/, '')
    const rawDocsDir = (config.docsDir ?? 'docs').trim().replace(/^\/+|\/+$/g, '')
    this.docsDir = rawDocsDir === '' ? 'docs' : rawDocsDir
    this.authorName = config.authorName ?? 'dsh-orgos'
    this.authorEmail = config.authorEmail ?? 'orgos@local'
    this.remoteBranch = config.remoteBranch ?? 'main'
    this.sshKeyPath = config.sshKeyPath
  }

  /** 列文档:docsDir 下 .md + 一层子目录;DocumentRef.version = 当前 HEAD */
  async listDocuments(_scope?: { teamId?: string }, opts?: { limit?: number }): Promise<GitDocRef[]> {
    const head = await this.head()
    const refs = await this.listAll(head)
    return opts?.limit === undefined ? refs : refs.slice(0, opts.limit)
  }

  /** 取文档:返回带当前 HEAD 的 ref;文件不存在 → undefined */
  async getDocument(ref: GitDocRef): Promise<GitDocContent | undefined> {
    const rel = this.assertSafeRel(ref.id)
    const abs = joinPath(this.docsDirAbs(), rel)
    if (!(await this.fs.exists(abs))) return undefined
    const [body, st, head] = await Promise.all([this.fs.readFile(abs), this.fs.stat(abs), this.head()])
    return { ref: this.toRef(rel, st.mtimeMs, head), body }
  }

  /** 创建文档:标题 slug 化生成文件名 → 写盘 → add → commit → push → 返回新 ref */
  async createDocument(_scope: { teamId?: string }, doc: { title: string; body: string }): Promise<GitDocRef> {
    const rel = this.assertSafeRel(`${this.slugify(doc.title)}.md`)
    const abs = joinPath(this.docsDirAbs(), rel)
    if (await this.fs.exists(abs)) {
      throw new Error(`文档已存在:${rel}(同名文件已存在,请改用 updateDocument 或更换标题)`)
    }
    await this.fs.mkdir(dirname(abs), { recursive: true })
    await this.fs.writeFile(abs, doc.body)
    await this.gitRun(['add', '--', `${this.docsDir}/${rel}`])
    await this.gitRun([...this.commitArgs(), 'commit', '-m', `docs: 创建文档 ${doc.title}`])
    await this.maybePush()
    const head = await this.head()
    const st = await this.fs.stat(abs)
    return this.toRef(rel, st.mtimeMs, head)
  }

  /**
   * 更新文档:pull --rebase → CAS 判定 → 写盘 → add → commit → push。
   * title 变更 → 重命名(新文件 + git rm 旧文件);仅 body → 原文件覆盖。
   * 本地模式(仓库无 remote)→ 跳过 pull/push,commit 即完成。
   */
  async updateDocument(
    ref: GitDocRef,
    patch: { title?: string; body?: string },
    opts?: { expectedVersion?: string },
  ): Promise<GitDocUpdateResult> {
    // 1) 先同步远端(无 remote → 本地模式跳过),pull --rebase 失败即抛(避免基于过期本地提交修改)
    await this.maybePull()
    const currentHead = await this.head()
    // 2) CAS 判定:期望版本 = opts.expectedVersion ?? ref.version;
    //    期望版本为空 → best-effort 直接覆盖(分布式无锁场景无法原子 CAS)
    const expected = opts?.expectedVersion ?? ref.version
    if (expected !== undefined && expected !== '' && expected !== currentHead) {
      return { ok: false, code: 'STALE_DOCUMENT', currentVersion: currentHead }
    }
    // 3) 路径解析与存在性校验
    const oldRel = this.assertSafeRel(ref.id)
    const newRel = patch.title === undefined ? oldRel : this.assertSafeRel(`${this.slugify(patch.title)}.md`)
    const renamed = newRel !== oldRel
    const oldAbs = joinPath(this.docsDirAbs(), oldRel)
    const newAbs = joinPath(this.docsDirAbs(), newRel)
    if (!(await this.fs.exists(oldAbs))) {
      throw new Error(`文档不存在:${oldRel}(请先用 createDocument 创建)`)
    }
    if (renamed && (await this.fs.exists(newAbs))) {
      throw new Error(`目标文档已存在:${newRel}(重命名冲突)`)
    }
    // 4) 无实际变更(title/body 均未提供)→ 不产生空提交,返回当前状态
    if (!renamed && patch.body === undefined) {
      const st = await this.fs.stat(oldAbs)
      return { ok: true, ref: this.toRef(oldRel, st.mtimeMs, currentHead) }
    }
    // 5) 落盘:仅 body → 原文件覆盖;title 变更 → 新文件 + git rm 旧文件(删除并暂存)
    const body = patch.body ?? (await this.fs.readFile(oldAbs))
    if (renamed) {
      await this.fs.mkdir(dirname(newAbs), { recursive: true })
      await this.fs.writeFile(newAbs, body)
      await this.gitRun(['rm', '--', `${this.docsDir}/${oldRel}`])
      await this.gitRun(['add', '-A'])
    } else {
      await this.fs.writeFile(oldAbs, body)
      await this.gitRun(['add', '--', `${this.docsDir}/${oldRel}`])
    }
    // 6) commit + push(无 remote → 本地模式跳过;推送失败/被拒抛错,不吞)
    await this.gitRun([...this.commitArgs(), 'commit', '-m', `docs: 更新文档 ${patch.title ?? ref.title}`])
    await this.maybePush()
    // 7) 返回新 ref(新 HEAD)
    const newHead = await this.head()
    const finalAbs = renamed ? newAbs : oldAbs
    const st = await this.fs.stat(finalAbs)
    return { ok: true, ref: this.toRef(renamed ? newRel : oldRel, st.mtimeMs, newHead) }
  }

  /**
   * 搜索:文件名 contains + 文件内容 contains(遍历 md 读取)。
   * 实现为 O(n) 顺序扫描;大规模知识库演进为 git grep -l(提交内搜索)。
   */
  async searchDocuments(query: string, _scope?: { teamId?: string }): Promise<GitDocRef[]> {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const head = await this.head()
    const refs = await this.listAll(head)
    const hits: GitDocRef[] = []
    for (const ref of refs) {
      if (ref.title.toLowerCase().includes(q) || ref.id.toLowerCase().includes(q)) {
        hits.push(ref)
        continue
      }
      const body = await this.fs.readFile(joinPath(this.docsDirAbs(), ref.id))
      if (body.toLowerCase().includes(q)) hits.push(ref)
    }
    return hits
  }

  // ---------- 私有辅助 ----------

  /** 遍历 docsDir:顶层 .md + 一层子目录(自选深度,注释见文件头) */
  private async listAll(head: string): Promise<GitDocRef[]> {
    const base = this.docsDirAbs()
    if (!(await this.fs.exists(base))) return []
    const refs: GitDocRef[] = []
    for (const entry of await this.fs.readdir(base)) {
      const entryAbs = joinPath(base, entry)
      if (entry.endsWith('.md')) {
        const st = await this.fs.stat(entryAbs)
        refs.push(this.toRef(entry, st.mtimeMs, head))
      } else if (!entry.includes('.')) {
        // 无扩展名视为目录候选;非目录 readdir 失败则跳过
        try {
          for (const sub of await this.fs.readdir(entryAbs)) {
            if (!sub.endsWith('.md')) continue
            const subAbs = joinPath(entryAbs, sub)
            const st = await this.fs.stat(subAbs)
            refs.push(this.toRef(`${entry}/${sub}`, st.mtimeMs, head))
          }
        } catch {
          // 非目录,忽略
        }
      }
    }
    return refs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  private toRef(rel: string, mtimeMs: number, version: string): GitDocRef {
    const base = rel.endsWith('.md') ? rel.slice(0, -3) : rel
    return {
      id: rel,
      title: base.slice(base.lastIndexOf('/') + 1),
      version,
      updatedAt: new Date(mtimeMs).toISOString(),
    }
  }

  /** 当前 HEAD(git rev-parse HEAD) */
  private async head(): Promise<string> {
    return (await this.gitRun(['rev-parse', 'HEAD'])).trim()
  }

  /** 仓库是否配置远端:无 remote → 本地模式(跳过 pull/push,commit 即完成) */
  private async hasRemote(): Promise<boolean> {
    return (await this.gitRun(['remote'])).trim().length > 0
  }

  /** 有远端才 pull --rebase;本地模式跳过 */
  private async maybePull(): Promise<void> {
    if (!(await this.hasRemote())) return
    await this.gitRun(['pull', '--rebase', 'origin', this.remoteBranch])
  }

  /** 有远端才 push;本地模式跳过 */
  private async maybePush(): Promise<void> {
    if (!(await this.hasRemote())) return
    await this.gitRun(['push', 'origin', this.remoteBranch])
  }

  /** git 调用统一封装:失败时错误信息带 stderr 摘要,不吞 */
  private async gitRun(args: string[]): Promise<string> {
    try {
      return await this.git.run(args, this.gitEnv())
    } catch (error) {
      throw new Error(`git ${args.join(' ')} 失败: ${this.gitErrorSummary(error)}`)
    }
  }

  /** ssh 私钥配置 → GIT_SSH_COMMAND(仅路径参与,不含密钥内容) */
  private gitEnv(): { env?: Record<string, string> } {
    if (this.sshKeyPath === undefined) return {}
    const key = this.sshKeyPath.replace(/"/g, '\\"')
    return { env: { GIT_SSH_COMMAND: `ssh -i "${key}" -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes` } }
  }

  private commitArgs(): string[] {
    return ['-c', `user.name=${this.authorName}`, '-c', `user.email=${this.authorEmail}`]
  }

  /** 错误摘要:优先 stderr(execFile 失败时挂载),其次 message;单行截断防日志爆炸 */
  private gitErrorSummary(error: unknown): string {
    const e = error as { stderr?: string; message?: string }
    const raw = e.stderr ?? e.message ?? String(error)
    const oneLine = raw.replace(/\s+/g, ' ').trim()
    return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine
  }

  /** 标题 slug 化:小写、非法字符折叠为 '-',双保险剔除路径分隔符与点段(防穿越) */
  private slugify(title: string): string {
    let s = title.trim().toLowerCase()
    // 保留字母数字(含中文),其余连续非法字符折叠为一个 '-'
    s = s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
    // 双保险:显式剔除路径分隔符与 '..'(前一步已处理,防御性保留)
    s = s.replace(/[\\/]+/g, '-').replace(/\.\./g, '-')
    return s === '' ? 'untitled' : s
  }

  /** 相对 docsDir 的路径安全校验:禁止绝对路径/反斜杠/驱动器/点段(防 ../ 穿越) */
  private assertSafeRel(rel: string): string {
    if (rel.startsWith('/') || rel.includes('\\') || rel.includes(':') || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`非法文档路径:${rel}(禁止路径穿越)`)
    }
    return rel
  }

  private docsDirAbs(): string {
    return joinPath(this.repoPath, this.docsDir)
  }
}

/** 轻量路径 join(协议层不依赖 node:path,统一 '/' 分隔) */
function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== '').join('/')
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
