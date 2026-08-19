/**
 * dsh-orgos-tools 绑定层 —— 团队工具注册(agent 平面,角色 preset 行挂载)
 *
 * 官方契约依据:ctx.tools.register(ToolDefinition) → disposer;
 * ToolDefinition = { name, description, parameters(ParameterSchemaSpec),
 *   output: { schema, render(args, value) → ContentBlock[] }, execute(args, exec) }。
 * exec.agent 为调用方 Agent;成员会话 id = orgos-member-<positionId>。
 *
 * 跨 profile 容错(技术设计 §7.2):未装 dsh-orgos-core 的 profile 中
 * ctx.get('teamService') 为 undefined → 全部工具行静默不注册,preset 退化为普通角色 agent。
 * 本包零 DSH import(结构类型),运行时由 DSH 做 Duck-typing。
 */
import type { TeamServiceFacade } from 'dsh-orgos-core/dsh/teamService'
import { TEMPLATE_SMALL, TEMPLATE_DEPT, TEMPLATE_GROUP } from '../templates.js'

interface ContentBlock {
  type: 'text'
  text: string
}

interface ToolRunContextLike {
  agent?: { id: string }
  signal: AbortSignal
}

type ParamSpec = Record<string, { type: string; required?: boolean; description?: string; items?: { type: string } }>

interface ToolDefLike {
  name: string
  description: string
  /** 注册表语义:已编译的 JSON Schema object(官方 ToolDefinition.parameters) */
  parameters: Record<string, unknown>
  output: {
    schema: { type: string }
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
}

interface ToolsLike {
  register(def: ToolDefLike): () => void
}

const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/**
 * ParameterSchemaSpec → 注册表要求的 JSON Schema object(官方 ToolDefinition.parameters 语义)。
 * 官方定义见 @deepseek-ai/dsh-tools 的 parameterSchemaSpecToJsonSchema:
 * { type: 'object', properties: {...}, required?: [...] }。
 */
function toJsonSchema(spec: ParamSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, prop] of Object.entries(spec)) {
    // 只保留有值字段:DSH lossless JSON 检查拒绝 undefined(request/header 序列化炸点)
    const node: Record<string, unknown> = { type: prop.type }
    if (prop.description !== undefined) node.description = prop.description
    if (prop.items !== undefined) node.items = prop.items
    properties[key] = node
    if (prop.required) required.push(key)
  }
  return required.length > 0
    ? { type: 'object', properties, required, additionalProperties: false }
    : { type: 'object', properties, additionalProperties: false }
}

/** 从调用方 agent 推导岗位 id;非成员会话(Web 用户)返回 'web-root' */
function positionOf(exec: ToolRunContextLike): string {
  const id = exec.agent?.id ?? ''
  return id.startsWith('orgos-member-') ? id.slice('orgos-member-'.length) : 'web-root'
}

export function registerTeamTools(ctx: { get(key: string): unknown }, tools: ToolsLike): void {
  const service = ctx.get('teamService') as TeamServiceFacade | undefined
  if (service === undefined) return

  tools.register({
    name: 'team_delegate',
    description:
      '向团队成员派发结构化任务(绝不 DIY 原则的核心工具)。target 为岗位 id;brief 含 task/requirements/acceptance 等必填字段,缺失将被拒绝。派发后立即返回,成员完成后经回执流通知。',
    parameters: toJsonSchema({
      target: { type: 'string', required: true, description: '目标岗位 id(在岗者接单)' },
      task: { type: 'string', required: true, description: '一句话任务' },
      requirements: { type: 'array', required: true, items: { type: 'string' }, description: '结构化需求' },
      acceptance: { type: 'array', required: true, items: { type: 'string' }, description: '验收标准,成员须附验证输出' },
      background: { type: 'string' },
      workingDirectory: { type: 'string' },
      constraints: { type: 'array', items: { type: 'string' } },
      protectedFiles: { type: 'array', items: { type: 'string' } },
      verification: { type: 'string' },
      timeoutMinutes: { type: 'integer' },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const brief = { ...(args as Record<string, unknown>), target: undefined }
      delete brief.target
      const from = positionOf(exec)
      const r = service.delegate(from, String((args as { target: string }).target), brief)
      if (!r.ok) return { ok: false, reason: r.reason, errors: r.errors ?? [] }
      return { ok: true, delegation: r.delegation }
    },
  })

  tools.register({
    name: 'team_status',
    description: '查询团队状态(成员/任务/委派/邮箱),结果已按你的 visibility scope 投影过滤;成员状态为实时折叠(offline/idle/busy)。',
    parameters: toJsonSchema({}),
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      return service.status(positionOf(exec))
    },
  })

  tools.register({
    name: 'team_mail_send',
    description: '向团队成员发送协作消息(kind: note 备忘/result 结果/escalation 升级)。跨 team 需 ACL 显式声明,否则被拒。',
    parameters: toJsonSchema({
      to: { type: 'string', required: true, description: '目标岗位 id' },
      body: { type: 'string', required: true },
      kind: { type: 'string', description: "note | result | escalation(默认 note)" },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const a = args as { to: string; body: string; kind?: string }
      return service.mailSend(positionOf(exec), a.to, a.kind ?? 'note', a.body)
    },
  })

  tools.register({
    name: 'team_mail_recv',
    description: '读取我的协作邮箱(按 visibility scope 投影)。',
    parameters: toJsonSchema({}),
    output: JSON_OUTPUT,
    async execute(_args, exec) {
      return { items: service.mailRecv(positionOf(exec)) }
    },
  })

  tools.register({
    name: 'team_task_create',
    description: '在团队任务板创建任务(可指派岗位)。',
    parameters: toJsonSchema({
      teamId: { type: 'string', required: true },
      title: { type: 'string', required: true },
      assignee: { type: 'string', required: true, description: '指派岗位 id' },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const a = args as { teamId: string; title: string; assignee: string }
      return service.taskCreate(a.teamId, a.title, a.assignee, positionOf(exec))
    },
  })

  tools.register({
    name: 'team_task_claim',
    description: '认领任务板任务。',
    parameters: toJsonSchema({ taskId: { type: 'string', required: true } }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return service.taskClaim(positionOf(exec), String((args as { taskId: string }).taskId))
    },
  })

  tools.register({
    name: 'team_task_complete',
    description: '完成我认领的任务(附验收证据;若任务来自委派,将同时触发回执流)。',
    parameters: toJsonSchema({ taskId: { type: 'string', required: true } }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return service.taskDone(positionOf(exec), String((args as { taskId: string }).taskId))
    },
  })

  tools.register({
    name: 'team_run',
    description: '查询运行记录与指标(委派/完成/失败),按你的 visibility scope 投影。',
    parameters: toJsonSchema({ limit: { type: 'integer', description: '返回条数上限(默认 50)' } }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const a = args as { limit?: number }
      return service.runReport(positionOf(exec), a.limit ?? 50)
    },
  })

  tools.register({
    name: 'team_memory_save',
    description:
      "向团队/集团记忆写入显式提炼(kind: contribution 贡献/handover 交接/decision 决策/insight 洞察)。写入受 authority scope 约束:你只能写自己 scope 内的层(成员写本 team;orchestrator 按层级提炼)。私有记忆不用本工具(那是你自己的 session 历史)。",
    parameters: toJsonSchema({
      level: { type: 'string', required: true, description: "team | org(team 写本团队记忆;org 需集团记忆权)" },
      kind: { type: 'string', description: 'contribution | handover | decision | insight(默认 contribution)' },
      content: { type: 'string', required: true, description: '记忆正文(提炼后的事实/结论,不贴原始日志)' },
      digest: { type: 'string', description: '一句话摘要(上层阅读压缩用,可选)' },
      teamId: { type: 'string', description: 'level=team 时可指定目标团队节点(默认你所在 team;须在你管辖子树内)' },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const a = args as { level: string; kind?: string; content: string; digest?: string; teamId?: string }
      return service.memorySave(positionOf(exec), a.level as 'team' | 'org', a.kind ?? 'contribution', a.content, a.digest, a.teamId)
    },
  })

  tools.register({
    name: 'team_memory_recall',
    description: '读取团队/集团记忆(结果已按你的 memory scope 强制投影:成员只见本 team;orchestrator 见管辖层)。',
    parameters: toJsonSchema({ limit: { type: 'integer', description: '返回条数上限(默认 50)' } }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const a = args as { limit?: number }
      return service.memoryList(positionOf(exec), a.limit ?? 50)
    },
  })

  tools.register({
    name: 'team_doctor',
    description: '团队健康诊断:配置/成员状态/委派任务板/存储四类检查,输出可执行修复建议。',
    parameters: toJsonSchema({}),
    output: JSON_OUTPUT,
    async execute(_args, _exec) {
      return service.doctor()
    },
  })

  tools.register({
    name: 'team_setup',
    description:
      "团队配置管理(仅组织根 orchestrator 场景)。init 用模板创建团队:'small'=3 岗位小组;'dept'=2 团队示例。replace 替换岗位占位者(agent↔human↔preset 升级),系统自动生成交接清单、按岗位 handover 策略处理进行中任务并注入新占位者初始记忆。写入走安全流程(备份→校验→原子替换,失败自动回滚)。",
    parameters: toJsonSchema({
      action: { type: 'string', required: true, description: 'init | bind | unbind | replace' },
      scale: { type: 'string', description: 'init 用:small | dept | group(默认 small)' },
      channel: { type: 'string', description: 'bind/unbind 用:IM 通道名(如 feishu-main)' },
      peerId: { type: 'string', description: 'bind/unbind 用:群/会话 ID' },
      target: { type: 'string', description: 'bind 用:目标岗位或节点 id;replace 用:目标岗位 id' },
      newKind: { type: 'string', description: "replace 用:新占位者类型 agent | human" },
      newPreset: { type: 'string', description: 'replace 用:agent 新占位者的角色 preset id' },
      newImChannel: { type: 'string', description: 'replace 用:human 新占位者的 IM 通道' },
      newImUserId: { type: 'string', description: 'replace 用:human 新占位者的 IM 用户 id' },
    }),
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const a = args as { action: string; scale?: string; channel?: string; peerId?: string; target?: string; newKind?: string; newPreset?: string; newImChannel?: string; newImUserId?: string }
      if (a.action === 'init') {
        const template = a.scale === 'dept' ? TEMPLATE_DEPT : a.scale === 'group' ? TEMPLATE_GROUP : TEMPLATE_SMALL
        return service.setupInit(template)
      }
      if (a.action === 'bind') {
        if (!a.channel || !a.peerId || !a.target) return { ok: false, reason: 'bind 需要 channel/peerId/target' }
        return service.bindRoute(a.channel, a.peerId, a.target)
      }
      if (a.action === 'unbind') {
        if (!a.channel || !a.peerId) return { ok: false, reason: 'unbind 需要 channel/peerId' }
        return service.unbindRoute(a.channel, a.peerId)
      }
      if (a.action === 'replace') {
        if (!a.target) return { ok: false, reason: 'replace 需要 target(岗位 id)' }
        if (a.newKind === 'human') {
          if (!a.newImChannel || !a.newImUserId) return { ok: false, reason: 'replace human 需要 newImChannel/newImUserId' }
          return service.replaceOccupant(positionOf(exec), a.target, { kind: 'human', im: { channel: a.newImChannel, userId: a.newImUserId } })
        }
        if (a.newKind === 'agent') {
          if (!a.newPreset) return { ok: false, reason: 'replace agent 需要 newPreset' }
          return service.replaceOccupant(positionOf(exec), a.target, { kind: 'agent', preset: a.newPreset })
        }
        return { ok: false, reason: 'replace 需要 newKind: agent | human' }
      }
      return { ok: false, reason: `unknown_action: ${a.action}` }
    },
  })
}
