/**
 * 企业微信卡片渲染(技术设计 §4.7.1 / §9.3)
 *
 * 企业微信应用消息 textcard(主动发送形态;绑定层调 send 接口):
 * - 按钮回调:template_card 需要 TaskId/按钮 key —— textcard 形态下用
 *   「点击跳转 + 回调事件」不适用,故按钮语义收敛为 template_card:
 *   main_title + horizontal_content + card_action + button_selection,
 *   button_selection[].key 携带紧凑 JSON {a, act}(EventKey 回传)。
 * 纯函数,fixture 可测。
 */
import type { ApprovalCard, QuestionCard, TaskCard } from 'dsh-orgos-im-gateway'

export type AnyCard = ApprovalCard | QuestionCard | TaskCard

export interface WecomTemplateCard {
  card_type: 'text_notice' | 'button_interaction'
  source: { icon_url?: string; desc: string }
  main_title: { title: string; desc: string }
  horizontal_content_list?: { keyname: string; value: string }[]
  task_id: string
  button_selection?: { question_key: string; option_list: { id: string; text: string }[] }[]
  button_list?: { text: string; style: number; key: string }[]
}

export interface WecomCardPayload {
  touser: string
  msgtype: 'template_card'
  agentid: number
  template_card: WecomTemplateCard
}

/** 统一渲染入口(按钮语义全部走 template_card button_list) */
export function renderCard(card: AnyCard): Omit<WecomCardPayload, 'touser' | 'agentid'> {
  return renderAny(card)
}

/** 具名导出(与 im-feishu 导出面一致) */
export function renderApprovalCard(card: ApprovalCard): Omit<WecomCardPayload, 'touser' | 'agentid'> {
  return renderAny(card)
}

export function renderQuestionCard(card: QuestionCard): Omit<WecomCardPayload, 'touser' | 'agentid'> {
  return renderAny(card)
}

export function renderTaskCard(card: TaskCard): Omit<WecomCardPayload, 'touser' | 'agentid'> {
  return renderAny(card)
}

function renderAny(card: AnyCard): Omit<WecomCardPayload, 'touser' | 'agentid'> {
  const base = {
    msgtype: 'template_card' as const,
    template_card: {
      card_type: 'button_interaction' as const,
      source: { desc: 'dsh-orgos' },
      main_title: { title: card.title, desc: card.body },
      task_id: `${card.kind}-${cardIdOf(card)}`,
    },
  }
  switch (card.kind) {
    case 'approval':
      return {
        ...base,
        template_card: {
          ...base.template_card,
          button_list: [
            { text: '允许', style: 1, key: JSON.stringify({ a: card.approvalId, act: 'allow' }) },
            { text: '拒绝', style: 3, key: JSON.stringify({ a: card.approvalId, act: 'deny' }) },
          ],
        },
      }
    case 'question': {
      const labels: Record<string, string> = { agree: '同意', reject: '驳回', modify: '修改' }
      return {
        ...base,
        template_card: {
          ...base.template_card,
          button_list: card.options.map((opt, i) => ({
            text: labels[opt] ?? opt,
            style: opt === 'reject' ? 3 : 1,
            key: JSON.stringify({ q: card.questionId, act: opt, i }),
          })),
        },
      }
    }
    case 'task': {
      const labels: Record<string, string> = { accept: '接受', reject: '拒绝', report: '完成汇报' }
      return {
        ...base,
        template_card: {
          ...base.template_card,
          button_list: card.actions.map((a) => ({
            text: labels[a] ?? a,
            style: a === 'reject' ? 3 : 1,
            key: JSON.stringify({ t: card.taskId, act: a }),
          })),
        },
      }
    }
  }
}

function cardIdOf(card: AnyCard): string {
  switch (card.kind) {
    case 'approval':
      return card.approvalId
    case 'question':
      return card.questionId
    case 'task':
      return card.taskId
  }
}
