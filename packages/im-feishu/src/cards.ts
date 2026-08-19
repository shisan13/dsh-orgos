/**
 * 卡片渲染:任务卡/决策卡/审批卡 → 飞书卡片 JSON(技术设计 §4.7.1 / §9.3)
 *
 * - 审批卡(ApprovalCard):Allow/Deny 按钮,value 携带 approvalId + action(T6 一次性);
 * - 决策卡(QuestionCard):同意/驳回/修改;
 * - 任务卡(TaskCard):接受/拒绝/完成汇报。
 * 纯函数,fixture 可测;按钮 value 为卡片回调的判定依据(card.action.trigger)。
 */
import type { ApprovalCard, QuestionCard, TaskCard } from 'dsh-orgos-im-gateway'

export type AnyCard = ApprovalCard | QuestionCard | TaskCard

export interface LarkCardElement {
  tag: string
  [key: string]: unknown
}

export interface LarkCardJson {
  config: { wide_screen_mode: boolean }
  header?: { title: { tag: 'plain_text'; content: string } }
  elements: LarkCardElement[]
}

/** 统一渲染入口:kind → 飞书卡片 JSON */
export function renderCard(card: AnyCard): LarkCardJson {
  switch (card.kind) {
    case 'approval':
      return renderApprovalCard(card)
    case 'question':
      return renderQuestionCard(card)
    case 'task':
      return renderTaskCard(card)
  }
}

/** 审批卡(§9.3):Allow/Deny,value 携带 approvalId */
export function renderApprovalCard(card: ApprovalCard): LarkCardJson {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: card.title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: card.body } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '允许' },
            type: 'primary',
            value: JSON.stringify({ approvalId: card.approvalId, action: 'allow' }),
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: JSON.stringify({ approvalId: card.approvalId, action: 'deny' }),
          },
        ],
      },
    ],
  }
}

/** 决策卡(FR-H6):同意/驳回/修改 */
export function renderQuestionCard(card: QuestionCard): LarkCardJson {
  const labels: Record<string, string> = { agree: '同意', reject: '驳回', modify: '修改' }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: card.title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: card.body } },
      {
        tag: 'action',
        actions: card.options.map((opt) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: labels[opt] ?? opt },
          type: opt === 'reject' ? 'danger' : 'primary',
          value: JSON.stringify({ questionId: card.questionId, action: opt }),
        })),
      },
    ],
  }
}

/** 任务卡(FR-H3):接受/拒绝/完成汇报(deadline 展示) */
export function renderTaskCard(card: TaskCard): LarkCardJson {
  const buttons: Record<TaskCard['actions'][number], { label: string; type: string }> = {
    accept: { label: '接受', type: 'primary' },
    reject: { label: '拒绝', type: 'danger' },
    report: { label: '完成汇报', type: 'default' },
  }
  const deadlineLine = card.deadlineAt !== undefined
    ? `\n截止时间:${new Date(card.deadlineAt).toLocaleString('zh-CN')}`
    : ''
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: card.title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `${card.body}${deadlineLine}` } },
      {
        tag: 'action',
        actions: card.actions.map((a) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: buttons[a].label },
          type: buttons[a].type,
          value: JSON.stringify({ taskId: card.taskId, action: a }),
        })),
      },
    ],
  }
}
