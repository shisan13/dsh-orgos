/**
 * dsh-orgos-core —— 团队工具定义单源(M3.2 团队工具远程化的防漂移基座)
 *
 * 一份 TeamToolDef 同时驱动两个注册面:
 * - packages/tools(agent 平面,dsh-orgos-tools/dsh 行):本地直连 teamService;
 * - packages/team-rpc 的 client 行(成员子进程):同 schema 注册,execute 经
 *   HTTP 转发到中央实例的 RPC 服务端,服务端用 VERIFIED positionId 重放同一
 *   remoteArgs —— 两端参数序/权限投影天然一致。
 *
 * 分层纪律:本文件纯数据 + 纯函数(零 DSH import、零 IO);
 * team_delegate/team_setup 为治理类工具,保留在 tools 包手写(不远程化)。
 */
import type { TeamServiceFacade } from './teamService.js'

export interface TeamToolDef {
  name: string
  description: string
  /** 已编译 JSON Schema object(type/properties/required),禁 undefined 键 */
  parameters: Record<string, unknown>
  /** 服务端方法名(RPC 白名单按此映射,不反射) */
  method: string
  /** 是否允许远程化(子进程内可用);治理类 = false */
  remote: boolean
  /**
   * 用户参数 → 服务端方法完整位置参数(含 positionId 插入位置)。
   * RPC 服务端用「经 token 校验的 positionId」调用同一函数 —— 客户端传入的
   * 身份字段只做路由提示,绝不作为权限依据(权限由服务端 resolveViewer 投影兜底)。
   */
  remoteArgs(args: Record<string, unknown>, positionId: string): unknown[]
  /** 本地直连:service[method](...remoteArgs),个别工具带响应包装 */
  invoke(service: TeamServiceFacade, args: Record<string, unknown>, positionId: string): unknown
}

/** RPC 参数透传哨兵:客户端 JSON 中不允许出现(positionId 永远由服务端注入) */
export const RPC_POSITION_SENTINEL = '@position'

/** 参数规格 → 已编译 JSON Schema(object/properties/required;DSH lossless 红线:无 undefined 键) */
function schema(spec: Record<string, { type: string; required?: boolean; description?: string; items?: { type: string } }>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(spec)) {
    const node: Record<string, unknown> = { type: prop.type }
    if (prop.description !== undefined) node.description = prop.description
    if (prop.items !== undefined) node.items = prop.items
    properties[key] = node
    if (prop.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

const passthrough = (r: unknown): unknown => r

export const TEAM_TOOL_DEFS: TeamToolDef[] = [
  {
    name: 'team_status',
    description: '查询团队状态(成员/任务/委派/邮箱),结果已按你的 visibility scope 投影过滤;成员状态为实时折叠(offline/idle/busy)。',
    parameters: schema({}),
    method: 'status',
    remote: true,
    remoteArgs: (_args, positionId) => [positionId],
    invoke: (service, _args, positionId) => passthrough(service.status(positionId)),
  },
  {
    name: 'team_mail_send',
    description: '向团队成员发送协作消息(kind: note 备忘/result 结果/escalation 升级)。跨 team 需 ACL 显式声明,否则被拒。',
    parameters: schema({
      to: { type: 'string', required: true, description: '目标岗位 id' },
      body: { type: 'string', required: true },
      kind: { type: 'string', description: 'note | result | escalation(默认 note)' },
    }),
    method: 'mailSend',
    remote: true,
    remoteArgs: (args, positionId) => [positionId, (args as { to: string }).to, (args as { kind?: string }).kind ?? 'note', (args as { body: string }).body],
    invoke: (service, args, positionId) => {
      const a = args as { to: string; body: string; kind?: string }
      return passthrough(service.mailSend(positionId, a.to, a.kind ?? 'note', a.body))
    },
  },
  {
    name: 'team_mail_recv',
    description: '读取我的协作邮箱(按 visibility scope 投影)。',
    parameters: schema({}),
    method: 'mailRecv',
    remote: true,
    remoteArgs: (_args, positionId) => [positionId],
    invoke: (service, _args, positionId) => ({ items: service.mailRecv(positionId) }),
  },
  {
    name: 'team_task_create',
    description: '在团队任务板创建任务(可指派岗位)。',
    parameters: schema({
      teamId: { type: 'string', required: true },
      title: { type: 'string', required: true },
      assignee: { type: 'string', required: true, description: '指派岗位 id' },
    }),
    method: 'taskCreate',
    remote: false, // 治理类(lead 常用但非成员闭环必需;远程化开关见 M3.2 §2.5)
    remoteArgs: (args, positionId) => [(args as { teamId: string }).teamId, (args as { title: string }).title, (args as { assignee: string }).assignee, positionId],
    invoke: (service, args, positionId) => {
      const a = args as { teamId: string; title: string; assignee: string }
      return passthrough(service.taskCreate(a.teamId, a.title, a.assignee, positionId))
    },
  },
  {
    name: 'team_task_claim',
    description: '认领任务板任务。',
    parameters: schema({ taskId: { type: 'string', required: true } }),
    method: 'taskClaim',
    remote: true,
    remoteArgs: (args, positionId) => [positionId, (args as { taskId: string }).taskId],
    invoke: (service, args, positionId) => passthrough(service.taskClaim(positionId, String((args as { taskId: string }).taskId))),
  },
  {
    name: 'team_task_complete',
    description: '完成我认领的任务(附验收证据;若任务来自委派,将同时触发回执流)。',
    parameters: schema({ taskId: { type: 'string', required: true } }),
    method: 'taskDone',
    remote: true,
    remoteArgs: (args, positionId) => [positionId, (args as { taskId: string }).taskId],
    invoke: (service, args, positionId) => passthrough(service.taskDone(positionId, String((args as { taskId: string }).taskId))),
  },
  {
    name: 'team_run',
    description: '查询运行记录与指标(委派/完成/失败),按你的 visibility scope 投影。',
    parameters: schema({ limit: { type: 'integer', description: '返回条数上限(默认 50)' } }),
    method: 'runReport',
    remote: true,
    remoteArgs: (args, positionId) => [positionId, (args as { limit?: number }).limit ?? 50],
    invoke: (service, args, positionId) => passthrough(service.runReport(positionId, (args as { limit?: number }).limit ?? 50)),
  },
  {
    name: 'team_memory_save',
    description:
      "向团队/集团记忆写入显式提炼(kind: contribution 贡献/handover 交接/decision 决策/insight 洞察)。写入受 authority scope 约束:你只能写自己 scope 内的层(成员写本 team;orchestrator 按层级提炼)。私有记忆不用本工具(那是你自己的 session 历史)。",
    parameters: schema({
      level: { type: 'string', required: true, description: 'team | org(team 写本团队记忆;org 需集团记忆权)' },
      kind: { type: 'string', description: 'contribution | handover | decision | insight(默认 contribution)' },
      content: { type: 'string', required: true, description: '记忆正文(提炼后的事实/结论,不贴原始日志)' },
      digest: { type: 'string', description: '一句话摘要(上层阅读压缩用,可选)' },
      teamId: { type: 'string', description: 'level=team 时可指定目标团队节点(默认你所在 team;须在你管辖子树内)' },
    }),
    method: 'memorySave',
    remote: true,
    remoteArgs: (args, positionId) => {
      const a = args as { level: string; kind?: string; content: string; digest?: string; teamId?: string }
      return [positionId, a.level, a.kind ?? 'contribution', a.content, a.digest, a.teamId]
    },
    invoke: (service, args, positionId) => {
      const a = args as { level: string; kind?: string; content: string; digest?: string; teamId?: string }
      return passthrough(service.memorySave(positionId, a.level as 'team' | 'org', a.kind ?? 'contribution', a.content, a.digest, a.teamId))
    },
  },
  {
    name: 'team_memory_recall',
    description: '读取团队/集团记忆(结果已按你的 memory scope 强制投影:成员只见本 team;orchestrator 见管辖层)。',
    parameters: schema({ limit: { type: 'integer', description: '返回条数上限(默认 50)' } }),
    method: 'memoryList',
    remote: true,
    remoteArgs: (args, positionId) => [positionId, (args as { limit?: number }).limit ?? 50],
    invoke: (service, args, positionId) => passthrough(service.memoryList(positionId, (args as { limit?: number }).limit ?? 50)),
  },
  {
    name: 'team_doctor',
    description: '团队健康诊断:配置/成员/委派任务板/存储/联邦/文档 provider 六类检查,输出可执行修复建议。',
    parameters: schema({}),
    method: 'doctor',
    remote: false,
    remoteArgs: () => [],
    invoke: (service) => passthrough(service.doctor()),
  },
  {
    name: 'team_doc_list',
    description:
      '列出团队知识库文档(跨全部或指定文档 provider;结果已按你的 visibility scope 投影)。省略 provider 时合并全部知识库,每条附 provider 标识(如 git-wiki/feishu-docs/feishu-bitable)。',
    parameters: schema({
      provider: { type: 'string', description: '文档 provider id(省略 = 全部)' },
      limit: { type: 'integer', description: '返回条数上限(默认 50)' },
    }),
    method: 'docList',
    remote: true,
    remoteArgs: (args, positionId) => [positionId, (args as { provider?: string }).provider, (args as { limit?: number }).limit ?? 50],
    invoke: (service, args, positionId) => passthrough(service.docList(positionId, (args as { provider?: string }).provider, (args as { limit?: number }).limit ?? 50)),
  },
  {
    name: 'team_doc_read',
    description: '读取团队知识库文档正文(按 docId 跨 provider 定位;多 provider 命中同名文档时返回歧义提示,需补 provider)。',
    parameters: schema({
      docId: { type: 'string', required: true, description: '文档 id(team_doc_list 结果中的 id)' },
      provider: { type: 'string', description: '文档 provider id(多知识库同名时必填)' },
    }),
    method: 'docGet',
    remote: true,
    remoteArgs: (args, positionId) => [positionId, (args as { provider?: string }).provider, (args as { docId: string }).docId],
    invoke: (service, args, positionId) => passthrough(service.docGet(positionId, (args as { provider?: string }).provider, (args as { docId: string }).docId)),
  },
  {
    name: 'team_doc_create',
    description: '在指定知识库创建文档(必须显式 provider;provider 可选值见 team_doc_list 或团队知识目录说明)。',
    parameters: schema({
      provider: { type: 'string', required: true, description: '目标文档 provider id' },
      title: { type: 'string', required: true, description: '文档标题' },
      body: { type: 'string', description: '文档正文(Markdown;默认空)' },
    }),
    method: 'docCreate',
    remote: true,
    remoteArgs: (args, positionId) => {
      const a = args as { provider: string; title: string; body?: string }
      return [positionId, a.provider, a.title, a.body ?? '']
    },
    invoke: (service, args, positionId) => {
      const a = args as { provider: string; title: string; body?: string }
      return passthrough(service.docCreate(positionId, a.provider, a.title, a.body ?? ''))
    },
  },
  {
    name: 'team_doc_update',
    description:
      '更新团队知识库文档(标题/正文;可携带 expectedVersion 做乐观并发控制,版本冲突返回 STALE_DOCUMENT 与当前版本,请先 team_doc_read 后合并再更新)。',
    parameters: schema({
      docId: { type: 'string', required: true, description: '文档 id' },
      provider: { type: 'string', description: '文档 provider id(多知识库同名时必填)' },
      title: { type: 'string', description: '新标题' },
      body: { type: 'string', description: '新正文(整篇替换)' },
      expectedVersion: { type: 'string', description: '期望的当前版本(team_doc_read 返回的 ref.version),防多人覆盖' },
    }),
    method: 'docUpdate',
    remote: true,
    remoteArgs: (args, positionId) => {
      const a = args as { docId: string; provider?: string; title?: string; body?: string; expectedVersion?: string }
      return [positionId, a.provider, a.docId, { title: a.title, body: a.body }, a.expectedVersion]
    },
    invoke: (service, args, positionId) => {
      const a = args as { docId: string; provider?: string; title?: string; body?: string; expectedVersion?: string }
      return passthrough(service.docUpdate(positionId, a.provider, a.docId, { title: a.title, body: a.body }, a.expectedVersion))
    },
  },
  {
    name: 'team_doc_search',
    description: '在团队知识库全文搜索(跨全部或指定 provider;结果已按你的 visibility scope 投影)。',
    parameters: schema({
      query: { type: 'string', required: true, description: '搜索关键词' },
      provider: { type: 'string', description: '文档 provider id(省略 = 全部)' },
      limit: { type: 'integer', description: '返回条数上限(默认 20)' },
    }),
    method: 'docSearch',
    remote: true,
    remoteArgs: (args, positionId) => [(positionId), (args as { provider?: string }).provider, (args as { query: string }).query, (args as { limit?: number }).limit ?? 20],
    invoke: (service, args, positionId) => passthrough(service.docSearch(positionId, (args as { provider?: string }).provider, (args as { query: string }).query, (args as { limit?: number }).limit ?? 20)),
  },
]

export const REMOTE_TOOL_DEFS: TeamToolDef[] = TEAM_TOOL_DEFS.filter((d) => d.remote)

export function toolDefByName(name: string): TeamToolDef | undefined {
  return TEAM_TOOL_DEFS.find((d) => d.name === name)
}
