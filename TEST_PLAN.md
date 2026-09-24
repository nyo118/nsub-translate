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

## Phase 2 增补

### 自动化
| 层 | 覆盖 |
|---|---|
| 协议 v2 | `audio` 格式校验、二进制帧校验（空/奇数长度/超大/未对齐）、`session.ready.asr`、`session.metrics` |
| Segmenter（纯逻辑，假 VAD/识别器） | partial 递增与 final 同 segmentId；pre-roll；节流与去重；多句；flush；超长强制切分；背压跳过 partial；metrics |
| Session | 转发 transcript、metrics 聚合、stop 后不再转发、adapter 错误上抛 |
| ConnectionHandler | v2 start / 版本与音频格式错误码 / 二进制音频只在 running 时接受 / `asr_unavailable` |
| 后端集成（mock） | 真实 WebSocket + 二进制帧 |
| **真实模型集成** | `sherpa.integration.test.ts`：把 en.wav 以 100 ms 帧灌入 worker 管线，断言 partial → final、语种 en、背压下 15 s 内完成（模型缺失时自动 skip） |
| 扩展 | `Downsampler`/`ChunkAssembler`（48k→16k 数量与频率保持、int16 钳制、分块）；`BackendClient` v2 握手、二进制发送与丢帧计数、重连退避/放弃/取消；SessionManager metrics/重连状态 |
| E2E | webServer 以 `ASR_PROVIDER=mock` 启动；握手测试发送一帧二进制音频 |

### 人工
| # | 步骤 | 预期 |
|---|---|---|
| P2-1 | `npm run dev:server`（默认 sensevoice） | 日志 `SenseVoice model loaded`，`/healthz` 的 `asrProvider` 为 `sensevoice` |
| P2-2 | 英文 YouTube 视频（清晰人声）开始字幕 | 约 1 s 内出现斜体 partial 并逐渐变长，停顿后变加粗 final，内容与语音基本一致 |
| P2-3 | 日文 / 中文视频，来源设为 Auto Detect | 识别为对应语言文字；popup 显示「自动检测」 |
| P2-4 | 来源选 `日本語 (ja)` | popup 显示「识别：SenseVoice · ja」，后端日志 `asr.language: ja` |
| P2-5 | popup 延迟显示 | 「延迟 ≈ x s」出现并在 0.5–2 s 之间 |
| P2-6 | 会话中重启后端（Ctrl-C 后再启动，10 s 内） | popup 显示「正在重新连接本地后端…」，后端起来后字幕恢复，sessionId 变化，无需手动 Stop |
| P2-7 | 会话中关闭后端不再启动 | 约 8 s 后 popup 报错 `Backend connection lost`，状态回 Ready，无残留 Offscreen |
| P2-8 | 停止后端时打开 Activity Monitor 看 node 进程 CPU | 会话中 2 线程约 50–150 %，停止后回落 |
| P2-9 | 视频暂停 | 无 partial 产生，CPU 回落（VAD 无语音） |
| P2-10 | `ASR_PROVIDER=mock npm run dev:server` | 行为与 Phase 1 相同（固定脚本） |

## Phase 3 增补

### 自动化
| 层 | 覆盖 |
|---|---|
| 协议 v3 | `options.translatePartials` 校验、`session.ready.translation`、metrics 新字段 |
| TranslationPipeline（假 adapter） | 原文即时转发 + 译文作为更高 revision；串行与上下文；积压丢弃；partial 节流/被 final 取代/过期结果丢弃；超时与连续失败降级；stop 中止 |
| Hy-MT2 adapter | 提示词构造、输出清理；**真实模型集成**（英→简中含「首领/金」，abort 生效；模型缺失自动 skip） |
| Google adapter（假 fetch） | 请求体、auto 源语言、错误不泄露 key、无 key 拒绝启动 |
| Session / Handler / App | 译文 revision、metrics、`unsupported_language`、healthz 含 translationProvider |
| 扩展 | 设置 `translatePartials`、握手带 options、snapshot/popup 翻译信息 |

### 人工
| # | 步骤 | 预期 |
|---|---|---|
| P3-1 | `npm run dev:server` | 日志 `Hy-MT2 model loaded` 与 `Hy-MT2 warm-up done`；healthz `translationProvider: hy-mt2` |
| P3-2 | 英文视频，目标简体中文 | 每个 final 出现后 2–4 s 下方补出中文；原文与译文同框 |
| P3-3 | 日文视频 | 同上，译文为中文 |
| P3-4 | 目标改为繁體中文 / English 后重新开始 | 译文语言相应变化 |
| P3-5 | 开启「边说边翻译」后重新开始 | 说话中译文也出现并反复修正；关闭后只在 final 后出现 |
| P3-6 | popup 指标 | 「翻译 Hy-MT2 · x s」出现；积压 >1 时显示「排队 n」 |
| P3-7 | `TRANSLATION_PROVIDER=none` 重启后端并开始 | 只显示原文，popup 显示「翻译 无」 |
| P3-8 | `TRANSLATION_PROVIDER=google` 且无 key | 后端启动失败并提示 `GOOGLE_TRANSLATE_API_KEY` |
| P3-9 | 删除/改名 GGUF 后启动 | 启动失败并提示 `npm run models:download` |
| P3-10 | 翻译期间观察识别延迟 | 上升但字幕仍连续；机器空闲时 < 1.5 s |
| P3-11 | popup「翻译引擎」选 Google，后端**未配** key，开始 | popup 报 `translation_unavailable … GOOGLE_TRANSLATE_API_KEY`，状态回 Ready |
| P3-12 | 在 `packages/server/.env` 写入 key、重启后端、再选 Google 开始 | popup 显示「翻译 Google · 0.x s」，译文明显更快 |
| P3-13 | 会话中切换引擎 | 当前会话不变，popup 提示「新设置将在下次开始时生效」 |
| P3-14 | 引擎选 Gemini（.env 已有 GEMINI_API_KEY） | popup「翻译 Gemini · ~1 s」，译文明显快于本机 |
| P3-16 | 引擎选「自定义 LLM」（LM Studio 局域网） | 后端日志 `translation engine warm-up done { provider: 'llm' … ms: ~400 }`；popup「翻译 LLM · 0.5 s」 |
| P3-17 | 把 GEMINI_MODEL 改成不存在或思考型模型后重启、选 Gemini 开始 | 开始时即报 `translation_unavailable … failed its warm-up`（或后端警告 too slow），而不是静默无译文 |

## 结果记录

每次交付报告里按「passed / failed / blocked / not-run」逐项记录，不得把未执行的项写成通过。
