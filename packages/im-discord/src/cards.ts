/**
 * Discord 卡片渲染(embed + components,技术设计 §4.7.1 / §9.3)
 *
 * 按钮 = components(行 type=1 内放 type=2 按钮);custom_id 携带紧凑 JSON
 * (≤100 字符限制);纯函数,fixture 可测。
 */
import type { ApprovalCard, QuestionCard, TaskCard } from 'dsh-orgos-im-gateway'

export type AnyCard = ApprovalCard | QuestionCard | TaskCard

export interface DiscordButton {
  type: 2
  style: 1 | 2 | 3 | 4
  custom_id: string
  label: string
}

export interface DiscordCardPayload {
  embeds: { title: string; description: string }[]
  components: { type: 1; components: DiscordButton[] }[]
}

export function renderCard(card: AnyCard): DiscordCardPayload {
  const buttons: DiscordButton[] = []
  switch (card.kind) {
    case 'approval':
      buttons.push(
        { type: 2, style: 3, custom_id: JSON.stringify({ a: card.approvalId, act: 'allow' }), label: '允许' },
        { type: 2, style: 4, custom_id: JSON.stringify({ a: card.approvalId, act: 'deny' }), label: '拒绝' },
      )
      break
    case 'question': {
      const labels: Record<string, string> = { agree: '同意', reject: '驳回', modify: '修改' }
      for (const opt of card.options) {
        buttons.push({
          type: 2,
          style: opt === 'reject' ? 4 : 1,
          custom_id: JSON.stringify({ q: card.questionId, act: opt }),
          label: labels[opt] ?? opt,
        })
      }
      break
    }
    case 'task': {
      const labels: Record<string, string> = { accept: '接受', reject: '拒绝', report: '完成汇报' }
      for (const action of card.actions) {
        buttons.push({
          type: 2,
          style: action === 'reject' ? 4 : action === 'accept' ? 3 : 1,
          custom_id: JSON.stringify({ t: card.taskId, act: action }),
          label: labels[action] ?? action,
        })
      }
      break
    }
  }
  return {
    embeds: [{ title: card.title, description: card.body }],
    components: [{ type: 1, components: buttons }],
  }
}
