/**
 * dsh-orgos-doc-feishu-docs 绑定层 —— 文档 provider 注册行(bundle 行:name 'dsh-orgos-doc-feishu-docs/dsh')
 *
 * 依赖 host 的 teamService(dsh-orgos-core/dsh 提供):把飞书云文档(docx)注册为
 * DocumentProvider(Orgos Extension API)。凭据走 ctx.credentials(appId:appSecret,
 * 与 im-feishu 同格式,可复用同一凭据键)。
 *
 * 配置(行 config,用户 profile 层覆盖):
 * { credentialRef, label?, folderToken? }
 * 应用需在飞书开放平台开通「云文档 docx」权限(docx:document 等)。
 *
 * 版本/CAS 语义:DocumentRef.version = 飞书 revision_id(经 getMeta 取当前值);
 * updateDocument 期望版本 = opts.expectedVersion ?? ref.version,与服务器当前 revision
 * 不符 → STALE_DOCUMENT 且不写(与 TaskBoard CAS 同语义,防多人覆盖)。
 *
 * 已知限制(官方核实,见协议层头注释):
 * - 官方无稳定的「更新文档标题」接口 → patch.title 被忽略(保守,不报错);
 * - 服务端搜索未核实到稳定端点 → searchDocuments 保守返回空数组;
 * - listDocuments 需 folderToken(未配置时返回空数组)。
 */
export const name = 'dsh-orgos-doc-feishu-docs'

// 硬依赖:credentials 异步 init → inject 保证就绪;teamService 由 team-core 行提供
export const inject = ['credentials', 'teamService']

import { FeishuDocsClient, FeishuDocsError } from '../index.js'
import type { DocumentProvider, DocumentRef } from 'dsh-orgos-core/dsh/extensions'

interface DocFeishuDocsConfig {
  credentialRef: string
  /** 展示名(默认「飞书云文档」) */
  label?: string
  /** 云空间文件夹 token;配置后 listDocuments/searchDocuments 按该文件夹检索 */
  folderToken?: string
}

interface Ctx {
  credentials: { resolve(ref: string): Promise<{ value: string } | undefined> }
  teamService: TeamServiceLike
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

interface TeamServiceLike {
  registerDocumentProvider(provider: DocumentProvider): () => void
}

/** 飞书业务错误码:文档不存在(404)→ getDocument 返回 undefined */
const CODE_DOC_NOT_FOUND = '1770002'

export async function apply(ctx: Ctx, config: DocFeishuDocsConfig): Promise<void> {
  const { credentialRef, folderToken } = config ?? {}
  if (!credentialRef) {
    ctx.logger.warn('[dsh-orgos-doc-feishu-docs] 配置缺 credentialRef,行停用(团队云文档不启用)')
    return
  }
  try {
    const resolved = await ctx.credentials.resolve(credentialRef)
    if (!resolved) {
      ctx.logger.warn(`[dsh-orgos-doc-feishu-docs] 凭据 ${credentialRef} 未配置,行停用`)
      return
    }
    const [appId, appSecret] = String(resolved.value).split(':')
    if (!appId || !appSecret) throw new Error('飞书凭据格式应为 appId:appSecret')
    const client = new FeishuDocsClient({ appId, appSecret })
    const provider: DocumentProvider = {
      id: 'feishu-docs',
      label: config.label ?? '飞书云文档',
      async listDocuments(_scope, opts) {
        // folderToken 透传:provider 的 scope 处理 = 按配置的文件夹检索
        return client.listDocuments(folderToken, opts)
      },
      async getDocument(ref) {
        try {
          const meta = await client.getMeta(ref.id)
          const body = await client.getRawContent(ref.id)
          return { ref: toRef(ref.id, meta.title, meta.revision, meta.url), body }
        } catch (error) {
          // 文档不存在(已删除/无权)→ 与 Bitable 同语义返回 undefined
          if (error instanceof FeishuDocsError && error.code === CODE_DOC_NOT_FOUND) return undefined
          throw error
        }
      },
      async createDocument(_scope, doc) {
        const created = await client.createDocument(doc.title)
        if (doc.body) await client.setBody(created.documentId, doc.body)
        const meta = await client.getMeta(created.documentId)
        return toRef(created.documentId, meta.title, meta.revision, meta.url)
      },
      async updateDocument(ref, patch, opts) {
        // CAS:期望版本与服务器当前 revision 不符 → STALE_DOCUMENT 且不写
        const expected = opts?.expectedVersion ?? ref.version
        const meta = await client.getMeta(ref.id)
        if (expected !== undefined && meta.revision !== expected) {
          return { ok: false, code: 'STALE_DOCUMENT', currentVersion: meta.revision }
        }
        // 官方无稳定的改标题接口 → title patch 忽略(保守,见协议层头注释);仅 body 落库
        let revision = meta.revision
        if (patch.body !== undefined) {
          revision = await client.setBody(ref.id, patch.body)
        }
        return { ok: true, ref: toRef(ref.id, meta.title, revision, meta.url) }
      },
      async searchDocuments(query, _scope) {
        // 未核实到稳定服务端搜索端点 → 协议层保守返回空数组(MVP 限制)
        return client.searchDocuments(query, { folderToken })
      },
    }
    ctx.teamService.registerDocumentProvider(provider)
    ctx.logger.info('[dsh-orgos-doc-feishu-docs] 文档 provider 已注册(feishu-docs)')
  } catch (error) {
    ctx.logger.warn(`[dsh-orgos-doc-feishu-docs] 注册失败:${String(error)}`)
  }
}

/** 文档元信息 → DocumentRef(version = revision_id) */
function toRef(id: string, title: string, version: string, url: string): DocumentRef {
  return { id, title, version, url }
}
