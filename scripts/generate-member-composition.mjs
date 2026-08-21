#!/usr/bin/env node
/**
 * dsh-orgos 运维脚本:角色 preset → 成员子进程组合生成(M3.5)
 *
 * 用法:
 *   node scripts/generate-member-composition.mjs <presetId> <out.yml> [--rpc] [--backend sdk|acp]
 *
 * - 从 presets/<presetId>/agent.cordis.yml 提取 persona 文本(角色人格),
 *   生成 member-dsh-sdk 子进程组合:官方 sdk-jsonrpc-server + llm-deepseek +
 *   sandbox/bash/fs + agent-spine(persona)+ 会话持久化;
 * - --rpc:追加 team-rpc client 行(团队工具远程化;baseUrl/positionId/token
 *   由父进程 env 注入:DSH_ORGOS_RPC_*),组合内以 !!js 读取;
 * - 组合文件必须放在可解析 harness 包的目录树内(官方示例模式,如 checkout
 *   examples/jsonrpc-agent/);DSH_CWD/DSH_SESSION_ROOT 由父进程 launch.env 注入。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const presetId = process.argv[2]
const outPath = process.argv[3]
const withRpc = process.argv.includes('--rpc')
const backend = process.argv.includes('--backend') ? process.argv[process.argv.indexOf('--backend') + 1] : 'sdk'
if (backend !== 'sdk' && backend !== 'acp') {
  console.error('--backend 仅支持 sdk|acp')
  process.exit(2)
}
if (!presetId || !outPath) {
  console.error('usage: node scripts/generate-member-composition.mjs <presetId> <out.yml> [--rpc]')
  process.exit(2)
}

const presetFile = join(root, 'presets', presetId, 'agent.cordis.yml')
let persona = '你是 dsh-orgos 组织的成员。收到的消息来自团队 IM,回复简洁、中文为主、直接可用。'
try {
  const text = readFileSync(presetFile, 'utf8')
  // 提取 persona 行 text 字段(> 折行 | 块两种写法都取;简单解析:取 text: 后到第一个非缩进行)
  const match = /text:\s*(>-|\|)([\s\S]*?)(?=\n- id:|\n\n- id:|\Z)/.exec(text)
  if (match) {
    persona = match[2]
      .split('\n')
      .map((l) => l.replace(/^\s+/, ''))
      .join('\n')
      .trim()
    if (persona.length === 0) throw new Error('empty')
  }
} catch {
  console.error(`preset ${presetId} 的 persona 文本提取失败,使用默认人格`)
}

const rpcBlock = withRpc
  ? `
# 团队工具远程化(M3.2):中央实例 RPC 客户端;身份三要素由父进程 env 注入
- id: team-rpc-client
  name: 'dsh-orgos-team-rpc/client'
  config:
    baseUrl: !!js process.env.DSH_ORGOS_RPC_URL
    positionId: !!js process.env.DSH_ORGOS_RPC_POSITION
    token: !!js process.env.DSH_ORGOS_RPC_TOKEN
`
  : ''

const composition = backend === 'acp' ? acpComposition() : sdkComposition()

function sdkComposition() {
  return `# dsh-orgos 成员子进程组合(生成自 presets/${presetId};M3.5 模板,SDK 后端)
# stdout 保留给 JSON-RPC;组合必须放在可解析 harness 包的目录树内。
# 团队协作经 team-rpc 客户端(需父进程配置 rpc.url)或父进程代理。

- id: sdk-jsonrpc-server
  name: '@deepseek-ai/dsh-sdk-jsonrpc-server'
  config:
    maxTokensAsSuccess: false

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: !!js process.env.DSH_MODEL ?? 'deepseek-v4-flash'
        contextWindow: !!js Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()

# 工具注册面(团队工具远程化 client 行需要;与官方 base 同款行)
- id: tools
  name: '@deepseek-ai/dsh-tools'

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: pty
  name: '@deepseek-ai/dsh-terminal'

- id: terminal-bash
  name: '@deepseek-ai/dsh-terminal-bash'
  config:
    timeoutMs: 300000

- id: fs-local
  name: '@deepseek-ai/dsh-fs-local'
  config:
    cwd: !!js process.env.DSH_CWD ?? process.cwd()

- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    persona: >-
${persona.split('\n').map((l) => '      ' + l).join('\n')}
    workspaceContext: false
    skills:
      enabled: false
    toolBash:
      enableRunInBackground: false
    toolJobs: false

# 成员会话持久化:子进程重启后按 sessionId 恢复历史(P1 常驻语义)
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js "process.env.DSH_SESSION_ROOT ?? './.member-sessions'"
    compression: 'zstd'
${rpcBlock}
`
}

/** ACP 后端组合:官方 acp-agent 行(dsh-acp-demo)+ 与 SDK 版相同的叶子行 */
function acpComposition() {
  return `# dsh-orgos 成员子进程组合(生成自 presets/${presetId};M3.5 模板,ACP 后端)
# stdout 保留给 ACP JSON-RPC;组合必须放在可解析 harness 包的目录树内。
# 官方依据:examples/acp-agent/cordis.yml(rc.8 checkout);bin 用法 dsh-acp-demo --config <本文件>。

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: !!js process.env.DSH_MODEL ?? 'deepseek-v4-flash'
        contextWindow: !!js Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)

- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'

- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-write
    workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()

- id: subprocess
  name: '@deepseek-ai/dsh-subprocess-local'

- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'
  config:
    timeoutMs: 60000

# 审批:触发时经 ACP requestPermission 回调由父侧策略应答(fail-closed 默认拒绝)
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: ask

- id: tools
  name: '@deepseek-ai/dsh-tools'

# ACP 自动化 app:agent spine + JSONL 持久化 + 协议桥
- id: acp-agent
  name: '@deepseek-ai/dsh-acp-demo'
  config:
    provider: deepseek-official
    model: !!js process.env.DSH_MODEL ?? 'deepseek-v4-flash'
    persistenceRoot: !!js process.env.DSH_SESSION_ROOT ?? './.member-sessions'
    persistenceCompression: zstd
    workspaceContext:
      maxBytes: 65536
    persona: >-
${persona.split('\n').map((l) => '      ' + l).join('\n')}
${rpcBlock}
`
}

writeFileSync(outPath, composition)
console.log(`生成:${outPath}(preset=${presetId}, backend=${backend}, rpc=${withRpc ? 'on' : 'off'}, persona ${persona.length} 字)`)
