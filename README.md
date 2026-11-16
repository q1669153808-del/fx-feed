# fx-feed

招商银行外汇牌价 → `fx.json`，供内部 CRM 读取。

## 为什么存在这个仓库

招行牌价接口 `https://fx.cmbchina.com/api/v1/fx/rate` **没有 `access-control-allow-origin`**，
浏览器里的 `fetch` 会被同源策略拦掉 —— 拦的是响应头，不是请求发不出去。
所以需要一台「浏览器之外」的机器去取，再把结果放到一个带 CORS 的地方。

`raw.githubusercontent.com` 实测返回 `access-control-allow-origin: *`（缓存 300 秒），
正好拿来当免费的分发点。GitHub Actions 每 5 分钟跑一次抓取，有变化才提交。

> 试过但不行的：`cdn.jsdelivr.net/gh/...` 虽然也有 CORS，但 CDN 缓存 12 小时、浏览器缓存 7 天，
> 分钟级更新用不了。

## 产物

```json
{
  "d": "2026-11-16",          // 招行自己的牌价日期
  "t": "10:46:44",            // 招行自己的牌价时间
  "src": "cmb",
  "bid": { "USD": 6.65916 },  // 现汇买入价（rthBid ÷ 100），结汇口径
  "mid": { "USD": 6.6715 },   // 基准价（rtbBid ÷ 100）≈ 中间价
  "fetched": "2026-11-16T02:46:46Z"
}
```

🔴 字段别认错：`rtbBid` 是基准价，`rthBid` 才是现汇买入价，`rtcBid` 是现钞买入价（偏低）。
数值是「每 100 外币兑人民币」，要除以 100。

## 前端怎么读

```
https://raw.githubusercontent.com/<账号>/fx-feed/main/fx.json
```

拉不到就退回旧逻辑（估算），不要让任何计算因此报错。

## 本地手动跑一次

```bash
node scripts/fetch.mjs && cat fx.json
```
