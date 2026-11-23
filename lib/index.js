// dsh-go-quota —— 多渠道额度显示（MiniMax、OpenCode Go……）。
//
// 界面部分不认识任何具体提供商：它在 PROVIDERS 上跑一圈，
// 每家一张卡片、一段明细，状态条取各家最紧的那个定颜色。
// 一家挂了不影响另一家，它自己降级成「拿不到数据」。
//
// 新增一家：写 lib/providers/<id>.js，然后在 lib/providers/index.js 登记。

import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { commonStrings, fmtStamp, worstTone } from './core.js'
import { PROVIDERS } from './providers/index.js'

export const name = 'dsh-go-quota'

const CACHE_MS = 60_000
const REFRESH_MS = 5 * 60_000
const LOG_FILE = fileURLToPath(new URL('../actions.log', import.meta.url))

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

// ── 状态条：各家一句话 ────────────────────────────────────────────────────

// 只统计真的显示出来的渠道：一个渠道挂了，不该把另一个也染成红色。
const stripLine = (sections, en) => {
  const parts = []
  const tones = []
  for (const { provider, data } of sections) {
    if (data.stripPercent === null || data.stripPercent === undefined) continue
    parts.push(`${provider.short(en)} ${data.stripPercent}%`)
    tones.push(data.stripTone)
  }
  if (parts.length === 0) {
    return { text: en ? 'Quota unavailable' : '额度获取失败', tone: 'bad' }
  }
  return { text: parts.join(' · '), tone: tones.reduce(worstTone) }
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    /** @type {Map<string, {at: number, raw: any}>} */
    const cache = new Map()
    // 最近一次成功的数据：拉取失败时用它顶上，标成「旧」而不是整个空掉。
    /** @type {Map<string, {at: number, raw: any}>} */
    const lastGood = new Map()
    /** @type {Map<string, Promise<any>>} */
    const inflight = new Map()

    const load = async (provider) => {
      const hit = cache.get(provider.id)
      const now = Date.now()
      if (hit && hit.raw !== undefined && now - hit.at < CACHE_MS) return hit.raw
      const running = inflight.get(provider.id)
      if (running) return running
      const task = (async () => {
        const raw = await provider.fetch(ctx)
        const at = Date.now()
        cache.set(provider.id, { at, raw })
        lastGood.set(provider.id, { at, raw })
        return raw
      })()
      inflight.set(provider.id, task)
      try {
        return await task
      } finally {
        inflight.delete(provider.id)
      }
    }

    const fresh = (entry) => Boolean(entry && entry.raw !== undefined) && Date.now() - entry.at < 24 * 60 * 60_000

    // 各家各拉各的：一个挂了不影响另一个。
    const loadSections = async (en) => {
      const settled = await Promise.allSettled(PROVIDERS.map((provider) => load(provider)))
      /** @type {{provider: any, data: any}[]} */
      const sections = []
      let stale = false
      settled.forEach((outcome, index) => {
        const provider = PROVIDERS[index]
        if (outcome.status === 'fulfilled') {
          sections.push({ provider, data: provider.build(outcome.value, en) })
          return
        }
        stale = true
        const fallback = lastGood.get(provider.id)
        sections.push({
          provider,
          data: fresh(fallback) ? provider.build(fallback.raw, en) : provider.error(outcome.reason, en),
        })
      })
      return { sections, stale }
    }

    // 输入框上方的状态条：各家剩余百分比。
    ctx.dshGo.strip('quota-strip', (scope, emit, caps) => {
      const en = String(caps?.locale ?? '').startsWith('en')
      let alive = true
      const tick = async () => {
        try {
          const { sections } = await loadSections(en)
          if (!alive) return
          const line = stripLine(sections, en)
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

    // 额度面板：每家一张卡片，下面是各自的明细。
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
      const card = (id) => ({
        type: 'stack',
        style: { card: 'tinted', gap: 'S' },
        children: [
          {
            type: 'metric',
            label: { $: `data.${id}.headLabel` },
            value: { $: `data.${id}.headValue` },
            tone: { $: `data.${id}.headTone` },
            caption: { $: `data.${id}.headCaption` },
          },
          {
            type: 'progress',
            value: { $: `data.${id}.barValue` },
            max: 100,
            label: { $: `data.${id}.barLabel` },
            tone: { $: `data.${id}.barTone` },
          },
        ],
      })
      return {
        v: 2,
        type: 'stack',
        accent: 'app',
        style: { gap: 'M' },
        children: [
          ...PROVIDERS.map((provider) => card(provider.id)),
          // 数据新旧一句话
          { type: 'callout', text: { $: 'data.statusText' }, tone: { $: 'data.statusTone' } },
          ...PROVIDERS.flatMap((provider) => [
            { type: 'text', text: provider.section(en), style: { size: 'caption', weight: 'semibold' } },
            { type: 'list', items: { $: `data.${provider.id}.rows` } },
          ]),
          {
            type: 'actions',
            items: [{ label: en ? 'Refresh' : '刷新', icon: 'refresh', action: 'refresh', style: 'plain' }],
          },
        ],
      }
    }

    const panelData = (scope, emit, caps) => {
      const en = String(caps?.locale ?? '').startsWith('en')
      const T = commonStrings(en)
      let alive = true
      loadSections(en)
        .then(({ sections, stale }) => {
          if (!alive) return
          const at = fmtStamp(Date.now())
          const missing = []
          /** @type {Record<string, any>} */
          const data = {}
          for (const { provider, data: section } of sections) {
            data[provider.id] = section
            if (section.ok !== true) missing.push(provider.name(en))
          }
          emit({
            ...data,
            statusText: stale && missing.length > 0
              ? `${T.staleAt(at)}`
              : `${T.updatedAt(at)}${missing.length > 0 ? ` · ${missing.join(' / ')} ${en ? 'unavailable' : '没数据'}` : ''}`,
            statusTone: stale ? 'warn' : 'info',
          })
        })
        .catch(() => {
          if (!alive) return
          /** @type {Record<string, any>} */
          const data = {}
          for (const provider of PROVIDERS) {
            data[provider.id] = provider.error(new Error('request-failed'), en)
          }
          emit({
            ...data,
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
        cache.clear()
        return { refresh: true }
      },
    }
    // 只留一个面板：状态条点开的详情弹层。
    ctx.dshGo.panel('quota', {
      view: panelView,
      data: panelData,
      actions: panelActions,
    })
  })
}
