/**
 * Telegram 卡片渲染(技术设计 §4.7.1 / §9.3)
 *
 * Telegram 无原生卡片:按钮 = InlineKeyboardMarkup,
 * callback_data 携带紧凑 JSON(callback_data ≤64 字节 → 键用单字符 {a, act, t, q})。
 * 纯函数,fixture 可测。
 */
import type { ApprovalCard, QuestionCard, TaskCard } from 'dsh-orgos-im-gateway'

export type AnyCard = ApprovalCard | QuestionCard | TaskCard

export interface TelegramInlineButton {
  text: string
  callback_data: string
}

export interface TelegramCardPayload {
  text: string
  reply_markup?: { inline_keyboard: TelegramInlineButton[][] }
}

export function renderCard(card: AnyCard): TelegramCardPayload {
  switch (card.kind) {
    case 'approval':
      return renderApprovalCard(card)
    case 'question':
      return renderQuestionCard(card)
    case 'task':
      return renderTaskCard(card)
  }
}

/** 审批卡:允许/拒绝(callback_data: {a, act}) */
export function renderApprovalCard(card: ApprovalCard): TelegramCardPayload {
  return {
    text: `${card.title}\n${card.body}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '允许', callback_data: JSON.stringify({ a: card.approvalId, act: 'allow' }) },
          { text: '拒绝', callback_data: JSON.stringify({ a: card.approvalId, act: 'deny' }) },
        ],
      ],
    },
  }
}

/** 决策卡:同意/驳回/修改 */
export function renderQuestionCard(card: QuestionCard): TelegramCardPayload {
  const labels: Record<string, string> = { agree: '同意', reject: '驳回', modify: '修改' }
  return {
    text: `${card.title}\n${card.body}`,
    reply_markup: {
      inline_keyboard: [
        card.options.map((opt) => ({
          text: labels[opt] ?? opt,
          callback_data: JSON.stringify({ q: card.questionId, act: opt }),
        })),
      ],
    },
  }
}

/** 任务卡:接受/拒绝/完成汇报 */
export function renderTaskCard(card: TaskCard): TelegramCardPayload {
  const buttons: Record<TaskCard['actions'][number], string> = {
    accept: '接受',
    reject: '拒绝',
    report: '完成汇报',
  }
  const deadline = card.deadlineAt !== undefined ? `\n截止时间:${new Date(card.deadlineAt).toLocaleString('zh-CN')}` : ''
  return {
    text: `${card.title}\n${card.body}${deadline}`,
    reply_markup: {
      inline_keyboard: [
        card.actions.map((a) => ({
          text: buttons[a],
          callback_data: JSON.stringify({ t: card.taskId, act: a }),
        })),
      ],
    },
  }
}
