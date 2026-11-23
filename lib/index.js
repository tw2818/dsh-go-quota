// dsh-go-minimax-quota-6 — MiniMax Token Plan 与 OpenCode Go 的额度。
//
// 两个渠道合并在一个插件里，界面用同一种样式：
//   状态条：两个渠道各一个剩余百分比，取更紧的那个定颜色。
//   面板  ：每个渠道一张卡片（大数字 + 进度条），下面列出其余窗口和模型。
//
// 数据来源：
//   MiniMax      GET {host}/v1/token_plan/remains，Bearer 用 Token Plan 的 Subscription Key。
//   OpenCode Go  GET {base}/v1/usage，Bearer 用订阅的 API Key。
//                 这个接口给的是「已用百分比」，这里换算成「剩余百分比」，跟 MiniMax 一个口径。
//
// Key 只在请求时读一次，不写进界面、不写日志。
import { readFileSync, writeFileSync, appendFileSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-go-minimax-quota-6'

const MINIMAX_REF = 'CUSTOM_MINIMAX_API_KEY'
const OPENCODE_REF = 'CUSTOM_OPENCODE_API_KEY'
const OPENCODE_ENV_NAMES = ['OPENCODE_GO_API_KEY', 'CUSTOM_OPENCODE_API_KEY', 'OPENCODE_API_KEY', 'DSH_GO_OPENCODE_KEY']
const OPENCODE_DEFAULT_URL = 'https://opencode.ai/zen/go/v1/usage'
const OPENCODE_CONSOLE = 'https://opencode.ai/console'
const MINIMAX_ENDPOINTS = [
  'https://api.minimax.cn/v1/token_plan/remains',
  'https://www.minimaxi.com/v1/token_plan/remains',
  'https://api.minimaxi.com/v1/token_plan/remains',
]
const CACHE_MS = 60_000
const REFRESH_MS = 5 * 60_000
const LOG_FILE = fileURLToPath(new URL('../actions.log', import.meta.url))
const MODEL_NAMES = {
  general: ['MiniMax 文本', 'MiniMax text'],
  video: ['视频', 'Video'],
  music: ['音乐', 'Music'],
  image: ['图片', 'Image'],
}

// ── 小工具 ────────────────────────────────────────────────────────────────

// 时间戳：毫秒或秒都见过（1e11 以下按秒算）。
const toMs = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < 1e11 ? value * 1000 : value
}

// 剩余时长：接口给的是毫秒；若比整个窗口还长，那多半是秒，换算后再夹住。
const toDuration = (value, limit) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  if (limit > 0 && value > limit) return Math.min(value * 1000, limit)
  return value
}

const pad = (n) => String(n).padStart(2, '0')

const fmtClock = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const fmtDate = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

const fmtStamp = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const fmtSpan = (ms, en = false) => {
  if (!ms || ms <= 0) return '—'
  const total = Math.round(ms / 60_000)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h <= 0) return en ? `${m} min` : `${m} 分钟`
  if (m <= 0) return en ? `${h} h` : `${h} 小时`
  return en ? `${h} h ${m} m` : `${h} 小时 ${m} 分`
}

const toneOf = (percent) => {
  if (percent === null || percent === undefined) return 'muted'
  if (percent >= 50) return 'good'
  if (percent >= 20) return 'warn'
  return 'bad'
}

// 夹在 0–100 的整数；认不出来就 null，不能当年 0% —— 那会误报成额度耗尽。
const percentOf = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

// 颜色取更差的那个。
const TONE_ORDER = { good: 0, muted: 1, warn: 2, bad: 3 }
const worstTone = (a, b) => (TONE_ORDER[b] ?? 0) > (TONE_ORDER[a] ?? 0) ? b : a

// 面板要用的中英文案；金额、时间和模型名由调用处拼。
const strings = (en) => ({
  interval: en ? '5-hour' : '5 小时额度',
  weekly: en ? 'Weekly' : '周额度',
  unlimited: en ? 'Unlimited' : '无限',
  allUnlimited: en ? 'All quotas unlimited' : '所有额度都不限量',
  noDataCaption: en ? 'No quota data returned' : '接口没有返回额度数据',
  noDataText: en ? 'No quota data right now' : '暂时拿不到额度数据',
  remaining: (left, total) => (en ? `${left}/${total} left` : `剩 ${left}/${total} 次`),
  percentLeft: (percent) => (en ? `${percent}% left` : `剩余 ${percent}%`),
  caption: (span, remains) => (en ? `${span} · ${fmtSpan(remains, true)} left` : `${span} · 还剩 ${fmtSpan(remains)}`),
  quotaLeft: en ? 'Quota left' : '剩余额度',
  minimaxTitle: en ? 'MiniMax quota' : 'MiniMax 额度',
  opencodeTitle: en ? 'OpenCode Go quota' : 'OpenCode Go 额度',
  opencodeRolling: en ? '5 hours' : '5 小时',
  opencodeWeekly: en ? 'This week' : '本周',
  opencodeMonthly: en ? 'This month' : '本月',
  tightest: (label) => (en ? `Tightest: ${label}` : `最紧：${label}`),
  resetsAt: (stamp) => (en ? `Resets ${stamp}` : `${stamp} 重置`),
  resetsDone: (stamp) => (en ? `Reset ${stamp}` : `已重置 ${stamp}`),
  notConfigured: en ? 'Not set up' : '未配置',
  notConfiguredCaption: en ? 'Add an OpenCode Go provider in Settings › Models' : '在 设置 › 模型 里配好 OpenCode Go',
  noKeyCaption: en ? 'Set CUSTOM_MINIMAX_API_KEY' : '请在凭据里设置 CUSTOM_MINIMAX_API_KEY',
  updatedAt: (stamp) => (en ? `Updated ${stamp}` : `更新于 ${stamp}`),
  staleAt: (stamp) => (en ? `Showing data from ${stamp}; refresh failed.` : `显示的是 ${stamp} 的数据，刷新失败。`),
})

const nameOf = (key, en) => {
  const hit = MODEL_NAMES[key]
  if (hit) return en ? hit[1] : hit[0]
  return key || (en ? 'Model' : '模型')
}


// 面板点按的原始内容写一份日志，方便回头查「到底传了什么」。
const logEvent = (entry) => {
  try {
    // 第一次写时文件还不存在，statSync 会抛 ENOENT；大小检查只当优化，不能挡住写入。
    try {
      if (statSync(LOG_FILE).size > 200_000) writeFileSync(LOG_FILE, '', 'utf8')
    } catch {
      // 文件不存在 / 读不到，直接走 append
    }
    appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 写日志失败不影响功能
  }
}

// ── 取 Key：凭据服务 → 环境变量 → 本机凭据文件 ───────────────────────────

const home = () => process.env.DSH_HOME || `${process.env.HOME || '/root'}/.dsh`

/** 从 ~/.dsh/.credentials.yaml 的 refs 里按名字取一个值。 */
const refFromFile = (name) => {
  try {
    const text = readFileSync(`${home()}/.credentials.yaml`, 'utf8')
    const hit = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))
    return hit ? hit[1].trim().replace(/^['"]|['"]$/g, '') : ''
  } catch {
    return ''
  }
}

const credentialValue = async (ctx, ref) => {
  try {
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    }
  } catch {
    // 凭据服务不可用就往回退
  }
  return ''
}

/** 按名字依次找：凭据服务 → 环境变量 → 凭据文件。 */
const lookupSecret = async (ctx, names) => {
  for (const name of names) {
    const hit = await credentialValue(ctx, name)
    if (hit) return hit
  }
  for (const name of names) {
    const hit = process.env[name]
    if (typeof hit === 'string' && hit.trim() !== '') return hit.trim()
  }
  for (const name of names) {
    const hit = refFromFile(name)
    if (hit) return hit
  }
  return ''
}

const resolveMinimaxKey = async (ctx) => lookupSecret(ctx, [MINIMAX_REF])

// ── OpenCode 渠道配置 ─────────────────────────────────────────────────────
// 找 baseURL 和 Key 的名字：扫各 profile 的 cordis.patch.yml，找 Base URL 含
// opencode.ai/zen 的那个渠道，只在它自己的块里取字段，免得相邻渠道的
// apiKeyEnv 被当成 OpenCode 的。（思路来自 dsh-go-opencode-usage。）

const findOpencodeProvider = () => {
  const dir = `${home()}/profiles`
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const profile of names) {
    let text
    try {
      text = readFileSync(`${dir}/${profile}/cordis.patch.yml`, 'utf8')
    } catch {
      continue // 跳过读不了或没配置的 profile
    }
    const lines = text.split('\n')
    const at = lines.findIndex((line) => line.includes('opencode.ai/zen'))
    if (at < 0) continue
    const indent = lines[at].search(/\S/)
    // 往上找一个缩进更浅的「名字:」行，就是渠道本身。
    let head = -1
    for (let i = at - 1; i >= 0; i -= 1) {
      const line = lines[i]
      const lead = line.search(/\S/)
      if (lead < 0 || line.trim().startsWith('#')) continue
      if (lead < indent && /^[A-Za-z0-9_.-]+:\s*$/.test(line.trim())) {
        head = i
        break
      }
    }
    const headIndent = head >= 0 ? lines[head].search(/\S/) : -1
    const start = head >= 0 ? head + 1 : 0
    let end = lines.length
    for (let i = start; i < lines.length; i += 1) {
      const lead = lines[i].search(/\S/)
      if (lead < 0) continue
      if (head >= 0 && lead <= headIndent) {
        end = i
        break
      }
    }
    const block = lines.slice(start, end).join('\n')
    const base = block.match(/baseURL:\s*['"]?([^'"\s]+)/)?.[1]
    const keyEnv = block.match(/apiKeyEnv:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    const literal = block.match(/(?:^|\s)apiKey:\s*['"]?((?:oc_sk_|sk-)[^'"\s]+)/)?.[1]
    if (base || keyEnv || literal) return { base, keyEnv, literal }
  }
  return null
}

const opencodeUsageUrl = (base) => {
  if (typeof base !== 'string' || base === '') return OPENCODE_DEFAULT_URL
  try {
    const url = new URL(base)
    url.pathname = url.pathname.replace(/\/v1\/?$/, '/v1/usage')
    url.search = ''
    return url.href
  } catch {
    return OPENCODE_DEFAULT_URL
  }
}

// ── 拉额度 ────────────────────────────────────────────────────────────────

const fetchMinimaxQuota = async (ctx) => {
  const key = await resolveMinimaxKey(ctx)
  if (!key) throw new Error('no-key')
  let lastError = new Error('request-failed')
  for (const url of MINIMAX_ENDPOINTS) {
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

const fetchOpencodeUsage = async (ctx) => {
  const info = findOpencodeProvider()
  const names = [info?.keyEnv, ...OPENCODE_ENV_NAMES].filter(
    (n, i, all) => typeof n === 'string' && n !== '' && all.indexOf(n) === i,
  )
  const key = info?.literal || (await lookupSecret(ctx, names))
  if (!key) throw new Error('no-key')
  const url = opencodeUsageUrl(info?.base)
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

// ── MiniMax：把接口返回变成能看懂的窗口 ──────────────────────────────────

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

const buildMinimax = (json, en = false) => {
  const T = strings(en)
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
    headLabel: T.minimaxTitle,
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

// ── OpenCode Go：三个窗口的已用百分比，换算成剩余 ─────────────────────────

const buildOpencode = (usage, en = false) => {
  const T = strings(en)
  const defs = [
    { key: 'rolling', label: T.opencodeRolling },
    { key: 'weekly', label: T.opencodeWeekly },
    { key: 'monthly', label: T.opencodeMonthly },
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
    headLabel: T.opencodeTitle,
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

// ── 出错时的样子 ──────────────────────────────────────────────────────────

const minimaxError = (error, en) => {
  const T = strings(en)
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
  const caption = reason === 'no-key' ? T.noKeyCaption : en ? 'Check the key and the network' : '检查 Key 和网络后再试'
  return {
    ok: false,
    hasData: false,
    headLabel: T.minimaxTitle,
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

const opencodeError = (error, en) => {
  const T = strings(en)
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
    ? T.notConfiguredCaption
    : en
      ? 'Check the key and the network'
      : '检查 Key 和网络后再试'
  return {
    ok: false,
    hasData: false,
    headLabel: T.opencodeTitle,
    headValue: text,
    headTone: noKey ? 'muted' : 'bad',
    headCaption: caption,
    barValue: 0,
    barLabel: T.quotaLeft,
    barTone: noKey ? 'muted' : 'bad',
    stripPercent: null,
    stripTone: noKey ? 'muted' : 'bad',
    rows: [],
  }
}

// ── 状态条：两个渠道一句话 ────────────────────────────────────────────────

// 只统计真的显示出来的渠道：一个渠道挂了，不该把另一个也染成红色。
const stripLine = (minimax, opencode, en) => {
  const parts = []
  const tones = []
  if (minimax.stripPercent !== null) {
    parts.push(`MiniMax ${minimax.stripPercent}%`)
    tones.push(minimax.stripTone)
  }
  if (opencode.stripPercent !== null) {
    parts.push(`OC ${opencode.stripPercent}%`)
    tones.push(opencode.stripTone)
  }
  if (parts.length === 0) {
    return { text: en ? 'Quota unavailable' : '额度获取失败', tone: 'bad' }
  }
  return { text: parts.join(' · '), tone: tones.reduce(worstTone) }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const minimaxCache = { at: 0, json: null }
    const opencodeCache = { at: 0, usage: null }
    // 最近一次成功的数据：拉取失败时用它顶上，标成「旧」而不是整个空掉。
    const minimaxLast = { at: 0, json: null }
    const opencodeLast = { at: 0, usage: null }
    let minimaxInflight = null
    let opencodeInflight = null

    const loadMinimax = async () => {
      const now = Date.now()
      if (minimaxCache.json && now - minimaxCache.at < CACHE_MS) return minimaxCache.json
      if (minimaxInflight) return minimaxInflight
      minimaxInflight = (async () => {
        const json = await fetchMinimaxQuota(ctx)
        minimaxCache.at = Date.now()
        minimaxCache.json = json
        minimaxLast.at = minimaxCache.at
        minimaxLast.json = json
        return json
      })()
      try {
        return await minimaxInflight
      } finally {
        minimaxInflight = null
      }
    }

    const loadOpencode = async () => {
      const now = Date.now()
      if (opencodeCache.usage && now - opencodeCache.at < CACHE_MS) return opencodeCache.usage
      if (opencodeInflight) return opencodeInflight
      opencodeInflight = (async () => {
        const usage = await fetchOpencodeUsage(ctx)
        opencodeCache.at = Date.now()
        opencodeCache.usage = usage
        opencodeLast.at = opencodeCache.at
        opencodeLast.usage = usage
        return usage
      })()
      try {
        return await opencodeInflight
      } finally {
        opencodeInflight = null
      }
    }

    const fresh = (last) => Boolean(last.json || last.usage) && Date.now() - last.at < 24 * 60 * 60_000

    // 两个渠道各拉各的：一个挂了不影响另一个。
    const loadSections = async (en) => {
      const [mm, oc] = await Promise.allSettled([loadMinimax(), loadOpencode()])
      const minimax = mm.status === 'fulfilled'
        ? buildMinimax(mm.value, en)
        : (fresh(minimaxLast)
            ? buildMinimax(minimaxLast.json, en)
            : minimaxError(mm.reason, en))
      const opencode = oc.status === 'fulfilled'
        ? buildOpencode(oc.value, en)
        : (fresh(opencodeLast)
            ? buildOpencode(opencodeLast.usage, en)
            : opencodeError(oc.reason, en))
      return { minimax, opencode, stale: mm.status !== 'fulfilled' || oc.status !== 'fulfilled' }
    }

    // 输入框上方的状态条：两个渠道的剩余百分比。
    ctx.dshGo.strip('quota-strip', (scope, emit, caps) => {
      const en = String(caps?.locale ?? '').startsWith('en')
      let alive = true
      const tick = async () => {
        try {
          const { minimax, opencode } = await loadSections(en)
          if (!alive) return
          const line = stripLine(minimax, opencode, en)
          emit({ text: line.text, icon: 'coin', tone: line.tone })
        } catch {
          if (!alive) return
          emit({ text: en ? 'Quota unavailable' : '额度获取失败', icon: 'coin', tone: 'bad' })
        }
      }
      tick()
      const stripTimer = setInterval(tick, REFRESH_MS)
      stripTimer.unref?.()
      return () => {
        alive = false
        clearInterval(stripTimer)
      }
    })

    // 额度面板：两个渠道各一张卡片，下面是各自的明细。
    let lastCapsLog = 0
    const panelView = (scope, caps) => {
      const en = String(caps?.locale ?? '').startsWith('en')
      // 记一下 App 的版本和它会画的组件，方便回头判断是控件不支持还是值没传对。
      const now = Date.now()
      if (now - lastCapsLog > 30_000) {
        lastCapsLog = now
        logEvent({
          at: new Date().toISOString(),
          caps: {
            app: caps?.app,
            protocol: caps?.protocol,
            locale: caps?.locale,
            surfaces: caps?.surfaces,
            components: caps?.components,
          },
        })
      }
      const card = (prefix) => ({
        type: 'stack',
        style: { card: 'tinted', gap: 'S' },
        children: [
          {
            type: 'metric',
            label: { $: `data.${prefix}.headLabel` },
            value: { $: `data.${prefix}.headValue` },
            tone: { $: `data.${prefix}.headTone` },
            caption: { $: `data.${prefix}.headCaption` },
          },
          {
            type: 'progress',
            value: { $: `data.${prefix}.barValue` },
            max: 100,
            label: { $: `data.${prefix}.barLabel` },
            tone: { $: `data.${prefix}.barTone` },
          },
        ],
      })
      return {
        v: 2,
        type: 'stack',
        accent: 'app',
        style: { gap: 'M' },
        children: [
          card('minimax'),
          card('opencode'),
          // 数据新旧一句话
          { type: 'callout', text: { $: 'data.statusText' }, tone: { $: 'data.statusTone' } },
          { type: 'text', text: en ? 'MiniMax · other windows and models' : 'MiniMax · 其他窗口与模型', style: { size: 'caption', weight: 'semibold' } },
          { type: 'list', items: { $: 'data.minimax.rows' } },
          { type: 'text', text: en ? 'OpenCode Go · the three windows' : 'OpenCode Go · 三个窗口', style: { size: 'caption', weight: 'semibold' } },
          { type: 'list', items: { $: 'data.opencode.rows' } },
          {
            type: 'actions',
            items: [
              { label: en ? 'Refresh' : '刷新', icon: 'refresh', action: 'refresh', style: 'plain' },
              { label: en ? 'Console' : '控制台', icon: 'external', action: 'console', style: 'plain' },
            ],
          },
        ],
      }
    }

    const panelData = (scope, emit, caps) => {
      const en = String(caps?.locale ?? '').startsWith('en')
      const T = strings(en)
      let alive = true
      loadSections(en)
        .then(({ minimax, opencode, stale }) => {
          if (!alive) return
          const at = fmtStamp(Date.now())
          const missing = []
          if (!minimax.ok) missing.push('MiniMax')
          if (!opencode.ok) missing.push('OpenCode Go')
          emit({
            minimax,
            opencode,
            statusText: stale && missing.length > 0
              ? `${T.staleAt(at)}`
              : `${T.updatedAt(at)}${missing.length > 0 ? ` · ${missing.join(' / ')} ${en ? 'unavailable' : '没数据'}` : ''}`,
            statusTone: stale ? 'warn' : 'info',
          })
        })
        .catch(() => {
          if (!alive) return
          emit({
            minimax: minimaxError(new Error('request-failed'), en),
            opencode: opencodeError(new Error('request-failed'), en),
            statusText: en ? 'Quota unavailable' : '额度获取失败',
            statusTone: 'bad',
          })
        })
      return () => {
        alive = false
      }
    }

    const panelActions = {
      refresh: () => {
        logEvent({ at: new Date().toISOString(), action: 'refresh' })
        minimaxCache.at = 0
        minimaxCache.json = null
        opencodeCache.at = 0
        opencodeCache.usage = null
        return { refresh: true }
      },
      console: () => ({ link: OPENCODE_CONSOLE }),
    }

    // 只留一个面板：状态条点开的详情弹层。
    ctx.dshGo.panel('quota', {
      view: panelView,
      data: panelData,
      actions: panelActions,
    })

  })
}
