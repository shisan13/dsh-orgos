/**
 * 企业微信智能机器人回调加密协议(安全设计 §6:✅ AES 解密验签)
 *
 * - 验签:msg_signature = SHA1(sort([token, timestamp, nonce, encrypt]).join(''))
 * - 解密:AES-256-CBC;encodingAESKey(43 字符 base64 + '=')= 44 → 32 字节 key;
 *   iv = key 前 16 字节;明文 = random(16B) + msgLen(4B, big-endian) + msg + receiveId
 * - 加密(URL 验证响应/主动回复):random(16B) + len(4B) + msg + receiveId → AES-CBC → base64
 * 纯函数(node:crypto),fixture 可测。
 */
import { createDecipheriv, createCipheriv, createHash, randomBytes } from 'node:crypto'

export interface WecomCryptoConfig {
  /** 回调 token */
  token: string
  /** encodingAESKey(43 字符) */
  encodingAESKey: string
  /** corpId(解密尾部的 receiveId 校验) */
  corpId: string
}

/** 计算 msg_signature(确定性,SHA1) */
export function signature(token: string, timestamp: string, nonce: string, encrypt: string): string {
  const sorted = [token, timestamp, nonce, encrypt].sort().join('')
  return createHash('sha1').update(sorted, 'utf8').digest('hex')
}

/** 验签:返回是否一致 */
export function verifySignature(config: WecomCryptoConfig, timestamp: string, nonce: string, encrypt: string, msgSignature: string): boolean {
  return signature(config.token, timestamp, nonce, encrypt) === msgSignature
}

/** 解密回调密文 → 明文(校验 receiveId;失败抛 WecomCryptoError) */
export function decrypt(config: WecomCryptoConfig, encryptBase64: string): string {
  const { key, iv } = deriveKey(config.encodingAESKey)
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    plain = Buffer.concat([decipher.update(Buffer.from(encryptBase64, 'base64')), decipher.final()])
  } catch (err) {
    throw new WecomCryptoError(`AES 解密失败:${err instanceof Error ? err.message : String(err)}`)
  }
  const msgLen = plain.readUInt32BE(16)
  if (msgLen < 0 || plain.length < 20 + msgLen) {
    throw new WecomCryptoError('明文长度非法')
  }
  const msg = plain.subarray(20, 20 + msgLen).toString('utf8')
  const receiveId = plain.subarray(20 + msgLen).toString('utf8')
  if (receiveId !== config.corpId) {
    throw new WecomCryptoError(`receiveId 不匹配:${receiveId}`)
  }
  return msg
}

/** 加密明文 → base64 密文(URL 验证响应) */
export function encrypt(config: WecomCryptoConfig, plain: string): string {
  const { key, iv } = deriveKey(config.encodingAESKey)
  const random = randomBytes(16)
  const msg = Buffer.from(plain, 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(msg.length)
  const receiveId = Buffer.from(config.corpId, 'utf8')
  const raw = Buffer.concat([random, len, msg, receiveId])
  const cipher = createCipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([cipher.update(raw), cipher.final()]).toString('base64')
}

/** URL 验证(安全设计 §6):验签 + 解密 echostr → 明文(绑定层回显) */
export function verifyUrl(config: WecomCryptoConfig, query: { msg_signature: string; timestamp: string; nonce: string; echostr: string }): string {
  if (!verifySignature(config, query.timestamp, query.nonce, query.echostr, query.msg_signature)) {
    throw new WecomCryptoError('URL 验证签名不匹配')
  }
  return decrypt(config, query.echostr)
}

function deriveKey(encodingAESKey: string): { key: Buffer; iv: Buffer } {
  if (encodingAESKey.length !== 43) {
    throw new WecomCryptoError(`encodingAESKey 长度必须为 43(实际 ${encodingAESKey.length})`)
  }
  const key = Buffer.from(`${encodingAESKey}=`, 'base64')
  if (key.length !== 32) {
    throw new WecomCryptoError(`encodingAESKey 解码后必须为 32 字节(实际 ${key.length})`)
  }
  return { key, iv: key.subarray(0, 16) }
}

export class WecomCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WecomCryptoError'
  }
}
