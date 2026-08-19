// 打包浏览器半:closure-factory 注册产物(官方 boot 协议)
// client.js = window.__ModuleLoader__.load({ id, factory: require => exports })
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'lib', 'client', 'index.js')
const result = await build({
  entryPoints: [join(here, '..', 'src', 'client', 'index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  jsx: 'automatic',
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-conversation/client',
  ],
  write: false,
  logLevel: 'silent',
})
const body = result.outputFiles[0].text
const indent = '    ' + body.replaceAll('\n', '\n    ')
const wrapper = `// dsh-orgos-ui client bundle(boot 协议:closure-factory 注册)
window.__ModuleLoader__.load({
  id: 'dsh-orgos-ui',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
${indent}
    return module.exports
  },
})
`
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, wrapper)
console.log('[dsh-orgos-ui] client bundle built')
