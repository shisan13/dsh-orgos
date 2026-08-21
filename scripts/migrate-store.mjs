#!/usr/bin/env node
/**
 * dsh-orgos 运维脚本:JSONL → SQLite 一次性迁移(M3.1)
 *
 * 用法(停服迁移,单写者):
 *   node scripts/migrate-store.mjs <stateRoot>
 *
 * - 自动发现 stateRoot 下全部 *.jsonl 流(registry/mailbox/taskboard/delegations/
 *   runs/memory-*),按行序搬入 team.sqlite;
 * - JSONL 原样保留;回退 = 删除 team.sqlite + 在 profile 中把 storeEngine 改回 jsonl;
 * - 已迁移过(meta.engine 存在)则拒绝重复迁移,需先备份并删除 team.sqlite;
 * - 迁移后在 profile team-core 行 config 加 `storeEngine: 'sqlite'` 再启动。
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { migrateJsonlToSqlite } from '../packages/core/lib/dsh/storeSqlite.js'

const stateRoot = process.argv[2]
if (!stateRoot) {
  console.error('usage: node scripts/migrate-store.mjs <stateRoot>')
  process.exit(2)
}
if (!existsSync(join(stateRoot, 'team', 'team.yml'))) {
  console.error(`不是有效的团队状态目录(缺 team/team.yml):${stateRoot}`)
  process.exit(2)
}
const streams = readdirSync(stateRoot)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => f.slice(0, -'.jsonl'.length))
const report = migrateJsonlToSqlite(stateRoot, streams)
console.log(JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
