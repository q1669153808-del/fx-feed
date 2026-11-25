#!/usr/bin/env node
/**
 * 招商银行外汇牌价 → fx.json（GitHub Actions 每小时跑一次）
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

/**
 * 🔴 浏览器 UA（2026-11-25）：GitHub 的出口 IP 在海外，招行接口对非浏览器 UA
 * 偶尔直接拒绝（1 秒内挂掉，不是超时）。本机同样的代码 100% 成功，
 * 说明不是接口改版 —— 换成浏览器 UA 少一个被风控的点。
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function main() {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  let json
  try {
    const r = await fetch(API + Date.now(), {
      signal: ac.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        referer: 'https://fx.cmbchina.com/',
      },
    })
    if (!r.ok) {
      /* 把响应体前 160 字带上：招行拒绝时返回的是 HTML 拦截页，
         光看 `HTTP 403` 分不清是风控还是接口挂了 */
      const body = await r.text().catch(() => '')
      throw new Error(`HTTP ${r.status} ${String(body).replace(/\s+/g, ' ').slice(0, 160)}`)
    }
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
  const msg = String(e?.message || e).replace(/\s+/g, ' ').slice(0, 300)
  console.error('FAIL', msg)
  /* GitHub Actions 注解：失败原因的**前 300 字**直接写在运行摘要里，
     手机上点开这一轮就能看到是 HTTP 403 还是超时，不用翻日志。 */
  if (process.env.GITHUB_ACTIONS) console.log(`::error::${msg}`)
  process.exit(1)
})
