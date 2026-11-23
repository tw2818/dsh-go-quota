# dsh-go-minimax-quota-6

DSH GO 手机端的**额度**原生插件：把 MiniMax Token Plan 和 OpenCode Go 两边的剩余额度合并显示。

- **状态条**：两个渠道各一个剩余百分比，取更紧的那个定颜色，一眼看出还能用多久
- **面板**：每个渠道一张卡片（大数字 + 进度条），下面列出其余时间窗口和模型

## 数据来源

| 渠道 | 接口 | 凭据 |
| --- | --- | --- |
| MiniMax | `GET https://api.minimax.cn/v1/token_plan/remains` | 凭据库 `CUSTOM_MINIMAX_API_KEY`（Token Plan 的 Subscription Key） |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | 凭据库 `CUSTOM_OPENCODE_API_KEY`，或环境变量 `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` / `DSH_GO_OPENCODE_KEY` |

OpenCode 那个接口给的是「已用百分比」，插件换算成「剩余百分比」，跟 MiniMax 一个口径。

Key 只在请求时读一次，不写进界面、不写日志、不进代码。

## 安装

```bash
dsh plugin --profile web add github:tw2818/dsh-go-minimax-quota-6
```

然后在 profile 的 `package.json` 里把 bundle 名加进 `dsh.profile.bundles`：

```json
"dsh": { "profile": { "bundles": ["dsh-go-minimax-quota-6", ...] } }
```

bundle 名和 `package.json` 的 `name` 保持一致。最后**重启引擎**生效。

## 说明

- 插件只读额度，不做任何扣费、写操作。
- 调试日志写在插件目录下的 `actions.log`（已在 `.gitignore` 里），不影响使用，可以随时删。

## 许可

MIT，见 [LICENSE](LICENSE)。
