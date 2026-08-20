/**
 * dsh-orgos-doc-feishu 绑定层 —— 文档 provider 注册行(bundle 行:name 'dsh-orgos-doc-feishu/dsh')
 *
 * 依赖 host 的 teamService(dsh-orgos-core/dsh 提供):把飞书多维表格注册为
 * DocumentProvider(Orgos Extension API)。凭据走 ctx.credentials(appId:appSecret,
 * 与 im-feishu 同格式,可复用同一凭据键)。
 *
 * 配置(行 config,用户 profile 层覆盖):
 * { credentialRef, appToken, tableId, titleField?, bodyField?, label? }
 * 应用需在飞书开放平台开通「多维表格」权限(bitable:app)。
 */
export const name = 'dsh-orgos-doc-feishu'

// 硬依赖:credentials 异步 init → inject 保证就绪;teamService 由 team-core 行提供
export const inject = ['credentials', 'teamService']

import { FeishuBitableClient } from '../index.js'
import type { DocumentProvider, DocumentRef } from 'dsh-orgos-core/dsh/extensions'

interface DocFeishuConfig {
  credentialRef: string
  appToken: string
  tableId: string
  titleField?: string
  bodyField?: string
  label?: string
}

interface Ctx {
  credentials: { resolve(ref: string): Promise<{ value: string } | undefined> }
  teamService: TeamServiceLike
  logger: { info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

interface TeamServiceLike {
  registerDocumentProvider(provider: DocumentProvider): () => void
}

export async function apply(ctx: Ctx, config: DocFeishuConfig): Promise<void> {
  const { credentialRef, appToken, tableId } = config ?? {}
  if (!credentialRef || !appToken || !tableId) {
    ctx.logger.warn('[dsh-orgos-doc-feishu] 配置缺 credentialRef/appToken/tableId,行停用(团队文档协作不启用)')
    return
  }
  try {
    const resolved = await ctx.credentials.resolve(credentialRef)
    if (!resolved) {
      ctx.logger.warn(`[dsh-orgos-doc-feishu] 凭据 ${credentialRef} 未配置,行停用`)
      return
    }
    const [appId, appSecret] = String(resolved.value).split(':')
    if (!appId || !appSecret) throw new Error('飞书凭据格式应为 appId:appSecret')
    const client = new FeishuBitableClient({ appId, appSecret, appToken, tableId, titleField: config.titleField, bodyField: config.bodyField })
    const provider: DocumentProvider = {
      id: 'feishu-bitable',
      label: config.label ?? '飞书多维表格',
      async listDocuments(_scope, opts) {
        const records = await client.listRecords(opts?.limit ?? 50)
        return records.map((r) => toRef(client.titleField, r))
      },
      async getDocument(ref) {
        const record = await client.getRecord(ref.id)
        if (record === undefined) return undefined
        return { ref: toRef(client.titleField, record), body: String(record.fields[client.bodyField] ?? '') }
      },
      async createDocument(_scope, doc) {
        const record = await client.createRecord({ [client.titleField]: doc.title, [client.bodyField]: doc.body })
        return toRef(client.titleField, record)
      },
      async updateDocument(ref, patch, opts) {
        // 多维表格行无后端 revision 概念:CAS 由未来 provider 支持;
        // 提供 expectedVersion 且与 ref.version 不符时仍按不匹配拒绝(保守,防陈旧覆盖)。
        if (opts?.expectedVersion !== undefined && ref.version !== undefined && opts.expectedVersion !== ref.version) {
          return { ok: false, code: 'STALE_DOCUMENT', currentVersion: ref.version }
        }
        const fields: Record<string, unknown> = {}
        if (patch.title !== undefined) fields[client.titleField] = patch.title
        if (patch.body !== undefined) fields[client.bodyField] = patch.body
        const record = await client.updateRecord(ref.id, fields)
        return { ok: true, ref: toRef(client.titleField, record) }
      },
      async searchDocuments(query) {
        const records = await client.searchRecords(query)
        return records.map((r) => toRef(client.titleField, r))
      },
    }
    ctx.teamService.registerDocumentProvider(provider)
    ctx.logger.info(`[dsh-orgos-doc-feishu] 文档 provider 已注册(feishu-bitable → appToken ${appToken})`)
  } catch (error) {
    ctx.logger.warn(`[dsh-orgos-doc-feishu] 注册失败:${String(error)}`)
  }
}

/** record → DocumentRef(标题列 → title;titleField 可配置,不再硬编码「标题」) */
function toRef(titleField: string, record: { recordId: string; fields: Record<string, unknown> }): DocumentRef {
  return {
    id: record.recordId,
    title: String(record.fields[titleField] ?? ''),
  }
}
