/**
 * Telegram 长消息分段(§9.1:sendMessage 单条 ≤4096 字符)
 *
 * - 超长按行边界分段,代码块整体保留;
 * - MD 表格 → 列表(Telegram 文本不支持表格);
 * - 行内 LaTeX → 代码块(飞书坑点知识的通用化)。
 * 纯函数,fixture 可测。
 */

export interface SegmentOptions {
  maxLength?: number
}

export interface TextSegment {
  reason: 'length' | 'table' | 'latex'
  text: string
}

export const TELEGRAM_MAX = 4096

export function segmentText(raw: string, opts?: SegmentOptions): TextSegment[] {
  const maxLength = opts?.maxLength ?? TELEGRAM_MAX
  const preprocessed = convertLatex(convertTables(raw))
  return splitByLength(preprocessed, maxLength)
}

/** MD 表格 → 列表(表头加粗、分隔行丢弃) */
export function convertTables(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  let tableRowIndex = -1
  for (const line of lines) {
    const trimmed = line.trim()
    const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|')
    const isSeparator = /^\|[\s:|-]+\|$/.test(trimmed)
    if (isTableRow) {
      if (isSeparator) continue
      tableRowIndex += 1
      const cells = trimmed.replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const bullet = cells.map((c) => (tableRowIndex === 0 ? `**${c}**` : c)).join(' | ')
      out.push(`• ${bullet}`)
    } else {
      tableRowIndex = -1
      out.push(line)
    }
  }
  return out.join('\n')
}

/** LaTeX → 代码块(块级 $$ 与行内 $) */
export function convertLatex(text: string): string {
  const t = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, body: string) => `\`\`\`math\n${body.trim()}\n\`\`\``)
  return t.replace(/`{3}[\s\S]*?`{3}|(?<!\$)\$([^$\n]+)\$(?!\$)/g, (m, body?: string) => {
    if (m.startsWith('```')) return m
    return body !== undefined ? `\`${body.trim()}\`` : m
  })
}

/** 按块边界分段(优先换行;代码块不拆;超长硬切) */
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
  const slice = text.slice(0, maxLength)
  const lastNewline = slice.lastIndexOf('\n')
  const cut = lastNewline > maxLength / 2 ? lastNewline + 1 : maxLength
  const chunk = text.slice(0, cut)
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
