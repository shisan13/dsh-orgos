/**
 * team_setup —— 配置管理工具核心(FR-X2/X5/X7;T5 配置篡改缓解)
 *
 * - init:按规模返回三模板之一(写入由 Pro 绑定层执行);
 * - validate:team.yml 校验(结构/连通/ACL/引用完整性,FR-X5 友好可修复);
 * - planAtomicUpdate:原子替换策略 —— 备份 → 校验 → 应用(继承 openclaw
 *   config-update 安全流程;T5:失败回滚),本层产出可执行计划,fs 由绑定层执行。
 */
import { parseTeamConfig } from 'dsh-orgos-core'
import type { ValidationIssue } from 'dsh-orgos-core'
import { SCALES, SCALE_DESCRIPTIONS, TEMPLATES, type TeamScale } from './templates.ts'
import { fail, ok, bullet, type ToolOutput } from './types.ts'

export interface SetupInitInput {
  scale: TeamScale
}

export function setupInit(input: SetupInitInput): ToolOutput {
  if (!SCALES.includes(input.scale)) {
    return fail('SCALE_INVALID', `scale 必须是 ${SCALES.join('/')}(${SCALES.map((s) => `${s}:${SCALE_DESCRIPTIONS[s]}`).join('; ')})`)
  }
  const yaml = TEMPLATES[input.scale]
  // 模板自身必须通过校验(模板即测试夹具;坏模板绝不出厂)
  const check = parseTeamConfig(yaml)
  if (!check.ok) {
    return fail('TEMPLATE_BROKEN', `模板 ${input.scale} 校验失败(内部错误):${check.issues[0]?.message ?? '未知'}`)
  }
  return ok(
    [
      `team.yml(${input.scale})模板已生成:`,
      `  规模:${SCALE_DESCRIPTIONS[input.scale]}`,
      `  请替换占位:ou_your_feishu_id / ou_ops_user_id / oc_your_group_id`,
      `  校验:${check.ok ? '通过' : '失败'}`,
      `  team_setup validate 可复查;文件写入由安装层执行`,
    ].join('\n'),
    { scale: input.scale, yaml },
  )
}

export interface SetupValidateInput {
  yaml: string
}

export function setupValidate(input: SetupValidateInput): ToolOutput {
  const result = parseTeamConfig(input.yaml)
  if (result.ok) {
    const org = result.config.org
    const positions = result.config.positions.length
    const routes = result.config.routes.length
    return ok(`team.yml 校验通过:org=${org},岗位 ${positions} 个,路由 ${routes} 条`, {
      valid: true,
      org,
      positionCount: positions,
      routeCount: routes,
    })
  }
  const lines = result.issues.map((i) => `- ${i.path}: ${i.message}${i.fix ? ` → 修复:${i.fix}` : ''}`)
  return fail('CONFIG_INVALID', `team.yml 校验失败(${result.issues.length} 处):\n${bullet(lines)}`)
}

/** 原子替换计划(T5):校验新配置 → 备份名 → 步骤;返回纯计划,fs 由绑定层执行 */
export interface AtomicUpdatePlan {
  valid: boolean
  issues: ValidationIssue[]
  backupName: string
  steps: string[]
}

export function planAtomicUpdate(_currentYaml: string, nextYaml: string, now?: () => number): AtomicUpdatePlan {
  const at = now?.() ?? Date.now()
  const check = parseTeamConfig(nextYaml)
  const backupName = `team.yml.bak-${new Date(at).toISOString().replace(/[:.]/g, '-')}`
  if (!check.ok) {
    return {
      valid: false,
      issues: check.issues,
      backupName,
      steps: [],
    }
  }
  return {
    valid: true,
    issues: [],
    backupName,
    steps: [
      `1. 备份当前配置 → ${backupName}`,
      '2. 原子写入新配置(临时文件 + rename)',
      '3. 热加载并二次校验(validateTeamConfig)',
      '4. 失败回滚:恢复备份并告警(T5)',
    ],
  }
}

/** team_setup 支持的动作清单(绑定层注册工具行的 description 素材) */
export const SETUP_ACTIONS = ['init', 'validate', 'update'] as const
