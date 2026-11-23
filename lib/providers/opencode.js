// OpenCode Go —— 一个额度提供商。
//
// 数据来源：GET {base}/v1/usage，Bearer 用订阅的 API Key。
// 这个接口给的是「已用百分比」，这里换算成「剩余百分比」，跟别家一个口径。

import { commonStrings, fmtStamp, lookupSecret, percentOf, readProfileProvider, toneOf } from '../core.js'

/** 环境变量候选名。 */
const ENV_NAMES = ['OPENCODE_GO_API_KEY', 'CUSTOM_OPENCODE_API_KEY', 'OPENCODE_API_KEY', 'DSH_GO_OPENCODE_KEY']

/** 找不到渠道配置时的兜底地址。 */
const DEFAULT_URL = 'https://opencode.ai/zen/go/v1/usage'

/** 把渠道的 baseURL 换成 usage 接口。 */
const usageUrl = (base) => {
  if (typeof base !== 'string' || base === '') return DEFAULT_URL
  try {
    const url = new URL(base)
    url.pathname = url.pathname.replace(/\/v1\/?$/, '/v1/usage')
    url.search = ''
    return url.href
  } catch {
    return DEFAULT_URL
  }
}

/** 找 baseURL 和 Key 的名字：扫各 profile 的 cordis.patch.yml。 */
const findProvider = () => readProfileProvider({ host: 'opencode.ai/zen' })

/** 拉一次原始数据。 */
const fetchQuota = async (ctx) => {
  const info = findProvider()
  const names = [info?.keyEnv, ...ENV_NAMES].filter(
    (n, i, all) => typeof n === 'string' && n !== '' && all.indexOf(n) === i,
  )
  const key = info?.literal || (await lookupSecret(ctx, names))
  if (!key) throw new Error('no-key')
  const url = usageUrl(info?.base)
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!res.ok) throw new Error(`http-${res.status}`)
  const body = await res.json()
  const usage = body?.usage
  if (!usage || typeof usage !== 'object') throw new Error('bad-payload')
  return usage
}

/** 三个窗口的已用百分比，换算成剩余。 */
const build = (usage, en = false) => {
  const T = commonStrings(en)
  const defs = [
    { key: 'rolling', label: en ? '5 hours' : '5 小时' },
    { key: 'weekly', label: en ? 'This week' : '本周' },
    { key: 'monthly', label: en ? 'This month' : '本月' },
  ]
  const windows = defs.map((def) => {
    const item = usage?.[def.key]
    const used = percentOf(item?.percent)
    const remaining = used === null ? null : 100 - used
    const resetsAt = typeof item?.resetsAt === 'string' ? Date.parse(item.resetsAt) : Number.NaN
    const hasReset = Number.isFinite(resetsAt)
    const stamp = hasReset ? fmtStamp(resetsAt) : '—'
    const limited = typeof item?.status === 'string' && item.status !== 'ok'
    return {
      key: def.key,
      label: def.label,
      remaining,
      limited,
      tone: limited ? 'bad' : toneOf(remaining),
      subtitle: !hasReset
        ? ''
        : resetsAt <= Date.now()
          ? T.resetsDone(stamp)
          : T.resetsAt(stamp),
      value: remaining === null ? '—' : T.percentLeft(remaining),
    }
  })

  const known = windows.filter((w) => w.remaining !== null)
  const head = known.reduce((min, w) => (min === null || w.remaining < min.remaining ? w : min), null)
  const stripPercent = head ? head.remaining : null

  const rows = windows.map((w) => ({
    title: w.label,
    subtitle: w.subtitle,
    trailing: w.value,
    tone: w.tone,
  }))

  return {
    ok: true,
    hasData: known.length > 0,
    headLabel: en ? 'OpenCode Go quota' : 'OpenCode Go 额度',
    headValue: head ? T.percentLeft(head.remaining) : '—',
    headTone: head ? head.tone : 'muted',
    headCaption: head ? `${T.tightest(head.label)}${head.subtitle ? ' · ' + head.subtitle : ''}` : T.noDataCaption,
    barValue: head ? head.remaining : 0,
    barLabel: T.quotaLeft,
    barTone: head ? head.tone : 'muted',
    stripPercent,
    stripTone: stripPercent === null ? 'muted' : toneOf(stripPercent),
    rows,
  }
}

/** 出错时的样子。 */
const buildError = (error, en) => {
  const T = commonStrings(en)
  const reason = String(error?.message ?? '')
  const noKey = reason === 'no-key'
  const text = noKey
    ? T.notConfigured
    : reason === 'timeout'
      ? en
        ? 'Request timed out'
        : '请求超时'
      : en
        ? 'Usage unavailable'
        : '额度获取失败'
  const caption = noKey
    ? en
      ? 'Add an OpenCode Go provider in Settings › Models'
      : '在 设置 › 模型 里配好 OpenCode Go'
    : en
      ? 'Check the key and the network'
      : '检查 Key 和网络后再试'
  return {
    ok: false,
    hasData: false,
    headLabel: en ? 'OpenCode Go quota' : 'OpenCode Go 额度',
    headValue: text,
    headTone: noKey ? 'muted' : 'bad',
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
  id: 'opencode',
  name: () => 'OpenCode Go',
  short: () => 'OC',
  title: (en) => (en ? 'OpenCode Go quota' : 'OpenCode Go 额度'),
  section: (en) => (en ? 'OpenCode Go · the three windows' : 'OpenCode Go · 三个窗口'),
  fetch: fetchQuota,
  build,
  error: buildError,
}
