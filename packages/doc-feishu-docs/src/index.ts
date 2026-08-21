/**
 * dsh-orgos-doc-feishu-docs 协议层 —— 飞书云文档(docx)客户端(harness-agnostic,零 DSH import)
 *
 * 官方契约(飞书开放平台 docx-v1 / drive-v1,已联网核实,端点与响应形状见下):
 * - POST   /open-apis/auth/v3/tenant_access_token/internal → { tenant_access_token, expire }(缓存+提前刷新+401 重试)
 *   依据:https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
 * - POST   /open-apis/docx/v1/documents { title, folder_token? } → data.document { document_id, revision_id, title }
 *   注意:官方明确「仅支持指定文档标题,不支持带内容创建文档」,内容需另行 setBody。
 *   依据:https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/create
 * - GET    /open-apis/docx/v1/documents/{document_id} → data.document { document_id, revision_id, title }
 *   注意:版本字段名为 revision_id(int,起始 1),文档中常写作 revision,实际以 revision_id 为准。
 *   依据:https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/get
 * - GET    /open-apis/docx/v1/documents/{document_id}/raw_content → data.content(纯文本)
 *   依据:https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content
 * - GET    /open-apis/docx/v1/documents/{document_id}/blocks?page_size=500 → data.items[](块列表)
 *   block_type 枚举(本包用到):1=页面 Block(文档根)、2=文本 Block;文本内容位于 text.elements[].text_run.content。
 *   依据:https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block/list
 * - POST   /open-apis/docx/v1/documents/{document_id}/blocks/{block_id}/children
 *   body { children:[{ block_type:2, text:{ elements:[{ text_run:{ content } }] } }] } → data.document_revision_id
 *   依据:https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block-children/create
 * - PATCH  /open-apis/docx/v1/documents/{document_id}/blocks/batch_update
 *   body { requests:[{ block_id, update_text_elements:{ elements:[{ text_run:{ content } }] } }] } → data.document_revision_id
 *   依据:https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block/batch_update
 * - DELETE /open-apis/docx/v1/documents/{document_id}/blocks/{block_id}/children/batch_delete
 *   body { start_index, end_index }(左闭右开,相对父块子块列表) → data.document_revision_id
 *   依据:https://open.feishu.cn/document/ukTMukTMukTM/uUDN04SN0QjL1QDN/document-docx/docx-v1/document-block-children/batch_delete
 * - GET    /open-apis/drive/v1/files?folder_token=...&page_size=... → data.files[](type='docx' 为云文档)
 *   依据:https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/drive-v1/file/list
 *
 * 已核实的限制(不虚构实现):
 * - 更新文档标题:docx-v1 document 资源仅有 create/get/raw_content,官方无稳定的改标题接口
 *   (larksuite-oapi Java SDK DocxService.Document 亦只有 create/get/rawContent)→ 绑定层 title patch 保守忽略。
 * - 服务端全文搜索:drive-v1 file 资源无 search 端点(未核实到稳定搜索接口)→ searchDocuments 保守返回空数组。
 * - 「列全部文档」:drive/files 必须带 folder_token,未配置 folderToken 时保守返回空数组。
 *
 * 分层纪律:本文件零 DSH import;fetch 可注入(测试 mock);错误统一为 FeishuDocsError(code/msg 摘要),凭据不进日志/错误消息。
 */
export interface FeishuDocsConfig {
  appId: string
  appSecret: string
  /** API 基址(默认飞书;Lark 国际版可覆盖,如 https://open.larksuite.com) */
  baseUrl?: string
}

/** 协议层文档引用最小形状(与 DocumentProvider 的 DocumentRef 对齐,绑定层负责映射) */
export interface FeishuDocRef {
  id: string
  title: string
  url?: string
  updatedAt?: string
}

/** 统一错误:带业务 code/msg 摘要,便于绑定层按 code 分支(如 1770002 = 文档不存在) */
export class FeishuDocsError extends Error {
  constructor(
    public readonly code: string,
    public readonly msg: string,
  ) {
    super(`飞书云文档请求失败:code=${code} msg=${msg}`)
    this.name = 'FeishuDocsError'
  }
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

interface TokenCache {
  token: string
  expiresAt: number
}

/** 块枚举:本包只使用页面块(根)与文本块 */
const BLOCK_TYPE_PAGE = 1
const BLOCK_TYPE_TEXT = 2

interface BlockItem {
  block_id: string
  block_type: number
  parent_id?: string
  children?: string[]
  text?: { elements?: Array<{ text_run?: { content?: string } }> }
}

interface DriveFile {
  token: string
  name?: string
  type?: string
  url?: string
  modified_time?: string
}

/** 飞书业务错误码:文档不存在(404) */
const CODE_DOC_NOT_FOUND = '1770002'

/** 列目录总量硬上限:防止异常后端 has_more 恒真导致无界拉取 */
const MAX_LIST_TOTAL = 1000

export class FeishuDocsClient {
  private readonly baseUrl: string
  private tokenCache: TokenCache | undefined

  constructor(
    private readonly config: FeishuDocsConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.baseUrl = config.baseUrl ?? 'https://open.feishu.cn'
  }

  /** 创建云文档(仅标题;正文为空时 revision 即 1,非空时绑定层再 setBody)。
   *  opts.folderToken 提供时写入 body.folder_token(官方 create 支持指定目标文件夹)。 */
  async createDocument(title: string, opts?: { folderToken?: string }): Promise<{ documentId: string; revision: string }> {
    const body: Record<string, unknown> = { title }
    if (opts?.folderToken !== undefined && opts.folderToken !== '') body.folder_token = opts.folderToken
    const data = await this.request<{ data?: { document?: { document_id?: string; revision_id?: number } } }>(
      'POST',
      '/open-apis/docx/v1/documents',
      body,
    )
    const doc = data.data?.document
    if (doc?.document_id === undefined) {
      throw new FeishuDocsError('EMPTY_RESPONSE', '创建文档响应缺少 document_id')
    }
    return { documentId: doc.document_id, revision: String(doc.revision_id ?? 1) }
  }

  /** 获取文档元信息:title + revision(revision_id)+ 浏览器打开链接 */
  async getMeta(documentId: string): Promise<{ title: string; revision: string; url: string }> {
    const data = await this.request<{ data?: { document?: { title?: string; revision_id?: number } } }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
    )
    const doc = data.data?.document
    if (doc === undefined) {
      throw new FeishuDocsError(CODE_DOC_NOT_FOUND, '文档不存在')
    }
    return { title: doc.title ?? '', revision: String(doc.revision_id ?? 1), url: this.docUrl(documentId) }
  }

  /** 获取文档纯文本(raw_content) */
  async getRawContent(documentId: string): Promise<string> {
    const data = await this.request<{ data?: { content?: string } }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
    )
    return data.data?.content ?? ''
  }

  /**
   * 设置文档正文(整块替换语义),返回写入后的新 revision。
   * 实现(依据上述官方端点):读根块子块 → 存在文本块则 batch_update 替换第一个文本块并
   * batch_delete 其余子块(保证正文与 body 完全一致;注意会移除文档内既有非文本块,属「整块替换」语义);
   * 无文本块则 create children 追加一个文本块。空 body 不写(避免空块),直接返回当前版本。
   */
  async setBody(documentId: string, body: string): Promise<string> {
    if (!body) return this.getRevision(documentId)
    const { root, textChildren } = await this.readBlocks(documentId)
    if (textChildren.length > 0) {
      // 存在正文块:batch_update 整块替换第一个文本块
      const first = textChildren[0] as BlockItem
      const patch = await this.request<{ data?: { document_revision_id?: number } }>(
        'PATCH',
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/batch_update`,
        {
          requests: [
            {
              block_id: first.block_id,
              update_text_elements: { elements: [{ text_run: { content: body } }] },
            },
          ],
        },
      )
      // 整块替换语义:删除其余子块(含非文本块),只保留更新后的第一块
      const childCount = root.children?.length ?? 0
      if (childCount > 1) {
        const del = await this.request<{ data?: { document_revision_id?: number } }>(
          'DELETE',
          `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(root.block_id)}/children/batch_delete`,
          { start_index: 1, end_index: childCount },
        )
        return String(del.data?.document_revision_id ?? patch.data?.document_revision_id ?? (await this.getRevision(documentId)))
      }
      return String(patch.data?.document_revision_id ?? (await this.getRevision(documentId)))
    }
    // 无正文块:create children 追加一个文本块
    const created = await this.request<{ data?: { document_revision_id?: number } }>(
      'POST',
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(root.block_id)}/children`,
      { children: [{ block_type: BLOCK_TYPE_TEXT, text: { elements: [{ text_run: { content: body } }] } }] },
    )
    return String(created.data?.document_revision_id ?? (await this.getRevision(documentId)))
  }

  /**
   * 列出文件夹下的云文档(drive-v1 files,仅保留 type='docx')。
   * - 未配置 folderToken 时飞书无「列全部文档」的简单端点,保守返回空数组(不虚构实现);
   * - 官方分页:请求 page_token + 响应 has_more/page_token,本实现循环取全,
   *   总量受 limit 截断(单次请求 ≤200);文件夹仅单层(官方接口不支持递归);
   * - 防御:next page_token 与上页相同视为终点,防异常后端死循环。
   */
  async listDocuments(folderToken: string | undefined, opts?: { limit?: number }): Promise<FeishuDocRef[]> {
    if (!folderToken) return []
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, MAX_LIST_TOTAL))
    const refs: FeishuDocRef[] = []
    let pageToken: string | undefined
    for (;;) {
      const pageSize = Math.min(200, limit - refs.length)
      if (pageSize <= 0) break
      const qs =
        `folder_token=${encodeURIComponent(folderToken)}&page_size=${pageSize}` +
        (pageToken === undefined ? '' : `&page_token=${encodeURIComponent(pageToken)}`)
      const data = await this.request<{ data?: { files?: DriveFile[]; has_more?: boolean; page_token?: string } }>(
        'GET',
        `/open-apis/drive/v1/files?${qs}`,
      )
      const files = data.data?.files ?? []
      refs.push(...files.filter((f) => f.type === 'docx').map(fileToRef.bind(null, this)))
      const next = data.data?.page_token
      if (data.data?.has_more !== true || next === undefined || next === '' || next === pageToken) break
      if (refs.length >= limit) break
      pageToken = next
    }
    return refs.slice(0, limit)
  }

  /**
   * 服务端搜索:MVP 未核实到稳定的全文搜索端点(drive-v1 file 无 search 方法),
   * 保守返回空数组并注明限制;绝不编造未核实端点的响应形状。
   */
  async searchDocuments(_query: string, _opts?: { folderToken?: string }): Promise<FeishuDocRef[]> {
    return []
  }

  /** 读取文档块列表,定位根页面块及其文本子块(单页 page_size=500,MVP 够用) */
  private async readBlocks(documentId: string): Promise<{ root: BlockItem; textChildren: BlockItem[] }> {
    const data = await this.request<{ data?: { items?: BlockItem[] } }>(
      'GET',
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?page_size=500`,
    )
    const items = data.data?.items ?? []
    const root = items.find((b) => b.block_type === BLOCK_TYPE_PAGE)
    if (root === undefined) throw new FeishuDocsError(CODE_DOC_NOT_FOUND, '未找到文档根页面块')
    const children = root.children ?? []
    const byId = new Map(items.map((b) => [b.block_id, b] as const))
    const textChildren = children
      .map((id) => byId.get(id))
      .filter((b): b is BlockItem => b !== undefined && b.block_type === BLOCK_TYPE_TEXT)
    return { root, textChildren }
  }

  /** 兜底取当前版本(写响应缺 document_revision_id 时用) */
  private async getRevision(documentId: string): Promise<string> {
    const meta = await this.getMeta(documentId)
    return meta.revision
  }

  /** 浏览器打开链接:https://<base 域名>/docx/<id>,域名为去 open. 前缀的 API 域名(公开:fileToRef 复用) */
  docUrl(documentId: string): string {
    const host = new URL(this.baseUrl).hostname.replace(/^open\./, '')
    return `https://${host}/docx/${documentId}`
  }

  /** tenant_access_token:缓存 + 提前 60s 刷新;业务 401 时清缓存重试一次 */
  private async token(): Promise<string> {
    if (this.tokenCache !== undefined && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token
    }
    const res = await this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.config.appSecret }),
    })
    const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number }
    if (!res.ok || body.tenant_access_token === undefined) {
      throw new FeishuDocsError(String(body.code ?? res.status), body.msg ?? 'token 获取失败')
    }
    this.tokenCache = { token: body.tenant_access_token, expiresAt: Date.now() + (body.expire ?? 7200) * 1000 }
    return this.tokenCache.token
  }

  /** 统一业务请求:非 0 code / 非 2xx → FeishuDocsError;401 → 刷新 token 重试一次 */
  private async request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const token = await this.token()
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json()) as { code?: number; msg?: string }
    if (!res.ok || (json.code !== undefined && json.code !== 0)) {
      if (retry && res.status === 401) {
        // token 过期:清缓存后重试一次,避免旧 token 反复 401
        this.tokenCache = undefined
        return this.request<T>(method, path, body, false)
      }
      throw new FeishuDocsError(String(json.code ?? res.status), json.msg ?? '')
    }
    return json as T
  }
}

/** 秒级时间戳 → ISO 字符串(非法值原样返回,不抛错) */
function toIsoSeconds(value: string): string {
  const n = Number(value)
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : value
}

/** drive 文件 → FeishuDocRef(url 缺失回退拼接,updatedAt 缺省/原样) */
function fileToRef(client: FeishuDocsClient, f: DriveFile): FeishuDocRef {
  return {
    id: f.token,
    title: f.name ?? '',
    url: f.url ?? client.docUrl(f.token),
    updatedAt: f.modified_time === undefined ? undefined : toIsoSeconds(f.modified_time),
  }
}
