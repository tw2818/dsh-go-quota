// 公共内核：时间/数字格式化、颜色档位、密钥查找、通用文案。
//
// 所有提供商共用这些；每家自己的接口解析和文案在 lib/providers/<id>.js 里。
// 新增一家提供商 = 新增一个文件 + 在 lib/providers/index.js 里登记。

import { readFileSync, readdirSync } from 'node:fs'

/** 时间戳：毫秒或秒都见过（1e11 以下按秒算）。 */
export const toMs = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < 1e11 ? value * 1000 : value
}

/** 剩余时长：接口给的是毫秒；若比整个窗口还长，那多半是秒，换算后再夹住。 */
export const toDuration = (value, limit) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  if (limit > 0 && value > limit) return Math.min(value * 1000, limit)
  return value
}

export const pad = (n) => String(n).padStart(2, '0')

export const fmtClock = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const fmtDate = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export const fmtStamp = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const fmtSpan = (ms, en = false) => {
  if (!ms || ms <= 0) return '—'
  const total = Math.round(ms / 60_000)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h <= 0) return en ? `${m} min` : `${m} 分钟`
  if (m <= 0) return en ? `${h} h` : `${h} 小时`
  return en ? `${h} h ${m} m` : `${h} 小时 ${m} 分`
}

/** 剩余百分比对应的颜色档位。 */
export const toneOf = (percent) => {
  if (percent === null || percent === undefined) return 'muted'
  if (percent >= 50) return 'good'
  if (percent >= 20) return 'warn'
  return 'bad'
}

/** 夹在 0–100 的整数；认不出来就 null，不能当年 0% —— 那会误报成额度耗尽。 */
export const percentOf = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(100, Math.round(value)))
}

/** 颜色取更差的那个。 */
const TONE_ORDER = { good: 0, muted: 1, warn: 2, bad: 3 }
export const worstTone = (a, b) => (TONE_ORDER[b] ?? 0) > (TONE_ORDER[a] ?? 0) ? b : a

// ── 密钥查找：凭据服务 → 环境变量 → 本机凭据文件 ───────────────────────────

export const home = () => process.env.DSH_HOME || `${process.env.HOME || '/root'}/.dsh`

/** 从 ~/.dsh/.credentials.yaml 的 refs 里按名字取一个值。 */
export const refFromFile = (name) => {
  try {
    const text = readFileSync(`${home()}/.credentials.yaml`, 'utf8')
    const hit = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'))
    return hit ? hit[1].trim().replace(/^['"]|['"]$/g, '') : ''
  } catch {
    return ''
  }
}

export const credentialValue = async (ctx, ref) => {
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
export const lookupSecret = async (ctx, names) => {
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

/**
 * 在各 profile 的 cordis.patch.yml 里找一个渠道块，取它的 baseURL 和 Key 名。
 *
 * 只在命中 host 标记的那个块里取字段，免得相邻渠道的 apiKeyEnv 被当成
 * 同一个人的。找不到就返回 null。
 *
 * @param {{host: string}} options - host 标记，例如 'opencode.ai/zen'。
 * @returns {{base?: string, keyEnv?: string, literal?: string} | null}
 */
export const readProfileProvider = ({ host }) => {
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
    const at = lines.findIndex((line) => line.includes(host))
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

// ── 通用文案 ───────────────────────────────────────────────────────────────

/** 各家共用的措辞；各家自己的标题在各自的模块里。 */
export const commonStrings = (en) => ({
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
  tightest: (label) => (en ? `Tightest: ${label}` : `最紧：${label}`),
  resetsAt: (stamp) => (en ? `Resets ${stamp}` : `${stamp} 重置`),
  resetsDone: (stamp) => (en ? `Reset ${stamp}` : `已重置 ${stamp}`),
  notConfigured: en ? 'Not set up' : '未配置',
  updatedAt: (stamp) => (en ? `Updated ${stamp}` : `更新于 ${stamp}`),
  staleAt: (stamp) => (en ? `Showing data from ${stamp}; refresh failed.` : `显示的是 ${stamp} 的数据，刷新失败。`),
})
