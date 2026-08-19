/**
 * dsh-orgos-ui Node 半(host 行 name 'dsh-orgos-ui' 加载入口)。
 * 浏览器半在 ./client(client-modules 按 exports['./client'] 扫描装载)。
 * Node 半仅作为 roster 挂载点,无 host 行为。
 */
export const name = 'dsh-orgos-ui'

export function apply(): void {}
