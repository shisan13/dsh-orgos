// 构建后把仓库根角色 preset 模板复制进 core 包(随 npm 包分发,seeder 播种源)
import { cpSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))               // packages/core/scripts
const source = join(here, '..', '..', '..', 'presets')             // 仓库根 presets/
const target = join(here, '..', 'presets')                         // packages/core/presets
rmSync(target, { recursive: true, force: true })
cpSync(source, target, { recursive: true })
console.log(`[dsh-orgos-core] presets copied: ${source} → ${target}`)
