import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const BUILT_HTML = 'dist/attention-panel/index.html'
const GENERATED_MODULE = 'src/apps/attention/panel-html.ts'

execFileSync('npx', ['vite', 'build', '--config', 'vite.attention.config.ts'], {
  stdio: 'inherit'
})

const html = readFileSync(BUILT_HTML, 'utf8')
writeFileSync(GENERATED_MODULE, `export const ATTENTION_PANEL_HTML = ${JSON.stringify(html)}\n`)
console.log(`wrote ${GENERATED_MODULE} (${html.length} bytes)`)
