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
                                                                                        │  └─ VAD 收尾 / 超 12 s：解码整句 → final
                                                                                        ▼
                                                                    transcript / metrics ──▶ Session ──▶ 扩展（沿 Phase 0 路径到字幕层）
```

- **协议 v2**：`session.start` 带 `audio:{pcm_s16le,16000,1}`；音频走二进制帧，控制消息走文本帧；`session.ready.asr{provider,language}`；新增 `session.metrics{audioSeconds,partials,finals,avgDecodeMs,avgLatencyMs}`；错误码新增 `invalid_audio / unsupported_audio_format / asr_unavailable / asr_failed`。
- **为什么用 worker 线程**：sherpa-onnx 的解码是同步 CPU 计算（0.2–1.5 s），放主线程会卡住 WebSocket 与心跳。N-API 插件可在 worker 中加载（已实测）。开发态（tsx）worker 通过一段 eval 引导脚本注册 tsx loader 再加载 `.ts`；打包后直接加载 `.js`。
- **背压**：每个音频消息带 `sentAt`；worker 处理时若滞后 > 700 ms 则 `Segmenter.setPartialsEnabled(false)`，只做 final；滞后 < 250 ms 恢复。
- **重连**：`BackendClient` 在非主动关闭时按 `DEFAULT_RECONNECT`（0.5/1/2/4 s，最多 5 次）重连并重新 `session.start`；成功后经 `offscreen.reconnected` 通知 SW 更新 sessionId 并让 content script 重挂字幕层；失败则走原 `offscreen.disconnected` → 停止会话。
- **worker 崩溃**：`SherpaWorkerHost` 监听 `error/exit`，向活动会话发 `asr_failed`，下次会话重新起 worker。
- **延迟指标**：`latencyMs` = 该次解码所用最新音频到达 worker 的时刻 → 结果发出；`decodeMs` = 纯解码耗时；`Session` 取最近 50 个样本均值，每 5 s 发一次。

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
