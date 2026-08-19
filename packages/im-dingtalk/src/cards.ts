/**
 * 钉钉卡片渲染(interactive 模板卡片,技术设计 §4.7.1 / §9.3)
 *
 * 钉钉机器人发「按钮交互卡片」需模板(template_id,开发者后台注册);
 * 本层渲染模板变量:title/desc + buttons(key 携带紧凑 JSON,经卡片回调 params 回传)。
 * 纯函数,fixture 可测。
 */
import type { ApprovalCard, QuestionCard, TaskCard } from 'dsh-orgos-im-gateway'

export type AnyCard = ApprovalCard | QuestionCard | TaskCard

export interface DingtalkButton {
  key: string
  text: string
}

export interface DingtalkCardPayload {
  msgtype: 'interactive'
  card: {
    type: 'template-card'
    data: {
      template_id: string
      template_variable: {
        title: string
        desc: string
        buttons: DingtalkButton[]
      }
    }
  }
}

/** 统一渲染(默认模板 id 可被绑定层覆盖) */
export function renderCard(card: AnyCard, templateId = 'dsh_orgos_action_card'): DingtalkCardPayload {
  const buttons: DingtalkButton[] = []
  switch (card.kind) {
    case 'approval':
      buttons.push(
        { key: JSON.stringify({ a: card.approvalId, act: 'allow' }), text: '允许' },
        { key: JSON.stringify({ a: card.approvalId, act: 'deny' }), text: '拒绝' },
      )
      break
    case 'question': {
      const labels: Record<string, string> = { agree: '同意', reject: '驳回', modify: '修改' }
      for (const opt of card.options) {
        buttons.push({ key: JSON.stringify({ q: card.questionId, act: opt }), text: labels[opt] ?? opt })
      }
      break
    }
    case 'task': {
      const labels: Record<string, string> = { accept: '接受', reject: '拒绝', report: '完成汇报' }
      for (const action of card.actions) {
        buttons.push({ key: JSON.stringify({ t: card.taskId, act: action }), text: labels[action] ?? action })
      }
      break
    }
  }
  return {
    msgtype: 'interactive',
    card: {
      type: 'template-card',
      data: {
        template_id: templateId,
        template_variable: { title: card.title, desc: card.body, buttons },
      },
    },
  }
}
