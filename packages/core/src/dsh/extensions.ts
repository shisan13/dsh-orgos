/**
 * dsh-orgos-core 扩展面(Orgos Extension API)—— 「插件的插件」契约
 *
 * 设计原则(对齐 DeepSeek Harness 一切皆是插件):
 * - orgos 的扩展点 = 普通 DSH 插件行,`ctx.get('teamService')` 拿到扩展面;
 * - 第三方能力(Jira/日历/CRM/文档库/存储引擎/联邦路由)以独立包 + cordis 行
 *   插在 team-core 之后启用,写法与给 DSH 写插件零差异;
 * - 本文件只定义契约与注册入口,provider 实现放各自包(P2/M3)。
 *
 * 分层纪律:本文件在 dsh/ 绑定层(允许接触 DSH 运行时);domain/ 保持零 DSH。
 */

/** 团队工具定义(与 DSH ToolDefinition 对齐的最小形状;第三方照 registerTeamTools 模式注册) */
export interface TeamToolDefinition {
  name: string
  description: string
  /** 已编译 JSON Schema object(type/properties/required),禁 undefined 键 */
  parameters: Record<string, unknown>
  execute(args: unknown): Promise<unknown> | unknown
}

/** 文档引用(外部文档库/内部知识目录的统一最小形状) */
export interface DocumentRef {
  id: string
  title: string
  /** 归属团队节点 id(可选:org 级文档) */
  teamId?: string
  url?: string
  updatedAt?: string
  /** 后端历史标识(git commit hash / 飞书 revision),用于变更审计与 CAS 冲突提示 */
  version?: string
}

export interface DocumentContent {
  ref: DocumentRef
  body: string
  meta?: Record<string, unknown>
}

/** 文档更新结果(updateDocument 的统一返回) */
export type DocumentUpdateResult =
  | { ok: true; ref: DocumentRef }
  | { ok: false; code: 'STALE_DOCUMENT'; currentVersion?: string }

/**
 * TeamService 文档路由结果(team_doc_* 工具的返回形状)。
 * items/ref/doc 一律附带 provider 标识(多 provider 场景消除歧义)。
 */
export type DocListResult =
  | { ok: true; items: Array<DocumentRef & { provider: string }> }
  | { ok: false; reason: string }

export type DocGetResult =
  | { ok: true; doc: DocumentContent & { provider: string }; ambiguous?: string[] }
  | { ok: false; reason: string }

export type DocCreateResult =
  | { ok: true; ref: DocumentRef & { provider: string } }
  | { ok: false; reason: string }

export type DocRouteUpdateResult =
  | { ok: true; ref: DocumentRef & { provider: string } }
  | { ok: false; reason: string; code?: 'STALE_DOCUMENT'; currentVersion?: string }

export type DocSearchResult =
  | { ok: true; items: Array<DocumentRef & { provider: string }> }
  | { ok: false; reason: string }

/**
 * 文档 provider seam(P2 起实装:飞书云文档/多维表格、钉钉、企微、Notion/Confluence,
 * 与 IM adapter 同模式)。TeamService 持有 registry,文档工具与知识目录按 scope 路由。
 */
export interface DocumentProvider {
  /** provider 标识(与 channel 命名一致,如 git-wiki / feishu-docs / feishu-bitable) */
  id: string
  /** 人类可读名 */
  label: string
  listDocuments(scope: { teamId?: string }, opts?: { limit?: number }): Promise<DocumentRef[]>
  getDocument(ref: DocumentRef): Promise<DocumentContent | undefined>
  createDocument(scope: { teamId?: string }, doc: { title: string; body: string }): Promise<DocumentRef>
  /** 变更携带期望版本;不匹配 → STALE_DOCUMENT(与 TaskBoard CAS 同语义,防多人覆盖) */
  updateDocument(ref: DocumentRef, patch: { title?: string; body?: string }, opts?: { expectedVersion?: string }): Promise<DocumentUpdateResult>
  searchDocuments(query: string, scope: { teamId?: string }): Promise<DocumentRef[]>
}

/** 文档 provider 注册结果 */
export type DocumentProviderRegistration = { ok: true } | { ok: false; reason: string }

/**
 * 集团联邦接口(OrgFederation)—— 跨实例根协调协议,200 人期只定义不实现;
 * M3 起每 BG 一个 host 实例,根 orchestrator 经此协议跨实例委派/折叠/心跳。
 */
export interface OrgFederation {
  /** 联邦节点标识(实例名) */
  nodeId: string
  /** 跨实例委派转发(delegation 序列化为可传输 JSON) */
  dispatchDelegation(delegation: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>
  /** 折叠报告上报(子实例 → 根实例) */
  reportHeartbeat(folded: { nodeId: string; text: string }): Promise<void>
  /** 升级流(异常/卡点即时上报) */
  escalate(event: Record<string, unknown>): Promise<void>
}

/** TeamService 扩展面(第三方 orgos 插件拿到的稳定调用面) */
export interface OrgosExtensionApi {
  /** 注册文档 provider(返回 disposer) */
  registerDocumentProvider(provider: DocumentProvider): () => void
  /** 列出已注册文档 provider(可观测) */
  listDocumentProviders(): Array<{ id: string; label: string }>
  /** 注入集团联邦实现(集团期启用;传 undefined 卸载) */
  setFederation(federation: OrgFederation | undefined): void
  /** 订阅团队事件流(稳定 API,屏蔽 DSH 事件名/payload 细节;返回 disposer) */
  onTeamEvent(listener: (event: string, payload: Record<string, unknown>) => void): () => void
}
