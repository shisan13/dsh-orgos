/**
 * dsh-orgos-doc-feishu 协议层 —— 飞书多维表格(Bitable)客户端(harness-agnostic)
 *
 * 官方契约(飞书开放平台,bitable-v1):
 * - POST /open-apis/auth/v3/tenant_access_token/internal → tenant_access_token(缓存+提前刷新)
 * - GET  /open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records
 * - GET  /open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records/{recordId}
 * - POST /open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records
 * - PUT  /open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records/{recordId}
 * - POST /open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records/search(字段条件过滤)
 *
 * 分层纪律:本文件零 DSH import;fetch 可注入(测试 mock);凭据不进日志。
 */
export interface BitableConfig {
  appId: string
  appSecret: string
  /** 多维表格 app token(表格 URL 中的 base token) */
  appToken: string
  /** 数据表 id(默认第一张表可传 tblXXX) */
  tableId: string
  /** 标题/正文字段名(默认「标题」「正文」,按用户表格实际列名配置) */
  titleField?: string
  bodyField?: string
  /** API 基址(默认飞书;Lark 国际版可覆盖) */
  baseUrl?: string
}

export interface BitableRecord {
  recordId: string
  fields: Record<string, unknown>
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

export class FeishuBitableClient {
  readonly titleField: string
  readonly bodyField: string
  private readonly baseUrl: string
  private tokenCache: TokenCache | undefined

  constructor(
    private readonly config: BitableConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.titleField = config.titleField ?? '标题'
    this.bodyField = config.bodyField ?? '正文'
    this.baseUrl = config.baseUrl ?? 'https://open.feishu.cn'
  }

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
      throw new Error(`飞书 token 获取失败:code=${String(body.code)} msg=${body.msg ?? ''}`)
    }
    this.tokenCache = { token: body.tenant_access_token, expiresAt: Date.now() + (body.expire ?? 7200) * 1000 }
    return this.tokenCache.token
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.token()
    const res = await this.fetchImpl(`${this.baseUrl}/open-apis/bitable/v1/apps/${this.config.appToken}/tables/${this.config.tableId}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = (await res.json()) as { code?: number; msg?: string } & T
    if (!res.ok || (json.code !== undefined && json.code !== 0)) {
      throw new Error(`飞书多维表格请求失败:${method} ${path} code=${String(json.code)} msg=${String(json.msg ?? '')}`)
    }
    return json
  }

  /** 列记录(分页取一页,limit 由调用方控制) */
  async listRecords(limit = 50): Promise<BitableRecord[]> {
    const data = await this.request<{ data?: { items?: Array<{ record_id: string; fields: Record<string, unknown> }> } }>(
      'GET',
      `/records?page_size=${Math.max(1, Math.min(limit, 500))}`,
    )
    return (data.data?.items ?? []).map((i) => ({ recordId: i.record_id, fields: i.fields ?? {} }))
  }

  async getRecord(recordId: string): Promise<BitableRecord | undefined> {
    try {
      const data = await this.request<{ data?: { record?: { record_id: string; fields: Record<string, unknown> } } }>(
        'GET',
        `/records/${encodeURIComponent(recordId)}`,
      )
      const record = data.data?.record
      return record === undefined ? undefined : { recordId: record.record_id, fields: record.fields ?? {} }
    } catch (error) {
      if (String(error).includes('Record') && String(error).includes('not')) return undefined
      throw error
    }
  }

  async createRecord(fields: Record<string, unknown>): Promise<BitableRecord> {
    const data = await this.request<{ data?: { record?: { record_id: string; fields: Record<string, unknown> } } }>(
      'POST',
      '/records',
      { fields },
    )
    const record = data.data?.record
    if (record === undefined) throw new Error('飞书多维表格创建记录返回为空')
    return { recordId: record.record_id, fields: record.fields ?? {} }
  }

  async updateRecord(recordId: string, fields: Record<string, unknown>): Promise<void> {
    await this.request<unknown>('PUT', `/records/${encodeURIComponent(recordId)}`, { fields })
  }

  /** 按标题字段模糊搜索(飞书 search 接口,contains) */
  async searchRecords(query: string, limit = 20): Promise<BitableRecord[]> {
    const data = await this.request<{ data?: { items?: Array<{ record_id: string; fields: Record<string, unknown> }> } }>(
      'POST',
      '/records/search',
      {
        filter: {
          conjunction: 'and',
          conditions: [{ field_name: this.titleField, operator: 'contains', value: [query] }],
        },
        page_size: Math.max(1, Math.min(limit, 500)),
      },
    )
    return (data.data?.items ?? []).map((i) => ({ recordId: i.record_id, fields: i.fields ?? {} }))
  }
}
