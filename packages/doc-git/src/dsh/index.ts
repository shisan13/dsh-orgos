/**
 * dsh-orgos-doc-git 绑定层 —— 文档 provider 注册行(bundle 行:name 'dsh-orgos-doc-git/dsh')
 *
 * 依赖 host 的 teamService(dsh-orgos-core/dsh 提供):把 git wiki 仓库注册为
 * DocumentProvider(Orgos Extension API),id='git-wiki'。
 *
 * 配置(行 config,用户 profile 层覆盖):
 * { repoPath: string; docsDir?: string; label?: string; credentialRef?: string }
 * - repoPath 缺失 → 行停用(warn,不 fail);
 * - credentialRef 可选,约定其解析值为 ssh 私钥文件路径 → GitLike env 携带
 *   GIT_SSH_COMMAND(ssh -i <path> -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes);
 *   解析失败/未配置 → 仅 warn 继续本地模式(无 ssh 推送),不 fail。
 *
 * 本文件的 FsLike/GitLike 适配(node:fs + child_process execFile)按任务要求放在本文件。
 */
export const name = 'dsh-orgos-doc-git'

// 硬依赖:credentials 异步 init → inject 保证就绪;teamService 由 team-core 行提供
export const inject = ['credentials', 'teamService']

import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GitWikiProvider } from '../index.js'
import type { FsLike, GitLike } from '../index.js'
import type { DocumentProvider } from 'dsh-orgos-core/dsh/extensions'

const execFileAsync = promisify(execFile)

interface DocGitConfig {
  repoPath: string
  docsDir?: string
  label?: string
  credentialRef?: string
}

interface Ctx {
  credentials: { resolve(ref: string): Promise<{ value: string } | undefined> }
  teamService: TeamServiceLike
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

interface TeamServiceLike {
  registerDocumentProvider(provider: DocumentProvider): () => void
}

export async function apply(ctx: Ctx, config: DocGitConfig): Promise<void> {
  const repoPath = config?.repoPath?.trim()
  if (!repoPath) {
    ctx.logger.warn('[dsh-orgos-doc-git] 配置缺 repoPath,行停用(git wiki 文档 provider 不启用)')
    return
  }
  // 凭据可选:credentialRef 的值约定为 ssh 私钥文件路径;解析失败/未配置仅降级本地模式
  let sshKeyPath: string | undefined
  if (config.credentialRef) {
    try {
      const resolved = await ctx.credentials.resolve(config.credentialRef)
      if (resolved?.value) {
        sshKeyPath = String(resolved.value)
      } else {
        ctx.logger.warn(`[dsh-orgos-doc-git] 凭据 ${config.credentialRef} 未配置,继续本地模式(无 ssh 推送)`)
      }
    } catch (error) {
      ctx.logger.warn(`[dsh-orgos-doc-git] 凭据解析失败,继续本地模式(无 ssh 推送):${String(error)}`)
    }
  }
  try {
    const wiki = new GitWikiProvider(nodeFsLike(), nodeGitLike(repoPath), {
      repoPath,
      docsDir: config.docsDir,
      sshKeyPath,
    })
    const provider: DocumentProvider = {
      id: 'git-wiki',
      label: config.label ?? 'Git Wiki 文档库',
      listDocuments: (scope, opts) => wiki.listDocuments(scope, opts),
      getDocument: (ref) => wiki.getDocument(ref),
      createDocument: (scope, doc) => wiki.createDocument(scope, doc),
      updateDocument: (ref, patch, opts) => wiki.updateDocument(ref, patch, opts),
      searchDocuments: (query, scope) => wiki.searchDocuments(query, scope),
    }
    ctx.teamService.registerDocumentProvider(provider)
    ctx.logger.info(`[dsh-orgos-doc-git] 文档 provider 已注册(git-wiki → ${repoPath})`)
  } catch (error) {
    ctx.logger.warn(`[dsh-orgos-doc-git] 注册失败:${String(error)}`)
  }
}

/** node:fs → FsLike 适配(路径统一按字符串透传,git wiki 使用绝对路径) */
function nodeFsLike(): FsLike {
  return {
    readFile: (p) => fs.readFile(p, 'utf8'),
    writeFile: (p, content) => fs.writeFile(p, content, 'utf8'),
    // node 类型:recursive 选项下 mkdir 返回 Promise<string|undefined>,包装为 void
    mkdir: async (p, opts) => {
      await fs.mkdir(p, { recursive: opts?.recursive ?? false })
    },
    readdir: (p) => fs.readdir(p, 'utf8'),
    exists: async (p) => {
      try {
        await fs.stat(p)
        return true
      } catch {
        return false
      }
    },
    stat: async (p) => {
      const s = await fs.stat(p)
      return { mtimeMs: s.mtimeMs }
    },
  }
}

/** child_process execFile → GitLike 适配(git 在 repoPath 下执行;env 与 process.env 合并) */
function nodeGitLike(repoPath: string): GitLike {
  return {
    async run(args, opts) {
      const { stdout } = await execFileAsync('git', args, {
        cwd: repoPath,
        env: { ...process.env, ...(opts?.env ?? {}) },
        maxBuffer: 16 * 1024 * 1024,
      })
      return stdout
    },
  }
}
