# dsh-go-quota

DSH GO 手机端的**多渠道额度**原生插件：在状态条和面板里显示各家 API 提供商的剩余额度。

内置两家：**MiniMax Token Plan** 和 **OpenCode Go**。界面层不认识具体是谁 —— 它按「提供商列表」跑一圈，每家一张卡片、一段明细，状态条取各家最紧的那个定颜色。一家挂了不影响另一家，它自己降级成「拿不到数据」，并用上一次成功的旧数据兜底。

## 现在支持

| 提供商 | 数据来源 | 凭据 |
| --- | --- | --- |
| MiniMax | `GET https://api.minimax.cn/v1/token_plan/remains` | 凭据库 `CUSTOM_MINIMAX_API_KEY`（Token Plan 的 Subscription Key） |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | 凭据库 `CUSTOM_OPENCODE_API_KEY`，或环境变量 `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` / `DSH_GO_OPENCODE_KEY` |

OpenCode 那个接口给的是「已用百分比」，插件换算成「剩余百分比」，跟别家一个口径。MiniMax 的域名会按 `api.minimax.cn` → `www.minimaxi.com` → `api.minimaxi.com` 顺序试。

## 加一家提供商

写一个 `lib/providers/<id>.js`，然后在 `lib/providers/index.js` 里登记一行。界面、缓存、状态条、面板都不用动。

```js
export default {
  id: 'my-provider',
  name: (en) => (en ? 'My Provider' : '我的提供商'),   // 面板里的名字
  short: (en) => 'MP',                                  // 状态条里的短名
  title: (en) => (en ? 'My quota' : '我的额度'),          // 卡片标题
  section: (en) => (en ? 'My · details' : '我的 · 明细'), // 明细区标题
  consoleUrl: () => 'https://example.com/console',       // 可选：给面板加一个「控制台」按钮
  fetch: async (ctx) => { /* 拉原始数据 */ },
  build: (raw, en) => ({ /* 变成面板数据 */ }),
  error: (err, en) => ({ /* 出错时的样子 */ }),
}
```

`build` / `error` 返回同一种结构，界面就认这一个：

```js
{
  ok: true, hasData: true,
  headLabel: '额度标题', headValue: '62%', headTone: 'good', headCaption: '说明文字',
  barValue: 62, barLabel: '剩余额度', barTone: 'good',
  stripPercent: 62, stripTone: 'good',   // 状态条用；null 表示不参与
  rows: [{ title: '周额度', subtitle: '还剩 3 天', trailing: '剩 8/10 次', tone: 'good' }],
}
```

`lib/core.js` 里是共用的东西：时间/数字格式化、颜色档位、密钥查找（凭据服务 → 环境变量 → 凭据文件）、通用文案。

想让**用户自己**加渠道，把 `lib/providers/index.js` 里的数组换成「读配置生成」即可，每个 provider 文件的形状不用变。

## 安装

```bash
dsh plugin --profile web add github:tw2818/dsh-go-quota
```

然后在 profile 的 `package.json` 里把 bundle 名加进 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": ["dsh-go-quota", ...] } }
```

bundle 名和 `package.json` 的 `name` 保持一致（`dsh-go-quota`）。最后**重启引擎**生效。

## 说明

- 插件只读额度，不做任何扣费或写操作。
- Key 只在请求时读一次，不写进界面、不写日志、不进代码。
- 调试日志写在插件目录下的 `actions.log`（已在 `.gitignore` 里），不影响使用，可以随时删。

## 许可

MIT，见 [LICENSE](LICENSE)。
