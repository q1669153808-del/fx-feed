#!/usr/bin/env node
/**
 * 招商银行外汇牌价 → fx.json（GitHub Actions 每 5 分钟跑一次）
 *
 * 为什么要有这个仓库：招行牌价接口没有 CORS 头，浏览器直接 fetch 会被拦。
 * 浏览器拦的是「响应里没给 access-control-allow-origin」，不是请求发不出去 ——
 * 所以只要有一台**在浏览器之外**的机器去取，再把结果放进一个带 CORS 的地方，
 * 前端就能拿到真牌价。raw.githubusercontent.com 实测带 `access-control-allow-origin: *`。
 *
 * 🔴 字段不要认错（第 197 轮踩过）：
 *   rtbBid = 基准价 ≈ 中间价
 *   rthBid = **现汇买入价**  ← 老板截图里对的就是这个
 *   rtcBid = 现钞买入价（偏低，别用）
 *
 * 数值是「每 100 外币兑人民币」（ccyExc=10），要除以 100。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const API = 'https://fx.cmbchina.com/api/v1/fx/rate?t='
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fx.json')
const TIMEOUT_MS = 20000

/** 8 位小数：JPY 是 0.0415945，截到 6 位就丢有效数字；USD 6.65906 也不受影响 */
const p8 = (x) => {
  const v = Number(x)
  return Number.isFinite(v) && v > 0 ? Number(v.toFixed(8)) : 0
}

/** `ccyNbrEng` 形如 "美元 USD"，取末尾代码；比维护中英对照表稳 */
function codeOf(r) {
  const m = String(r?.ccyNbrEng || '').trim().split(/\s+/).pop()
  return /^[A-Z]{3}$/.test(m) ? m : ''
}

/** "2026年11月16日" → "2026-11-16"；取不到就返回空串，交给调用方兜底 */
function isoDate(s) {
  const m = String(s || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/)
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''
}

async function main() {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  let json
  try {
    const r = await fetch(API + Date.now(), {
      signal: ac.signal,
      headers: { 'user-agent': 'fx-feed/1.0 (+https://github.com)' },
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    json = await r.json()
  } finally {
    clearTimeout(timer)
  }

  if (json?.returnCode !== 'SUC0000' || !Array.isArray(json?.body)) {
    throw new Error(`招行返回异常：${JSON.stringify(json).slice(0, 200)}`)
  }

  const bid = {}   // 现汇买入价（每 1 单位外币兑人民币）
  const mid = {}   // 基准价 ≈ 中间价，留着给跨币种记账用
  let d = ''
  let t = ''

  for (const row of json.body) {
    const code = codeOf(row)
    if (!code) continue
    const unit = String(row.ccyExc) === '10' ? 100 : 1
    const b = p8(Number(row.rthBid) / unit)
    const m = p8(Number(row.rtbBid) / unit)
    if (!b) continue
    bid[code] = b
    if (m) mid[code] = m
    if (!d) d = isoDate(row.ratDat)
    if (!t) t = String(row.ratTim || '')
  }

  if (!bid.USD) throw new Error(`没有美元牌价，整包丢弃：${JSON.stringify(json.body[0] || {})}`)

  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))
  const out = {
    d: d || new Date().toISOString().slice(0, 10),
    t,
    src: 'cmb',
    bid: sorted(bid),
    mid: sorted(mid),
    fetched: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  }

  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`ok  ${out.d} ${out.t}  ${Object.keys(bid).length} 币种  USD ${bid.USD}`)
}

main().catch((e) => {
  // 失败就让 Action 变红：宁可看到红灯，也不要悄悄提交一份空数据
  console.error('FAIL', e.message)
  process.exit(1)
})
