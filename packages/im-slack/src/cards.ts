/**
 * Slack 卡片渲染(Block Kit,技术设计 §4.7.1 / §9.3)
 *
 * blocks:header + section(mrkdwn)+ actions(按钮 value 携带紧凑 JSON);
 * 纯函数,fixture 可测。
 */
import type { ApprovalCard, QuestionCard, TaskCard } from 'dsh-orgos-im-gateway'

export type AnyCard = ApprovalCard | QuestionCard | TaskCard

export interface SlackBlock {
  type: string
  [key: string]: unknown
}

export interface SlackCardPayload {
  blocks: SlackBlock[]
}

export function renderCard(card: AnyCard): SlackCardPayload {
  const buttons: { text: string; value: string; action_id: string; style?: string }[] = []
  switch (card.kind) {
    case 'approval':
      buttons.push(
        { text: '允许', value: JSON.stringify({ a: card.approvalId, act: 'allow' }), action_id: 'approval_allow', style: 'primary' },
        { text: '拒绝', value: JSON.stringify({ a: card.approvalId, act: 'deny' }), action_id: 'approval_deny', style: 'danger' },
      )
      break
    case 'question': {
      const labels: Record<string, string> = { agree: '同意', reject: '驳回', modify: '修改' }
      for (const opt of card.options) {
        buttons.push({ text: labels[opt] ?? opt, value: JSON.stringify({ q: card.questionId, act: opt }), action_id: `question_${opt}` })
      }
      break
    }
    case 'task': {
      const labels: Record<string, string> = { accept: '接受', reject: '拒绝', report: '完成汇报' }
      for (const action of card.actions) {
        buttons.push({ text: labels[action] ?? action, value: JSON.stringify({ t: card.taskId, act: action }), action_id: `task_${action}` })
      }
      break
    }
  }
  return {
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: card.title } },
      { type: 'section', text: { type: 'mrkdwn', text: card.body } },
      {
        type: 'actions',
        elements: buttons.map((b) => ({
          type: 'button',
          text: { type: 'plain_text', text: b.text },
          value: b.value,
          action_id: b.action_id,
          ...(b.style !== undefined ? { style: b.style } : {}),
        })),
      },
    ],
  }
}
