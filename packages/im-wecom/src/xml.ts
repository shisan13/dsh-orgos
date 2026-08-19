/**
 * 轻量 XML 解析(企业微信回调专用:结构固定,无需完整解析器)
 *
 * 支持 <tag>text</tag> 与 <tag><![CDATA[text]]></tag>;
 * 返回 Map<tag, text>;同名重复标签(如多个 item)不在此支持(回调结构无此形态)。
 * 纯函数。
 */

/** 解析回调 XML → 标签值表(标签名 → 内容,CDATA 优先) */
export function parseXmlTags(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  // 叶子标签:内容由非 '<' 字符或完整 CDATA 块组成(外层包裹标签因内容含 '<' 自然不匹配)
  const tagRe = /<(\w+)>((?:[^<]|<!\[CDATA\[[\s\S]*?\]\]>)*?)<\/\1>/g
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(xml)) !== null) {
    const tag = match[1] ?? ''
    const raw = match[2] ?? ''
    const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw)
    const value = cdata !== null && cdata[1] !== undefined ? cdata[1] : raw
    map.set(tag, value.trim())
  }
  return map
}

/** 从 XML 取单个标签值(无则 undefined) */
export function xmlTag(xml: string, tag: string): string | undefined {
  return parseXmlTags(xml).get(tag)
}

/** 包装 URL 验证响应(encrypt 密文 → 回调 XML 信封) */
export function wrapVerifyXml(encryptBase64: string, timestamp: string, nonce: string, msgSignature: string): string {
  return `<xml><Encrypt><![CDATA[${encryptBase64}]]></Encrypt><MsgSignature><![CDATA[${msgSignature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`
}
