/**
 * Digest —— 回执流摘要压缩(技术设计 §4.6.1 回执流;FR-F2)
 *
 * 规则:向上汇报带结论+指标+验证输出,细节留在本层,上层按需下钻(team_status)。
 * digest 由引擎按**规则模板生成(确定性)**,非模型自由发挥——模型只做决策。
 *
 * 报告结构约定(成员遵循,引擎解析):
 *   ## 结论   摘要结论(缺省取首行)
 *   ## 指标   - 名称: 值(每行一个)
 *   ## 验证   验证输出(命令输出/测试结果,缺省空)
 * 折叠(foldDigests):每层折叠一次 —— 子 digest 的结论并列 + 指标汇总 + 验证摘要,天然形成摘要链。
 */
export interface DigestMetric {
  name: string
  value: string
}

export interface Digest {
  conclusion: string
  metrics: DigestMetric[]
  verification: string
  /** 细节所在位置(上层按需下钻) */
  detailsRef: { kind: 'delegation' | 'mail' | 'task'; id: string }
  generatedAt: number
}

export interface DigestOptions {
  /** 结论最大长度(默认 200 字符,超出截断加 …) */
  maxConclusionLength?: number
  /** 折叠时每层最多并列子 digest 数(默认 20,超出合并计数) */
  maxFoldChildren?: number
}

export const REPORT_SECTIONS = ['结论', '指标', '验证'] as const

/** 解析结构化报告 → Digest(确定性规则;缺省段取默认) */
export function buildDigest(report: string, ref: Digest['detailsRef'], opts?: DigestOptions): Digest {
  const maxLen = opts?.maxConclusionLength ?? 200
  const sections = splitSections(report)
  const conclusionRaw = sections.get('结论') ?? firstLine(report)
  const conclusion = clip(conclusionRaw, maxLen)
  const metrics = parseMetrics(sections.get('指标'))
  const verification = clip(sections.get('验证') ?? '', 400)
  return { conclusion, metrics, verification, detailsRef: ref, generatedAt: Date.now() }
}

/** 逐层折叠:子 digest 结论并列 + 指标汇总 + 验证行数摘要(摘要链的机器化) */
export function foldDigests(children: Digest[], ref: Digest['detailsRef'], opts?: DigestOptions): Digest {
  const maxLen = opts?.maxConclusionLength ?? 200
  const maxChildren = opts?.maxFoldChildren ?? 20
  const shown = children.slice(0, maxChildren)
  const hidden = children.length - shown.length
  const lines = shown.map((c, i) => `- [${i + 1}] ${c.conclusion}`)
  if (hidden > 0) lines.push(`- …另有 ${hidden} 个子报告未展开`)
  const conclusion = clip(lines.join('\n'), maxLen)
  // 指标汇总:同名指标求和(数值),否则并列
  const metricMap = new Map<string, string[]>()
  for (const c of shown) {
    for (const m of c.metrics) {
      const list = metricMap.get(m.name) ?? []
      list.push(m.value)
      metricMap.set(m.name, list)
    }
  }
  const metrics: DigestMetric[] = [...metricMap.entries()].map(([name, values]) => {
    const nums = values.map((v) => Number(v)).filter((n) => Number.isFinite(n))
    if (nums.length > 0 && nums.length === values.length) {
      const sum = nums.reduce((a, b) => a + b, 0)
      return { name, value: String(sum) }
    }
    return { name, value: values.join(' / ') }
  })
  const verifyCount = shown.filter((c) => c.verification.length > 0).length
  const verification = verifyCount === 0 ? '' : `${verifyCount}/${shown.length} 个子报告附验证输出`
  return { conclusion, metrics, verification, detailsRef: ref, generatedAt: Date.now() }
}

/** 按 '## 段名' 分割报告(大小写不敏感) */
function splitSections(report: string): Map<string, string> {
  const map = new Map<string, string>()
  const lines = report.split(/\r?\n/)
  let current: string | undefined
  for (const line of lines) {
    const m = /^##\s*(\S+)\s*$/.exec(line.trim())
    if (m) {
      current = m[1] ?? ''
      map.set(current, '')
      continue
    }
    if (current !== undefined) {
      map.set(current, (map.get(current) ?? '') + line + '\n')
    }
  }
  for (const key of [...map.keys()]) {
    const value = map.get(key)
    if (value !== undefined) map.set(key, value.trim())
  }
  return map
}

/** 指标行解析:'- 名称: 值' 或 '名称: 值' */
function parseMetrics(raw: string | undefined): DigestMetric[] {
  if (!raw) return []
  const out: DigestMetric[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.replace(/^[-*]\s*/, '').trim()
    if (!t) continue
    const idx = t.indexOf(':')
    if (idx <= 0) continue
    out.push({ name: t.slice(0, idx).trim(), value: t.slice(idx + 1).trim() })
  }
  return out
}

function firstLine(report: string): string {
  const line = report.split(/\r?\n/).find((l) => l.trim().length > 0)
  return line?.trim() ?? ''
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
