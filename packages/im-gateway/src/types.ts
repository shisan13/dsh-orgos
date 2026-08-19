/**
 * im-gateway 领域类型 —— NormalizedMessage 与 IM seam 契约(技术设计 §5.2 / §9)
 *
 * 本包是 MessageGateway seam 的定义 + 消息规范化(harness-agnostic):
 * - NormalizedMessage:入站统一消息(飞书/Telegram/… 全部规范化为该形状);
 * - ImAdapter:每个 IM 一个 provider(仿 ctx.subprocess 后端);
 * - 出站/卡片:PeerRef/OutboundPayload/ApprovalCard/QuestionCard。
 *
 * Pro 阶段绑定层(team-im-gateway cordis 行)聚合适配器并接 team/inbound-message 事件。
 */

/** 会话对象:群或私聊 */
export interface PeerRef {
  kind: 'group' | 'direct'
  id: string
  /** 回复场景的线程 id(如飞书 reply thread) */
  threadId?: string
}

export interface SenderRef {
  id: string
  name?: string
}

/** 入站消息类型(技术设计 §9.2) */
export type InboundKind = 'text' | 'mention' | 'reply' | 'approval_reply' | 'attachment'

/** 规范化入站消息(适配器输出/团队消费的统一形状) */
export interface NormalizedMessage {
  channel: string
  peer: PeerRef
  sender: SenderRef
  kind: InboundKind
  /** 文本内容(text/mention/reply);approval_reply 为结构化 content */
  content?: string
  /** approval_reply 专用:{approvalId, action} */
  approval?: { approvalId: string; action: 'allow' | 'deny' }
  /** attachment 专用:转存引用 */
  attachment?: { ref: string; name?: string }
  messageId: string
  ts?: string
}

/** 出站负载(适配器渲染为平台消息/卡片) */
export interface OutboundPayload {
  target: PeerRef
  text?: string
  card?: ApprovalCard | QuestionCard | TaskCard
  /** 流式回复(可选能力) */
  stream?: AsyncIterable<string>
}

/** 审批卡(技术设计 §9.3;T6 一次性 + 幂等) */
export interface ApprovalCard {
  kind: 'approval'
  approvalId: string
  title: string
  body: string
  /** 超时自动 deny(fail-closed,默认 10 分钟) */
  timeoutMinutes?: number
}

/** 提问卡(human orchestrator 决策,FR-H6) */
export interface QuestionCard {
  kind: 'question'
  questionId: string
  title: string
  body: string
  options: string[]
}

/** 任务卡(FR-H3:接受/拒绝/完成汇报/求助) */
export interface TaskCard {
  kind: 'task'
  taskId: string
  title: string
  body: string
  /** 任务卡按钮语义:接受/拒绝/完成汇报 */
  actions: ('accept' | 'reject' | 'report')[]
  deadlineAt?: number
}

/** ImAdapter seam:每个 IM 一个 provider(技术设计 §5.2) */
export interface ImAdapter {
  readonly channel: string
  /** 建连(WS/长轮询/webhook 路由);幂等;失败指数退避重连(上限后发 im-disconnected) */
  start(): Promise<void>
  stop(): Promise<void>
  sendText(target: PeerRef, text: string): Promise<void>
  sendCard(target: PeerRef, card: ApprovalCard | QuestionCard | TaskCard): Promise<void>
  /** 可选:流式回复 */
  sendStream?(target: PeerRef, deltas: AsyncIterable<string>): Promise<void>
}

/** 入站回调:适配器 → gateway(规范化消息 + 原始事件上下文) */
export type InboundHandler = (msg: NormalizedMessage) => void | Promise<void>

/** 适配器启动时的连接事件回调(可观测/运维) */
export type ConnectionHandler = (channel: string, state: 'connected' | 'disconnected', reason?: string) => void

/** TeamImGateway 聚合服务(host 侧;Pro 绑定层实现,此处只定义契约) */
export interface TeamImGateway {
  registerAdapter(adapter: ImAdapter): () => void
  /** 入站:规范化 → team/inbound-message 事件 → 路由 */
  inbound(msg: NormalizedMessage): Promise<void>
  outbound(target: PeerRef, payload: OutboundPayload): Promise<void>
}
