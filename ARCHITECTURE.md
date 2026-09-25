# 架构说明（Phase 0）

## 组成

```
┌───────────────┐   runtime.sendMessage    ┌──────────────────────┐
│  Popup (React)│ ───────────────────────▶ │  Service Worker (SW) │
└───────────────┘ ◀─── SessionSnapshot ─── │  session-manager.ts  │
                                           └──────┬──────────┬────┘
                    runtime.sendMessage           │          │ tabs.sendMessage
                    {target:'offscreen'}          ▼          ▼
                                    ┌────────────────────┐ ┌─────────────────────┐
                                    │ Offscreen Document │ │ Content Script      │
                                    │ audio-capture.ts   │ │ player-detect.ts    │
                                    │ backend-client.ts  │ │ overlay.ts (Shadow) │
                                    └──────┬─────────────┘ │ subtitle-state.ts   │
                                           │ ws://127.0.0.1:8787/ws  └───────────┘
                                           ▼
                                    ┌────────────────────┐
                                    │ Local backend      │
                                    │ Fastify + ws       │
                                    │ MockSession        │
                                    └────────────────────┘
```

### 各部分职责

| 部分 | 文件 | 职责 | 不做什么 |
|---|---|---|---|
| Popup | `packages/extension/src/popup/` | Start/Stop 按钮、状态轮询（250 ms）、音频电平、错误显示 | 不持有任何资源 |
| Service Worker | `src/background/service-worker.ts`（Chrome 接线）、`session-manager.ts`（纯状态机）、`chrome-ports.ts`（chrome.* 实现） | 唯一 session 的生命周期；取 `streamId`；创建/关闭 Offscreen；转发字幕到 tab；tab 关闭时自动停止 | 不碰音频、不连 WebSocket |
| Offscreen Document | `src/offscreen/` | `getUserMedia(streamId)` → Web Audio 回放 + AnalyserNode 电平 → WebSocket 连后端并做协议握手；把 `transcript` 转给 SW | 不访问 tabs API（Offscreen 无此权限） |
| Content Script | `src/content/` | 通过 `PlayerAdapter` 识别播放器容器；`OverlayBinder` 让 Shadow DOM 字幕层跟随导航重挂；按 segmentId/revision 规则更新；订阅设置变更即时改样式；Stop 时移除 | 不改播放器 UI |
| Settings | `src/shared/settings.ts`、`settings-store.ts` | 设置模型、默认值、`normalizeSettings` 校验/钳制/迁移；`chrome.storage.local` 封装与 `onChanged` 订阅 | 无 UI |
| Protocol | `packages/protocol/` | 类型 + 手写校验（`validateClientMessage` / `validateServerMessage`） | 无运行时依赖 |
| Backend | `packages/server/` | `/ws` WebSocket、`/healthz`；每连接一个 `ConnectionHandler` → 至多一个 `Session`；`Session` 持有一个 `AsrAdapter`（`sensevoice` 或 `mock`） | 无翻译、无持久化 |
| Translation | `packages/server/src/translation/` | `TranslationAdapter` 接口；`TranslationPipeline`（final 队列、partial 节流、revision 归属、超时/失败降级，纯逻辑）；`hymt2-adapter.ts`（node-llama-cpp，进程内异步推理，跨会话共享模型）；`google-adapter.ts`（REST v2）；`mock-adapter.ts` | key 只在后端 |
| ASR | `packages/server/src/asr/` | `AsrAdapter` 接口；`Segmenter`（VAD 分段 + partial/final 状态机，纯逻辑）；`sherpa-worker.ts`（worker 线程内持有原生 VAD/识别器）；`sherpa-adapter.ts`（主线程与 worker 的桥）；`mock-adapter.ts` | 不接触网络 |

## 为什么这样分

- **SW 会被 Chrome 回收**（空闲约 30 s），所以 SW 不能持有 MediaStream / AudioContext / WebSocket。这些都放在 Offscreen Document，它在被显式 `closeDocument()` 之前一直存活。
- **session 状态存 `chrome.storage.session`**（`PersistedSession`），SW 重启后仍能把 Offscreen 送来的字幕路由到正确的 tab，也能在 Stop 时找到并关闭 Offscreen。
- **只允许一个 Offscreen Document**（Chrome 限制），`chrome-ports.ts` 先 `runtime.getContexts` 再决定是否 `createDocument`，并用 promise 去重并发创建。
- **Content Script 必须是单文件 IIFE**（MV3 不允许 content script 为 ES module），所以 `vite.content.config.ts` 用 lib 模式单独打包；其余入口（SW / popup / offscreen）走 `vite.config.ts` 多入口 ESM。
- **浏览器 API 与业务逻辑分离**：`session-manager.ts` 只依赖 `SessionPorts` 接口，可在 Node 里用假实现完整测试 start/stop/重启/tab 关闭等路径；`chrome-ports.ts` 是唯一调用 `chrome.tabCapture` / `chrome.offscreen` 的地方。

## 音频与识别流（Phase 2）

```
Offscreen: MediaStream(48 kHz) ─▶ AudioWorklet pcm-worklet.js（混单声道、降采样 16 kHz、PCM16、100 ms 一帧）
        ─▶ BackendClient.sendAudio()  ── 二进制 WebSocket 帧 ──▶ Backend ConnectionHandler.handleAudio()
        ─▶ Session.pushAudio() ─▶ SherpaAsrAdapter（主线程）──postMessage(transfer)──▶ sherpa-worker（worker 线程）
                                                                                        │ Segmenter
                                                                                        │  ├─ Silero VAD 512 样本窗
                                                                                        │  ├─ 说话中每 ≥0.6 s：解码「本句至今」→ partial(revision++)
                                                                                        │  ├─ 段 ≥5 s：在最近 1.5 s 找最安静 100 ms 窗软切分 → final + 新段接着
                                                                                        │  └─ VAD 收尾（停顿 ≥0.3 s）/ 超 8 s：解码本段剩余音频 → final
                                                                                        ▼
                                                                    transcript / metrics ──▶ Session ──▶ 扩展（沿 Phase 0 路径到字幕层）
```

- **协议 v2**：`session.start` 带 `audio:{pcm_s16le,16000,1}`；音频走二进制帧，控制消息走文本帧；`session.ready.asr{provider,language}`；新增 `session.metrics{audioSeconds,partials,finals,avgDecodeMs,avgLatencyMs}`；错误码新增 `invalid_audio / unsupported_audio_format / asr_unavailable / asr_failed`。
- **为什么用 worker 线程**：sherpa-onnx 的解码是同步 CPU 计算（0.2–1.5 s），放主线程会卡住 WebSocket 与心跳。N-API 插件可在 worker 中加载（已实测）。开发态（tsx）worker 通过一段 eval 引导脚本注册 tsx loader 再加载 `.ts`；打包后直接加载 `.js`。
- **背压**：每个音频消息带 `sentAt`；worker 处理时若滞后 > 700 ms 则 `Segmenter.setPartialsEnabled(false)`，只做 final；滞后 < 250 ms 恢复。
- **重连**：`BackendClient` 在非主动关闭时按 `DEFAULT_RECONNECT`（0.5/1/2/4 s，最多 5 次）重连并重新 `session.start`；成功后经 `offscreen.reconnected` 通知 SW 更新 sessionId 并让 content script 重挂字幕层；失败则走原 `offscreen.disconnected` → 停止会话。
- **worker 崩溃**：`SherpaWorkerHost` 监听 `error/exit`，向活动会话发 `asr_failed`，下次会话重新起 worker。
- **延迟指标**：`latencyMs` = 该次解码所用最新音频到达 worker 的时刻 → 结果发出；`decodeMs` = 纯解码耗时；`Session` 取最近 50 个样本均值，每 5 s 发一次。

## 回归测试基础设施（Phase 6）

- `e2e/fixture-server.ts` 用 openssl 生成 `CN=www.youtube.com` 的自签证书，以 HTTPS 提供 `fixtures/youtube-watch.html`（含 `#movie_player` + 播放静音 WAV 的 `<video>`，支持 Range 以便 seek）。
- Playwright 以 `--host-resolver-rules=MAP www.youtube.com 127.0.0.1` + `--ignore-certificate-errors` 启动 Chromium，扩展的 content script 因 `*://*.youtube.com/*` 匹配被注入 fixture 页；测试通过 Service Worker 的 `chrome.tabs.sendMessage` 驱动 content script（无需 tabCapture）。youtube.com 在 HSTS 预加载列表中，故必须 HTTPS。
- e2e 后端固定 `:8797`（mock 引擎、`LOGS_DIR=off`），不再与开发后端争抢 8787。

## 可读性机制（Phase 6）

- 字号：`--lst-scale = clamp(playerWidth / 1280, 0.55, 2.2)`（`ResizeObserver` 监听容器）；`autoScale` 关闭则为 1。
- 上移：content script 每 250 ms 读取 `adapter.controlsLift(document)`（YouTube：`#movie_player` 无 `ytp-autohide` 时为 `.ytp-chrome-bottom` 高度 + 12；Twitch：控制层可见时其高度 + 12）→ `--lst-lift`。
- 稳定：`SubtitleStore.apply` 对同前缀变短的 partial 保留长文本；最后一个字幕框 `.lst-current` 设 `min-height`（按显示行数与字号计算）。
- 描边用 8 方向 `text-shadow`；行数用 `-webkit-line-clamp`。

## 稳定性机制（Phase 5）

- **心跳**：`BackendClient` 在 `session.ready` 后每 15 s 发 `session.ping`；任何入站消息都刷新 `lastInboundAt`；30 s 无入站 → 主动关闭并合成 close 事件 → 进入既有的重连逻辑。后端 `app.ts` 对每个连接维护空闲计时器（默认 30 s）。
- **会话上限**：`sessionLimitMs` 随 `offscreen.start` 传入，Offscreen 计时到点发 `offscreen.limitReached` → SW `onLimitReached` 走正常 stop 并写入中文 `lastError`。
- **限流**：`RateLimiter`（令牌桶）挂在每个云端引擎工厂上，跨会话共享；等待超过 4 s 直接失败（pipeline 跳过该句）；429 → 15 s 冷却。后端对音频帧做每秒 25 帧的滑动窗口上限。
- **诊断**：`/healthz` 返回 `uptimeSec / activeSessions / engines{configured,ready,hint}`；popup 每 3 s 拉取，用于开始前的后端状态与引擎可用性；`describeConfiguredEngines` 在启动日志中打印脱敏配置。
- **隐私**：`Session` 只有 `logTranscripts` 为真时才把 final 文本写日志；pipeline 的失败日志只含 segmentId。

## 播放同步（Phase 4）

```
Offscreen: 第一个被后端接受的音频帧 → offscreen.audioOrigin{ audioOriginWall = Date.now() - 100 }
    → SW 存入 session 状态并转发 content.audioOrigin（content script 重载时经 content.hello 取回）
Content: PlaybackTracker 监听 <video> 的 play/pause/seeking/seeked/ratechange/timeupdate
    → PlaybackTimeline.record({ wall, videoTime, playing, rate })  （墙钟 → 视频时间）
    → seeked 且 |Δt| ≥ 2 s：timeline.markSeek(now)；store.clear()；重绘
transcript{startMs,endMs}：wall = audioOriginWall + ms
    → final 且非直播：cache.upsert({ segmentId, startTime: videoTimeAt(wallStart), endTime: videoTimeAt(wallEnd), 文本 })
    → timeline.isStale(wallEnd)（跳转前的音频）→ 丢弃，不进 live store
显示：store.visible() 有内容用它；否则（VOD）cache.at(video.currentTime) → 回放时立即显示
```

- 音频时钟 = 墙钟：tab 捕获连续进行（暂停时是静音），worklet 每 100 ms 发一帧，所以后端的 `startMs/endMs` 与墙钟线性对应，只需知道零点。
- 重连后后端音频时钟归零：SW 在 `onReconnected` 丢弃旧零点，等 offscreen 报告新零点；content script 收到新 sessionId 时保留缓存、清空 live store。
- 直播判定：YouTube `#movie_player.ytp-live` / `.ytp-live-badge` / `duration === Infinity`；Twitch 非 `/videos/`、`/<channel>/clip/` 路径即直播。

## 翻译流（Phase 3）

```
Segmenter → AsrTranscript ─▶ TranslationPipeline.onTranscript()
                               ├─ 立即转发原文（pipeline 自己编号 revision）
                               ├─ final → finalQueue（最多 3 个，旧的出队放弃）
                               ├─ partial（开关开启时）→ 每段 ≥2 s 一次，final 到来即作废
                               └─ 一次只跑一个 translate()；完成 → 同 segmentId、revision+1、带 translatedText
Hy-MT2 adapter：官方提示词 + 前 2 句上下文 → node-llama-cpp（异步、llama.cpp 自己的线程）→ 去掉反引号/引号
```

- **引擎选择**：`TranslationRegistry` 注册 `hy-mt2 / gemini / llm / google / none / mock`（`gemini` 与 `llm` 共用 `openai-compatible-adapter.ts`：system prompt + 前 2 句作为对话历史，429/5xx 重试一次；`hy-mt2` 使用 `preferredContextSize = 0` 以缩短 prefill），默认引擎（`TRANSLATION_PROVIDER`）启动时预加载，其余在首次被会话选用时才 `prepare()`（1 GB 模型只在需要时加载；准备失败不缓存，下次重试）。客户端通过 `session.start.options.translationProvider` 选择；未知或不可用 → `translation_unavailable`。
- **协议 v4**：`session.start.options.translationProvider`。
- **协议 v3**：`session.start.options.translatePartials`；`session.ready.translation{provider,targetLanguage}`；`session.metrics` 增加 `translated / avgTranslateMs / translationBacklog`；错误码 `translation_unavailable / translation_failed / unsupported_language`。
- **为什么不用 worker**：node-llama-cpp 的推理在原生线程执行、JS API 为 async，不会阻塞事件循环；模型与 context 全局共享，`HyMt2Runtime.lock` 保证跨会话串行。
- **失败降级**：翻译连续失败 3 次 → `session.error translation_failed`，会话继续只出原文；ASR 失败才终止会话。
- **模型选择**：官方 2-bit/1.25-bit GGUF 需要 llama.cpp PR #19357 的 STQ kernel（未合入），实测在 node-llama-cpp 3.21 上加载失败，故用官方标准量化（当前 Q4_K_M；Q6_K 实测慢 1.4 倍）。

## 设置流（Phase 1）

```
Popup 控件 ──SettingsStore.update──▶ chrome.storage.local["settings"]
                                          │ storage.onChanged
                    ┌─────────────────────┴──────────────────────┐
                    ▼                                            ▼
        Content Script: overlay.setStyle()             Popup 其他实例同步显示
        （样式即时生效，会话进行中也一样）
SW 在 start() 时调用 loadLanguages() 读取一次语言 → 写入 session 状态 → 传给 Offscreen 的 session.start
（之后改语言不影响当前会话；popup 比较 snapshot 与设置，显示「下次开始时生效」）
```

- 所有读取都经过 `normalizeSettings`：未知语言回退默认、数值钳制到 `STYLE_LIMITS`、缺失字段补默认。带 `version` 字段以便将来迁移。
- 样式通过 Shadow DOM 宿主上的 CSS 变量（`--lst-font-size` / `--lst-bottom` / `--lst-bg-alpha`）生效，改样式不重建 DOM。

## 播放器适配（Phase 1）

`src/content/players/`：`PlayerAdapter { platform, findContainer(root), watch(doc, onChange) }`。
- YouTube：容器 `#movie_player`；`watch` 监听 `yt-navigate-finish` / `yt-page-data-updated` / `fullscreenchange`，并每秒做一次健康检查（YouTube 在迷你播放器等过渡中会替换元素且无事件）。
- Twitch：容器 `[data-a-target="video-player"]` 等；`fullscreenchange` + 每秒健康检查。Phase 1 只做检测与重挂，不验证音频。
- `OverlayBinder`：容器变了就 remount 并重绘最近字幕；播放器消失就移除字幕层；`unbind` 停止一切监听。

## 一次 Start 的完整流程

1. Popup → SW `popup.start`。
2. SW（`SessionManager.start`，串行锁防并发）：状态必须是 `idle`；若发现残留 Offscreen 先关闭。
3. 取当前 tab → `content.detect` 询问 content script（平台 + 是否找到播放器）。
4. `loadLanguages()` 读取设置中的语言 → 状态写为 `starting`（含语言）→ 使用 popup 传来的 streamId（fallback：SW 内 `getMediaStreamId`）。
5. `ensureOffscreen()` → 向 Offscreen 发 `offscreen.start{streamId, backendUrl, languages}`。
6. Offscreen：`getUserMedia` → `AudioContext`：`source → destination`（可听）、`source → analyser`（电平）→ `BackendClient.connect()` 发 `session.start`，等 `session.ready`（超时 5 s）。
7. 成功：SW 状态写为 `active{sessionId, tabId}` → 通知 content script `content.sessionStarted`。
8. 后端每 `MOCK_TICK_MS` 发一条 `transcript` → Offscreen → SW `offscreen.transcript` → `tabs.sendMessage` → content script `SubtitleStore.apply` → `overlay.render`。
9. 任一步失败：`releaseAll()`（停 Offscreen、关文档、通知 content 移除）→ 状态 `idle` + `lastError`。

## Stop / 资源释放

`SessionManager.stop()` → `releaseAll()`：
1. Offscreen `offscreen.stop`：发 `session.stop`、等 `session.stopped`（最多 800 ms）、`ws.close()`；`track.stop()` 全部音轨；断开节点；`AudioContext.close()`；返回 `ReleasedResources{tracksStopped, audioContextState, webSocketState}`。
2. `chrome.offscreen.closeDocument()`。
3. content script `content.sessionStopped` → `overlay.unmount()`。
4. 清除 `storage.session`。

每一步都 try/catch，任一步失败不影响其他步骤。触发来源：用户点 Stop、tab 关闭（`tabs.onRemoved`）、后端断线（Offscreen 发 `offscreen.disconnected`）、扩展安装/更新、浏览器启动。

## 优雅失败

| 场景 | 行为 |
|---|---|
| 后端没启动 | `connect()` 在 socket close 时 reject，popup 显示 `Could not connect to the local backend … Is it running?`，资源全部释放 |
| 后端中途断开 | Offscreen 上报 → SW 自动 stop，`lastError = Backend connection lost` |
| 页面刷新 | 新 content script 发 `content.hello`，若该 tab 有活动 session 则重新挂字幕层 |
| YouTube 站内切视频 | 监听 `yt-navigate-finish`，重新查找容器并重挂 |
| 扩展重载 | 旧 content script 调 `chrome.runtime` 抛错 → 自行移除字幕层；SW `onInstalled` 强制 stop |
| 页面早于扩展打开 | `content.detect` 无响应 → start 返回明确错误，提示刷新页面 |

## 协议 v1

见 `packages/protocol/src/index.ts`。相对规格示例的**小增补**（Phase 0 需要，已版本化在 v1 内）：
- `session.pong`（对 `session.ping` 的应答）
- `session.stopped`（对 `session.stop` 的确认，让扩展能等到后端确认再关 socket）
- `session.error.code` 为 `string`，已知取值见 `SessionErrorCode`

接收方规则（`SubtitleStore` 实现并有单测）：同 `segmentId` 只接受更高 `revision`；`final` 之后不接受任何非 `final`；更高 revision 的 `final` 可替换旧 `final`。

## 扩展内部消息

`src/shared/messages.ts`。所有 `chrome.runtime.sendMessage` 消息都带 `target: 'background' | 'offscreen' | 'content'`，每个上下文只处理发给自己的消息（因为 runtime 消息会广播到所有扩展上下文）。

## 权限

`tabCapture`（取 streamId）、`offscreen`（隐形音频页面）、`storage`（`storage.session`）、`activeTab`；`host_permissions` 仅 youtube.com / twitch.tv（读 tab URL、注入 content script）。
