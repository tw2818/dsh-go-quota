// MiniMax Token Plan —— 一个额度提供商。
//
// 数据来源：GET {host}/v1/token_plan/remains，Bearer 用 Token Plan 的 Subscription Key。
// 接口给的是各模型各窗口的剩余百分比和剩余次数。

import {
  commonStrings,
  fmtClock,
  fmtDate,
  fmtSpan,
  lookupSecret,
  percentOf,
  toDuration,
  toMs,
  toneOf,
} from '../core.js'

/** 凭据名。 */
const KEY_REF = 'CUSTOM_MINIMAX_API_KEY'

/** 域名按顺序试。 */
const ENDPOINTS = [
  'https://api.minimax.cn/v1/token_plan/remains',
  'https://www.minimaxi.com/v1/token_plan/remains',
  'https://api.minimaxi.com/v1/token_plan/remains',
]

/** 模型名的中文说法。 */
const MODEL_NAMES = {
  general: ['MiniMax 文本', 'MiniMax text'],
  video: ['视频', 'Video'],
  music: ['音乐', 'Music'],
  image: ['图片', 'Image'],
}

const nameOf = (key, en) => {
  const hit = MODEL_NAMES[key]
  if (hit) return en ? hit[1] : hit[0]
  return key || (en ? 'Model' : '模型')
}

/** 把一个窗口摊平成「剩余百分比 / 次数 / 颜色」。 */
const analyzeWindow = (item, kind, T) => {
  const prefix = kind === 'weekly' ? 'current_weekly' : 'current_interval'
  const status = item?.[`${prefix}_status`]
  const raw = item?.[`${prefix}_remaining_percent`]
  // 认不出来就是「未知」，不能当年 0% —— 那会误报成额度耗尽。
  const percent = percentOf(raw)
  const total = typeof item?.[`${prefix}_total_count`] === 'number' ? item[`${prefix}_total_count`] : 0
  const start = toMs(kind === 'weekly' ? item?.weekly_start_time : item?.start_time)
  const end = toMs(kind === 'weekly' ? item?.weekly_end_time : item?.end_time)
  const limit = end > start ? end - start : 0
  const remains = toDuration(kind === 'weekly' ? item?.weekly_remains_time : item?.remains_time, limit)
  const span = kind === 'weekly' ? `${fmtDate(start)}–${fmtDate(end)}` : `${fmtClock(start)}–${fmtClock(end)}`
  const caption = T.caption(span, remains)

  if (status === 3) return { infinite: true, percent: 100, value: T.unlimited, tone: 'good', caption, total: 0, left: 0 }
  if (percent === null) return { infinite: false, percent: null, value: '—', tone: 'muted', caption, total, left: 0 }
  if (total > 0) {
    const used = Math.round(total * (1 - percent / 100))
    const left = Math.max(0, total - used)
    return { infinite: false, percent, value: T.remaining(left, total), tone: toneOf(percent), caption, total, left }
  }
  return { infinite: false, percent, value: T.percentLeft(percent), tone: toneOf(percent), caption, total, left: 0 }
}

/** 拉一次原始数据。 */
const fetchQuota = async (ctx) => {
  const key = await lookupSecret(ctx, [KEY_REF])
  if (!key) throw new Error('no-key')
  let lastError = new Error('request-failed')
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        lastError = new Error(`http-${res.status}`)
        // 认证/权限类错误换域名也没用，别白打三次；408/429 还值得换个域名再试。
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break
        continue
      }
      const json = await res.json()
      const code = json?.base_resp?.status_code
      if (typeof code === 'number' && code !== 0) {
        lastError = new Error(json?.base_resp?.status_msg || 'api-error')
        continue
      }
      if (!Array.isArray(json?.model_remains)) {
        lastError = new Error('bad-payload')
        continue
      }
      return json
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') lastError = new Error('timeout')
      else lastError = error
    }
  }
  throw lastError
}

/** 把接口返回变成能看懂的窗口。 */
const build = (json, en = false) => {
  const T = commonStrings(en)
  const items = Array.isArray(json?.model_remains) ? json.model_remains : []
  const models = items.map((item) => {
    const key = typeof item?.model_name === 'string' ? item.model_name : ''
    return {
      key,
      name: nameOf(key, en),
      interval: analyzeWindow(item, 'interval', T),
      weekly: analyzeWindow(item, 'weekly', T),
    }
  })
  const primary = models.find((m) => m.key === 'general') ?? models[0] ?? null

  // 所有窗口摊平，挑最紧的那个当主指标。
  const windows = models.flatMap((m) => [
    { key: m.key, model: m.name, kind: 'interval', label: T.interval, ...m.interval },
    { key: m.key, model: m.name, kind: 'weekly', label: T.weekly, ...m.weekly },
  ])
  const finite = windows.filter((w) => !w.infinite && w.percent !== null)
  const head = finite.reduce((min, w) => (min === null || w.percent < min.percent ? w : min), null)
  const percent = head ? head.percent : null
  // 有模型、但每个窗口都是 status=3 才算「不限量」；空列表是「不知道」。
  const unlimited = head === null && windows.length > 0 && windows.every((w) => w.infinite)

  // 状态条只盯文本模型：视频/音乐没额度不该让日常状态条变红。
  const stripWindows = primary ? [primary.interval, primary.weekly].filter((w) => !w.infinite && w.percent !== null) : []
  const strip = stripWindows.reduce((min, w) => (min === null || w.percent < min.percent ? w : min), null) ?? head
  const stripPercent = strip ? strip.percent : null

  const headLabel = head
    ? primary && head.key === primary.key
      ? head.label
      : `${head.model}·${head.label}`
    : en
      ? 'Quota'
      : '额度'
  const headValue = head ? head.value : unlimited ? T.unlimited : '—'
  const headTone = head ? head.tone : unlimited ? 'good' : 'muted'
  const headCaption = head ? `${head.label} · ${head.caption}` : unlimited ? T.allUnlimited : T.noDataCaption
  const barValue = head ? head.percent : unlimited ? 100 : 0
  const barTone = head ? head.tone : unlimited ? 'good' : 'muted'

  // 其余窗口收成几行，不重复主指标已经说过的话。
  const rows = models.map((m) => {
    if (head && head.key === m.key) {
      return head.kind === 'interval'
        ? { title: T.weekly, subtitle: m.weekly.caption, trailing: m.weekly.value, tone: m.weekly.tone }
        : { title: T.interval, subtitle: m.interval.caption, trailing: m.interval.value, tone: m.interval.tone }
    }
    const interval = m.interval
    return {
      title: en ? `${m.name} quota` : `${m.name}额度`,
      subtitle: `${T.interval} ${interval.value} · ${T.weekly} ${m.weekly.value}`,
      trailing: interval.infinite
        ? '∞'
        : interval.percent === null
          ? '—'
          : interval.total > 0
            ? `${interval.left}/${interval.total}`
            : `${interval.percent}%`,
      tone: interval.tone,
    }
  })

  return {
    ok: true,
    hasData: head !== null || unlimited,
    headLabel: en ? 'MiniMax quota' : 'MiniMax 额度',
    headValue,
    headTone,
    headCaption,
    barValue,
    barLabel: T.quotaLeft,
    barTone,
    stripPercent,
    stripTone: stripPercent === null ? (unlimited ? 'good' : 'muted') : toneOf(stripPercent),
    rows,
  }
}

/** 出错时的样子。 */
const buildError = (error, en) => {
  const T = commonStrings(en)
  const reason = String(error?.message ?? '')
  const text =
    reason === 'no-key'
      ? en
        ? 'No MiniMax key'
        : '没找到 MiniMax 的 Key'
      : reason === 'timeout'
        ? en
          ? 'Request timed out'
          : '请求超时'
        : en
          ? 'Quota unavailable'
          : '额度获取失败'
  const caption =
    reason === 'no-key'
      ? en
        ? 'Set CUSTOM_MINIMAX_API_KEY'
        : '请在凭据里设置 CUSTOM_MINIMAX_API_KEY'
      : en
        ? 'Check the key and the network'
        : '检查 Key 和网络后再试'
  return {
    ok: false,
    hasData: false,
    headLabel: en ? 'MiniMax quota' : 'MiniMax 额度',
    headValue: text,
    headTone: 'bad',
    headCaption: caption,
    barValue: 0,
    barLabel: T.quotaLeft,
    barTone: 'bad',
    stripPercent: null,
    stripTone: 'bad',
    rows: [],
  }
}

export default {
  id: 'minimax',
  name: () => 'MiniMax',
  short: () => 'MiniMax',
  title: (en) => (en ? 'MiniMax quota' : 'MiniMax 额度'),
  section: (en) => (en ? 'MiniMax · other windows and models' : 'MiniMax · 其他窗口与模型'),
  fetch: fetchQuota,
  build,
  error: buildError,
}
