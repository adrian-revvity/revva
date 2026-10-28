#!/usr/bin/env node
/**
 * Re-shoot the README screenshots in docs/images/ from the running app.
 * Launch the app with a debug port first, then run this:
 *   pnpm exec electron-vite dev -- --remote-debugging-port=9223
 *   node scripts/shot-readme.mjs
 * It clicks through sidebar views over CDP and saves Page.captureScreenshot PNGs.
 * NOTE: shots contain the developer's real Jira/GitHub data — review before committing.
 */
import { writeFileSync } from 'node:fs'

const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id !== undefined && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
}
const send = (method, params = {}) =>
  new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })) })
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const click = (expr) => evalJs(`(() => {
  const el = (${expr});
  if (!el) return 'not found';
  el.click();
  return 'clicked';
})()`)

const byExact = (text) => click(`(() => {
  const hits = [...document.querySelectorAll('button')].filter(e => e.textContent.trim() === ${JSON.stringify(text)} && e.offsetParent !== null);
  return hits[0] || null;
})()`)

const bySidebarPrefix = (prefix) => click(`(() => {
  const hits = [...document.querySelectorAll('aside button')].filter(e => e.textContent.trim().startsWith(${JSON.stringify(prefix)}));
  return hits[0] || null;
})()`)

async function shot(name, waitMs = 1200) {
  await sleep(waitMs)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`docs/images/${name}.png`, Buffer.from(r.data, 'base64'))
  console.log(`shot docs/images/${name}.png`)
}

await send('Page.enable')
await send('Runtime.enable')

// Dismiss the New chat dialog if open.
console.log('cancel dialog:', await byExact('Cancel'))
await sleep(300)

console.log('dashboard:', await byExact('Dashboard')); await shot('dashboard')
console.log('jira:', await byExact('Jira')); await shot('jira')
console.log('github:', await byExact('GitHub')); await shot('github')
console.log('scripts:', await byExact('Scripts')); await shot('scripts')
console.log('cockpit:', await bySidebarPrefix('CLN-')); await shot('cockpit', 2500)

ws.close()
process.exit(0)
