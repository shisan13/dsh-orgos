/**
 * dsh-orgos-core 播种器(ADR-003,P3):角色 preset 自动播种
 *
 * - 只写用户 root(${DSH_HOME}/.agent-presets/orgos-*),绝不触碰 shipped 目录;
 * - 已存在同名 preset → 绝不覆盖(用户改过的归用户);
 * - 播种失败只告警,不阻塞团队启动(简单留给用户:装完即用;失败可见可修)。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROLE_PRESETS = ['orgos-orchestrator', 'orgos-coder', 'orgos-reviewer', 'orgos-analyst', 'orgos-assistant'] as const

export interface SeedResult {
  seeded: string[]
  skipped: string[]
  errors: string[]
}

/** 仓库 presets/ 目录(构建产物中从 lib/dsh 定位;开发期从 src/dsh 定位) */
function repoPresetsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)) // packages/core/lib/dsh | packages/core/src/dsh
  return join(here, '..', '..', 'presets')
}

export function seedPresets(userRoot: string, log: (msg: string) => void): SeedResult {
  const result: SeedResult = { seeded: [], skipped: [], errors: [] }
  try {
    const source = repoPresetsDir()
    if (!existsSync(source)) {
      result.errors.push(`预设模板目录不存在: ${source}`)
      return result
    }
    mkdirSync(userRoot, { recursive: true })
    for (const role of ROLE_PRESETS) {
      const target = join(userRoot, role)
      if (existsSync(target)) {
        result.skipped.push(role)
        continue
      }
      cpSync(join(source, role), target, { recursive: true })
      result.seeded.push(role)
      log(`[dsh-orgos] 已播种角色 preset: ${role}`)
    }
  } catch (error) {
    result.errors.push(String(error))
  }
  return result
}
