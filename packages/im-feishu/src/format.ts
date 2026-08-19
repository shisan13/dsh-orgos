/**
 * 长消息分段(openclaw 飞书坑点知识库的机器化,技术设计 §9.1)
 *
 * 规则(沉淀自 openclaw 生产踩坑):
 * - 飞书文本不支持 Markdown 表格 → 转换为列表;
 * - LaTeX($...$ / $$...$$)→ 代码块(飞书原生渲染乱码);
 * - 超长文本按块边界分段(默认每段 ≤3000 字符),代码块单独成段不被拆开;
 * - 分段保持顺序,适配器逐段发送(块逐节追加语义)。
 * 纯函数,fixture 可测。
 */

export interface SegmentOptions {
  /** 单段最大长度(默认 3000;飞书文本消息上限附近) */
  maxLength?: number
}

export interface TextSegment {
  /** 分段原因:length(超长)/ table(表格转换)/ latex(公式转换) */
  reason: 'length' | 'table' | 'latex'
  text: string
}

/** 预处理 + 分段:返回有序段列表 */
export function segmentText(raw: string, opts?: SegmentOptions): TextSegment[] {
  const maxLength = opts?.maxLength ?? 3000
  const preprocessed = convertLatex(convertTables(raw))
  return splitByLength(preprocessed, maxLength)
}

/** MD 表格 → 列表(表头加粗、分隔行丢弃、每行转 '• 单元格1 | 单元格2') */
export function convertTables(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let tableRowIndex = -1
  for (const line of lines) {
    const trimmed = line.trim()
    const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|')
    const isSeparator = /^\|[\s:|-]+\|$/.test(trimmed)
    if (isTableRow) {
      // 分隔行(| --- |)丢弃,但不重置表格行计数
      if (isSeparator) continue
      tableRowIndex += 1
      const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      // 第一行(表头)加粗
      const bullet = cells.map((c) => (tableRowIndex === 0 ? `**${c}**` : c)).join(' | ')
      out.push(`• ${bullet}`)
    } else {
      tableRowIndex = -1
      out.push(line)
    }
  }
  return out.join('\n')
}

/** LaTeX → 代码块(```math ... ```);行内 $x$ 与块级 $$...$$ 都处理 */
export function convertLatex(text: string): string {
  // 块级 $$...$$
  let t = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body: string) => `\`\`\`math\n${body.trim()}\n\`\`\``)
  // 行内 $...$(避免误伤代码块内的 $)
  t = t.replace(/`{3}[\s\S]*?`{3}|(?<!\$)\$([^$\n]+)\$(?!\$)/g, (m, body?: string) => {
    if (m.startsWith('```')) return m
    return body !== undefined ? `\`${body.trim()}\`` : m
  })
  return t
}

/** 按块边界分段(优先在换行处断;代码块整体保留;超长兜底硬切) */
export function splitByLength(text: string, maxLength: number): TextSegment[] {
  if (text.length <= maxLength) {
    return [{ reason: 'length', text }]
  }
  const segments: TextSegment[] = []
  let rest = text
  while (rest.length > maxLength) {
    const chunk = takeChunk(rest, maxLength)
    segments.push({ reason: chunk.reason, text: chunk.text })
    rest = chunk.rest
  }
  if (rest.length > 0) {
    segments.push({ reason: 'length', text: rest })
  }
  return segments
}

function takeChunk(text: string, maxLength: number): { reason: 'length' | 'table' | 'latex'; text: string; rest: string } {
  // 优先在最近的换行处断开(保持行完整)
  const slice = text.slice(0, maxLength)
  const lastNewline = slice.lastIndexOf('\n')
  const cut = lastNewline > maxLength / 2 ? lastNewline + 1 : maxLength
  const chunk = text.slice(0, cut)
  // 代码块完整性:若 chunk 以未闭合的 ``` 结束,延长到闭合处
  const fences = (chunk.match(/```/g) ?? []).length
  if (fences % 2 === 1) {
    const close = text.indexOf('```', cut)
    if (close !== -1) {
      const extended = text.slice(0, close + 3)
      if (extended.length <= maxLength * 2) {
        return { reason: 'latex', text: extended, rest: text.slice(close + 3) }
      }
    }
  }
  return { reason: 'length', text: chunk, rest: text.slice(cut) }
}
