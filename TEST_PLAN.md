# 测试计划（Phase 0）

## 自动化

| 层 | 工具 | 覆盖 | 命令 |
|---|---|---|---|
| 协议校验 | Vitest | `parseJsonObject` / `validateClientMessage` / `validateServerMessage` 正反例 | `npm test` |
| 后端逻辑 | Vitest + fake timers | 脚本确定性与 revision 单调；`MockSession` 定时/stop 后不再发/幂等；`ConnectionHandler` 协议错误、重复 start、stop、dispose | `npm test` |
| 后端集成 | Vitest + 真实 Fastify + `ws` 客户端 | healthz；完整 start→ready→transcript→stop→stopped；非法帧不断线；断线释放 session；多连接独立 | `npm test` |
| 扩展纯逻辑 | Vitest | `SessionManager`（假 ports）：单 session、并发 start、start/stop 循环资源计数、失败清理、tab 关闭、后端断线、SW 重启恢复 | `npm test` |
| 扩展 DOM | Vitest + happy-dom | 平台/播放器检测；`SubtitleStore` 排序规则；`SubtitleOverlay` 单例、挂载/卸载不污染播放器 | `npm test` |
| 后端客户端 | Vitest + 假 WebSocket | 握手、超时、拒绝、断线上报、优雅 disconnect | `npm test` |
| 静态检查 | ESLint / tsc | 全仓 | `npm run lint` / `npm run typecheck` |
| 构建 | Vite / tsc | 三个包 | `npm run build` |
| E2E smoke | Playwright（headless Chromium，加载 dist） | SW 启动且无残留 Offscreen；popup 渲染并在非支持页面优雅拒绝 start；扩展页面能与本地后端完成协议握手 | `npm run test:e2e` |

**Playwright 无法覆盖**：真实 tab 音频捕获（需要用户在该 tab 上点击扩展）、可听性、YouTube 真实 DOM。这些只能人工验证。

## 人工验证（对应规格 Phase 0 Manual 1–14）

前置：`npm run dev:server` 运行中；`npm run build` 完成；扩展已在 `chrome://extensions` 加载；DevTools 可用。

| # | 步骤 | 预期 | 证据来源 |
|---|---|---|---|
| 1 | 启动后端 | 日志 `Server listening at http://127.0.0.1:8787` | 终端 |
| 2 | 构建扩展 | `npm run build` 退出 0 | 终端 |
| 3 | 加载扩展 | `chrome://extensions` 无 Errors 红字 | chrome://extensions |
| 4 | 打开普通 YouTube 视频并播放 | popup 显示 `youtube · player found` | popup |
| 5 | 点 Start Translation | 状态变 `active`，显示 Session id | popup |
| 6 | 听声音 | 视频声音不中断、音量正常；`Tab audio level` 随声音变化 | 耳朵 + popup |
| 7 | 看字幕 | 视频画面下方出现英文 + 中文，先斜体 partial 后加粗 final，约 1.5 s 一条 | 视频画面 |
| 8 | 暂停/继续视频 | 字幕继续（mock 与播放进度无关），无报错 | 视频 + DevTools Console |
| 9 | 点 Stop | 状态 `idle` | popup |
| 10 | 字幕消失 | 视频内没有字幕层；DevTools：`document.querySelectorAll('#lst-subtitle-overlay').length === 0` | DevTools |
| 11 | 捕获停止 | tab 标题旁的「录制/共享」指示消失；`chrome://extensions` → 扩展详情 → Inspect views 里没有 `offscreen.html`；后端日志 `session stopped` | Chrome UI + 后端日志 |
| 12 | 再 Start / Stop | 同 5–11 | — |
| 13 | 无重复 | 在 active 时：`document.querySelectorAll('#lst-subtitle-overlay').length === 1`；`curl 127.0.0.1:8787/healthz` 的 `openConnections === 1`；Inspect views 只有一个 `offscreen.html` | DevTools + curl |
| 14 | 刷新 / 站内切视频 | 刷新：字幕层自动重新出现（session 仍 active）；切视频：字幕层重挂或至少无红色错误；DevTools Console 无未捕获异常 | DevTools |
| Twitch | 打开 twitch.tv 直播页 | popup 显示 `twitch · player found`；Start 后字幕层显示「Twitch player detected…」提示 | popup + 画面 |
| 后端未启动 | 停掉后端后点 Start | popup 显示 `Could not connect to the local backend…`，状态回 `idle`，无残留 Offscreen | popup + Inspect views |

## Phase 1 增补

### 自动化
| 层 | 覆盖 |
|---|---|
| 设置 | `normalizeSettings`（默认/钳制/未知语言/auto 不可为目标）、`SettingsStore`（持久化、深合并、reset、订阅） |
| 字幕层 | CSS 变量生效、显示原文/翻译开关、两者都关时不渲染 |
| 重绑定 | `OverlayBinder`：YouTube 容器被替换（事件与轮询两条路）、播放器消失、unbind 后不再响应；Twitch 频道切换 |
| SW | 语言在 start 时读取并写入 snapshot，之后改设置不影响运行中会话 |
| E2E | popup 改语言/字号/开关 → `chrome.storage.local` 内容正确 → 重载 popup 后保留 → 恢复默认 |

### 人工
| # | 步骤 | 预期 |
|---|---|---|
| P1-1 | 展开「字幕样式」，会话进行中拖动字体大小 / 位置 / 背景透明度 | 视频里的字幕**立即**变化 |
| P1-2 | 取消「显示原文」/「显示翻译」 | 对应行立即消失；两个都取消则不显示字幕框 |
| P1-3 | 关闭并重开 Chrome，打开 popup | 语言与样式保持 |
| P1-4 | 改语言后开始会话 | 后端日志 `session started` 里的 `sourceLanguage/targetLanguage` 为新值 |
| P1-5 | 会话进行中改语言 | 当前字幕不受影响，popup 显示「新语言将在下次开始时生效」 |
| P1-6 | 会话进行中在 YouTube 侧栏切换视频、进出全屏、切换剧场模式 | 字幕层仍在播放器内且只有一层（DevTools 查 `#lst-subtitle-overlay` 数量） |
| P1-7 | 会话进行中点击 YouTube 首页（离开视频页）再进入另一个视频 | 离开时字幕消失，进入后自动重新出现 |
| P1-8 | Twitch 频道页开始会话，再切换到另一个频道 | 提示层跟随播放器，无 Console 报错 |
| P1-9 | 恢复默认 | 所有控件回到默认值，视频字幕样式同步恢复 |

## 结果记录

每次交付报告里按「passed / failed / blocked / not-run」逐项记录，不得把未执行的项写成通过。
