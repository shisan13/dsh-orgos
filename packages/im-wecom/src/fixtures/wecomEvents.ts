/**
 * 企业微信回调 fixture(record-replay;加密/验签向量自生成,测试内联计算)
 */

/** 固定 43 字符 encodingAESKey(测试专用,非真实凭据) */
export const TEST_AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
/** 测试 corpId/token(非真实) */
export const TEST_CORP_ID = 'ww_test_corp_123'
export const TEST_TOKEN = 'testToken123'
export const TEST_AGENT_ID = '1000002'
export const TEST_BOT_NAME = 'orgos-bot'

/** 明文文本消息 XML(私聊) */
export const plainTextXml = `<xml>
<ToUserName><![CDATA[ww_test_corp_123]]></ToUserName>
<FromUserName><![CDATA[zhangsan]]></FromUserName>
<CreateTime>1720000000</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[你好]]></Content>
<MsgId>1234567890</MsgId>
<AgentID>1000002</AgentID>
</xml>`

/** 群 @bot 文本消息 XML */
export const plainGroupMentionXml = `<xml>
<ToUserName><![CDATA[ww_test_corp_123]]></ToUserName>
<FromUserName><![CDATA[lisi]]></FromUserName>
<CreateTime>1720000001</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[@orgos-bot 帮我查一下]]></Content>
<MsgId>1234567891</MsgId>
<AgentID>1000002</AgentID>
</xml>`

/** 图片消息 XML */
export const imageXml = `<xml>
<ToUserName><![CDATA[ww_test_corp_123]]></ToUserName>
<FromUserName><![CDATA[zhangsan]]></FromUserName>
<CreateTime>1720000002</CreateTime>
<MsgType><![CDATA[image]]></MsgType>
<PicUrl><![CDATA[http://example.com/pic]]></PicUrl>
<MediaId><![CDATA[media_abc]]></MediaId>
<MsgId>1234567892</MsgId>
<AgentID>1000002</AgentID>
</xml>`

/** 卡片按钮回调 XML(template_card_event) */
export const cardEventXml = `<xml>
<ToUserName><![CDATA[ww_test_corp_123]]></ToUserName>
<FromUserName><![CDATA[zhangsan]]></FromUserName>
<CreateTime>1720000003</CreateTime>
<MsgType><![CDATA[event]]></MsgType>
<Event><![CDATA[template_card_event]]></Event>
<EventKey><![CDATA[{"a":"ap_1","act":"allow"}]]></EventKey>
<MsgId>1234567893</MsgId>
<AgentID>1000002</AgentID>
</xml>`

/** 忽略事件(非按钮) */
export const ignoredEventXml = `<xml>
<ToUserName><![CDATA[ww_test_corp_123]]></ToUserName>
<FromUserName><![CDATA[zhangsan]]></FromUserName>
<CreateTime>1720000004</CreateTime>
<MsgType><![CDATA[event]]></MsgType>
<Event><![CDATA[subscribe]]></Event>
<MsgId>1234567894</MsgId>
<AgentID>1000002</AgentID>
</xml>`

/** 密文回调信封 XML */
export function envelopeXml(encryptBase64: string): string {
  return `<xml><ToUserName><![CDATA[ww_test_corp_123]]></ToUserName><Encrypt><![CDATA[${encryptBase64}]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>`
}
