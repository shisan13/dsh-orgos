/**
 * WhatsApp 卡片渲染(interactive buttons,技术设计 §4.7.1 / §9.3)
 *
 * 按钮 reply.id 携带紧凑 JSON(≤256 字符);纯函数,fixture 可测。
 */
import type { ApprovalCard, QuestionCard, TaskCard } from 'dsh-orgos-im-gateway'

export type AnyCard = ApprovalCard | QuestionCard | TaskCard

export interface WhatsappButton {
  type: 'reply'
  reply: { id: string; title: string }
}

export interface WhatsappCardPayload {
  messaging_product: 'whatsapp'
  recipient_type: 'individual'
  type: 'interactive'
  interactive: {
    type: 'button'
    body: { text: string }
    action: { buttons: WhatsappButton[] }
  }
}

export function renderCard(card: AnyCard): WhatsappCardPayload {
  const buttons: WhatsappButton[] = []
  switch (card.kind) {
    case 'approval':
      buttons.push(
        { type: 'reply', reply: { id: JSON.stringify({ a: card.approvalId, act: 'allow' }), title: '允许' } },
        { type: 'reply', reply: { id: JSON.stringify({ a: card.approvalId, act: 'deny' }), title: '拒绝' } },
      )
      break
    case 'question': {
      const labels: Record<string, string> = { agree: '同意', reject: '驳回', modify: '修改' }
      for (const opt of card.options) {
        buttons.push({ type: 'reply', reply: { id: JSON.stringify({ q: card.questionId, act: opt }), title: labels[opt] ?? opt } })
      }
      break
    }
    case 'task': {
      const labels: Record<string, string> = { accept: '接受', reject: '拒绝', report: '完成汇报' }
      for (const action of card.actions) {
        buttons.push({ type: 'reply', reply: { id: JSON.stringify({ t: card.taskId, act: action }), title: labels[action] ?? action } })
      }
      break
    }
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `${card.title}\n${card.body}` },
      action: { buttons },
    },
  }
}
