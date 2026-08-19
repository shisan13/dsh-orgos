/**
 * WhatsApp Business API webhook 验签(安全设计 §6:✅ X-Hub-Signature-256)
 *
 * X-Hub-Signature-256: `sha256=` + hex(HMAC-SHA256(appSecret, rawBody))
 * 纯函数(node:crypto),fixture 可测;验签失败 fail-closed(拒绝处理)。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** 计算签名头(测试/自校验用) */
export function computeHubSignature(appSecret: string, rawBody: string): string {
  const digest = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  return `sha256=${digest}`
}

/** 验签:常量时间比较,防时序攻击 */
export function verifyWebhookSignature(appSecret: string, rawBody: string, signatureHeader: string | undefined): boolean {
  if (typeof signatureHeader !== 'string') return false
  const expected = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader
  const computed = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')
  if (expected.length !== computed.length) return false
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(computed, 'utf8'))
}
