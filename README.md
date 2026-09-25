# Live Subtitle Translator

个人用 Chrome 扩展：在 YouTube / Twitch 视频内叠加**双语实时字幕**。

当前版本：**0.1.0（个人使用 Beta）**。文档索引：`CONFIG.md`（配置）、`PRIVACY.md`（隐私）、`TROUBLESHOOTING.md`（排查）、`ROLLBACK.md`（回滚）、`CHANGELOG.md`、`COMPATIBILITY.md`、`BENCHMARKS.md`、`ARCHITECTURE.md`、`TEST_PLAN.md`。tab 音频以 16 kHz PCM 流送到本地后端，由**本机 SenseVoice-Small**（sherpa-onnx，中/英/日/韩/粤语自动检测）识别，再由**本机 Hy-MT2-1.8B**（腾讯混元翻译模型，GGUF via node-llama-cpp）翻译成目标语言；也可切换为 Google Cloud Translation。字幕层显示原文 + 译文。全部默认在本机运行，无需任何 API key。

## 目录结构

```
packages/protocol    扩展与后端共享的协议类型与校验（Protocol v1）
packages/server      本地后端（Node + Fastify + WebSocket），Phase 0 为 mock session
packages/extension   Chrome MV3 扩展（Vite + TypeScript + React popup）
e2e/                 Playwright smoke 测试（加载已构建的扩展）
ARCHITECTURE.md      架构、消息流、协议说明
TEST_PLAN.md         自动化与人工测试计划
```

## 前置条件

| 组件 | 要求 |
|---|---|
| Node.js | **22.12+**（Vite 8 / Vitest 5 的要求）。仓库根有 `.nvmrc`，用 `nvm use` 切换。若提示 `command not found: nvm`，先 `source ~/.nvm/nvm.sh`，或直接 `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"` |
| npm | 10+（随 Node 22 附带） |
| Chrome | 116+（`chrome.runtime.getContexts` / Offscreen API）。已在 Chrome 153 上开发 |
| 操作系统 | macOS 上开发；Windows / Linux 未验证 |

## 安装

**方式 A（推荐，一条命令）**：
```bash
nvm use            # 读取 .nvmrc → Node 22
npm run setup      # npm ci → 下载并校验模型 → 生成 packages/server/.env → 构建
```

**方式 B（手动）**：
```bash
nvm use
npm ci
npm run models:download           # SenseVoice int8（约 160 MB）+ Silero VAD + Hy-MT2-1.8B Q4_K_M（约 1.1 GB），自动按 models.lock.json 校验 SHA-256
npx playwright install chromium   # 仅当要跑 e2e 时需要（约 100 MB）
```

**模型自动下载**：后端启动时若发现 `models.lock.json` 里的语音识别模型缺失，会自动下载并校验（约 160 MB），期间 popup 显示下载进度；本机翻译模型（1.1 GB）只在第一次选用「本机 Hy-MT2」时下载。因此 `npm run models:download` 不是必需的，只是预先下载。`AUTO_DOWNLOAD_MODELS=0` 可关闭自动下载。

**后端放到另一台机器**：在那台机器上部署后端并以 `HOST=0.0.0.0` 启动（写进它的 `packages/server/.env`），本机 popup「诊断 → 后端地址」填 `192.168.x.x:8787` 并点「应用」（Chrome 会询问访问该地址的权限）。后端无鉴权，仅限可信局域网。

**从 GitHub Release 安装扩展**：下载 `nsub-translate-extension-v0.1.0.zip`，核对 `SHA256SUMS.txt`，解压后在 `chrome://extensions` Load unpacked；后端仍按上面方式从源码运行（或解压 `nsub-translate-server-v0.1.0.zip` 后 `npm ci --omit=dev && npm run models:download && node packages/server/dist/index.js`）。

模型文件不进 Git（`packages/server/models/` 已 gitignore）。

## 常用命令（在仓库根目录执行）

| 命令 | 作用 |
|---|---|
| `npm run lint` | ESLint（全仓） |
| `npm run typecheck` | 先构建 protocol，再对三个包和 e2e 做 `tsc --noEmit` |
| `npm test` | Vitest 单元 + 后端 WebSocket 集成测试 |
| `npm run build` | 依次构建 protocol → server → extension（产物在各包 `dist/`） |
| `npm run dev:server` | 启动本地后端（`tsx watch`，改代码自动重启），监听 `ws://127.0.0.1:8787/ws` |
| `npm run start:server` | 用 `packages/server/dist` 启动后端（需先 build） |
| `npm run test:e2e` | 先 build，再用 Playwright 加载扩展跑测试：popup/后端握手（mock 后端 :8797），以及把 `www.youtube.com` 解析到本地 HTTPS fixture 页的 content script 回归（字幕层、seek、回放缓存、样式即时生效） |
| `npm run doctor` | 安装体检：Node 版本/架构、sherpa-onnx 原生模块、模型、`.env`、引擎配置；报错时先跑它 |
| `npm run bench` | 标准性能基准（需后端运行） |
| `npm run service:install` | macOS 登录自启后端（launchd），`service:status` / `service:restart` / `service:uninstall` |
| `npm run release -- --tag` | 检查 + 干净构建 + 打包 zip/SHA256 到 `release/` + git tag |

后端环境变量（可写在 `packages/server/.env`，见 `.env.example`；`.env` 不入库）：
- `ASR_PROVIDER`：`sensevoice`（默认，本机识别）或 `mock`（固定脚本，测试用）。
- `TRANSLATION_PROVIDER`：后端**默认**翻译引擎：`hy-mt2`（默认，本机）、`gemini`（AI Studio 免费层）、`llm`（任意 OpenAI 兼容端点）、`google`、`mock`、`none`。popup 的「翻译引擎」下拉可在每次开始时选择，覆盖默认值；所有引擎按需懒加载，默认引擎在启动时预加载。
- `GEMINI_API_KEY` / `GEMINI_MODEL`（默认 `gemini-3.5-flash-lite`）：在 https://aistudio.google.com/apikey 免费获取，不需要绑卡；免费层有每分钟请求数限制，字幕每句一请求足够。
- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`：任意 OpenAI 兼容端点——Groq、OpenRouter、Ollama，或**局域网另一台机器上的 LM Studio**（例如 `LLM_BASE_URL=http://192.168.50.2:1234`，无路径时自动补 `/v1`；`LLM_API_KEY` 填 LM Studio 的 API token；`LLM_MODEL` 填其模型标识）。实测 LM Studio 上的 Hy-MT2 约 0.4–0.5 s 一句。
- 云端 / LLM 引擎在首次选用时会先做一次**预热验证**（20 s 内翻译「Hello, welcome.」）：模型名错误、服务不可达会直接在开始时报 `translation_unavailable`；预热超过 6 s 会在后端日志警告「too slow for live subtitles」。**不要**把 `GEMINI_MODEL` 设成思考型或大模型（如 `gemma-4-31b-it`，实测 22 s 一句且输出 `<thought>`），字幕请用 `gemini-3.5-flash-lite`。
- `TRANSLATION_THREADS`：本机翻译线程数（默认 3）。
- `GOOGLE_TRANSLATE_API_KEY`：仅 `google` 需要，**只放后端 .env，永不进扩展**。
- `MODELS_DIR`：模型目录（默认 `packages/server/models`）。
- `ASR_THREADS`：识别线程数（默认 2；4 核以上可设 4）。
- `METRICS_INTERVAL_MS`：`session.metrics` 间隔（默认 5000）。
- `PORT`（默认 8787）、`HOST`（默认 127.0.0.1，**请勿改成 0.0.0.0**）、`MOCK_TICK_MS`（mock 间隔，默认 1500）。

## 启动本地后端

> **每个新终端都要先 `nvm use`**。所有 root 脚本会先检查 Node 版本，版本不对会直接报错退出（而不是运行到一半崩溃）。

```bash
nvm use
npm run dev:server
# 期望日志：SenseVoice model loaded { ms: ~3000 }
#          Hy-MT2 model loaded { ms: ~3000 } / Hy-MT2 warm-up done
#          Server listening at http://127.0.0.1:8787
#          WebSocket endpoint: ws://127.0.0.1:8787/ws
curl http://127.0.0.1:8787/healthz   # → {"ok":true,"openConnections":0,"asrProvider":"sensevoice","translationProvider":"hy-mt2"}
```

模型缺失时启动会直接报错并提示 `npm run models:download`。

## 构建扩展

```bash
npm run build
# 扩展产物：packages/extension/dist/
```

## 在 Chrome 开发者模式加载扩展

1. 打开 `chrome://extensions`。
2. 右上角打开 **Developer mode**。
3. 点 **Load unpacked**，选择 `packages/extension/dist` 目录。
4. 工具栏出现红底「N 文」图标「Live Subtitle Translator (Phase 0)」。建议点拼图图标把它固定到工具栏。
5. 之后每次重新 `npm run build`，需要在 `chrome://extensions` 点该扩展的 **刷新** 按钮，并**刷新已打开的 YouTube 页面**（旧页面里的 content script 会失效）。

## 如何人工测试 Phase 0

完整步骤与验收清单见 [TEST_PLAN.md](./TEST_PLAN.md)。简版：

1. `npm run dev:server` 保持运行。
2. 打开一个普通 YouTube 视频并开始播放。
3. 点扩展图标 → popup 提示「YouTube 播放器已就绪」→ 点 **▶ 开始字幕**。
4. 预期：视频声音**继续**可听；按钮变为 `● 正在翻译`、下方细条随声音跳动；说话约 1 秒后出现斜体 partial 原文并不断修正，句子停顿后变为加粗 final，再过约 2–4 秒同一段下方补出中文译文；popup 显示「识别 SenseVoice · 自动检测 · x s ｜ 翻译 Hy-MT2 · y s」。
5. 点 **停止**：字幕层消失、状态回到 `● Ready`、后端日志出现 `session stopped`。
6. 再开始 / 停止一次，确认没有重复字幕层、重复 session。

## 设置（Phase 1）

- **来源 / 翻译成 / 翻译引擎**：来源含 `Auto Detect`；翻译引擎可选「本机 AI 翻译（Hy-MT2）」或「Google 翻译 API」。这些改动**在下次开始时生效**，会话进行中修改不会影响当前会话（popup 会提示）。
- **字幕样式**（点「字幕样式 ›」展开）：字体大小、字幕位置（距播放器底部的百分比）、背景透明度、显示原文、显示翻译、恢复默认。样式改动**立即生效**，包括会话进行中。
- 所有设置存放在 `chrome.storage.local`，重启 Chrome 后保留；损坏或旧版本的数据会被自动修正为合法值。

## 语音识别（Phase 2）

- 模型：SenseVoice-Small int8（`sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`），语种由模型自动检测；popup 选择 zh / en / ja / ko 会强制该语种，其他语言回退为自动检测。
- 分段：Silero VAD 切句（停顿 ≥ 0.3 s）；说话中每约 0.6 s 对当前句重识别一次作为 partial；密集语音下一段超过 5 s 就在最近 1.5 s 内最安静的词间间隙提前收句，硬上限 8 s。每段通常 2–5 s、一到两句。
- 性能：i7-8559U 上实时因子约 0.1–0.3，2 线程时 1–7 s 片段的解码 160–900 ms。识别在 worker 线程，不阻塞 WebSocket。
- 背压：若 CPU 跟不上（帧在队列里等待 > 0.7 s），自动暂停 partial 只保留 final，追上后恢复。
- 断线重连：后端重启时扩展会以 0.5/1/2/4 s 退避重试最多 5 次并自动开新会话；期间 popup 显示「正在重新连接」，音频丢弃不缓存。
- 音频**只在本机**流转（扩展 → 127.0.0.1 → 本机模型），不上传、不落盘。

## 翻译（Phase 3）

- 默认本机 Hy-MT2-1.8B（官方 Q4_K_M GGUF；Apache-2.0，36 语种），提示词用官方模板（不带上下文，以缩短首 token 时间；Gemini/LLM 引擎则附带前 2 句作为对话历史）。腾讯官方 2-bit / 1.25-bit 版依赖尚未合入 llama.cpp 的 STQ kernel，node-llama-cpp 无法加载；官方仓库另有 Q6_K（实测慢约 1.4 倍、质量略好）与 Q8_0，改 `HYMT2_MODEL_FILE` 即可切换。
- 流程：每个 final 入队 → 串行翻译（一次一句）→ 以同一 `segmentId` 的更高 `revision` 补上 `translatedText`。**以新为先**：翻译进行中只保留最新一句等待，更旧的放弃翻译（原文保留）。单句超时 15 s；连续失败 3 次后本会话只显示原文并提示。
- 字幕层显示最近 2 段；若两段都还没有译文，会把最近一条已翻译的句子保留在上方，避免译文因延迟永远看不到。
- 「边说边翻译」开关（popup）：开启后未说完的句子每 ≥ 2 s 也翻译一次，译文会反复变化且更耗 CPU；默认关闭。**自适应**：翻译一句的平均耗时超过 2 s 时自动只翻 final，速度恢复后再翻 partial。
- 性能：i7-8559U 上一句 1.5–4.5 s（机器空闲时更快）。翻译进行中会与识别争抢 CPU，识别延迟可能从 0.4 s 升到 1 s。
- **推荐云端方案：Gemini（AI Studio 免费层）**——popup 选「Gemini」，后端 `.env` 写 `GEMINI_API_KEY`；实测 `gemini-3.5-flash-lite` 约 1 s 一句、译文自然。429/5xx 会重试一次。
- 本机模型的提示词已去掉上下文、译文上限 128 token，以缩短首 token 时间。更小的社区量化（mradermacher IQ3_XS / Q3_K_S）实测 EOS 配置有误、会一直生成到上限（反而慢 5–10 倍），因此**没有提供「小模型」选项**；官方 2-bit 需要未合入的 llama.cpp 内核。
- Google 方案：在 popup「翻译引擎」选「Google 翻译 API」，并在 `packages/server/.env` 写入 `GOOGLE_TRANSLATE_API_KEY=...`（重启后端生效）；延迟约 0.3 s，不占本机 CPU，每月前 50 万字符免费。key 只存在后端，扩展看不到。未配置 key 时选择 Google 会在开始时报 `translation_unavailable` 并提示。

## 播放同步（Phase 4）

- **暂停**：字幕保持最后一句不变（没有新语音就没有新字幕）。
- **跳转（快进/快退 > 2 s）**：字幕层立即清空；跳转前音频对应的识别/翻译结果若迟到，直接丢弃，不会闪回旧字幕。
- **回放**：本次会话内每个 final（含译文）按**视频时间**缓存；拖回已看过的区间时立刻显示缓存字幕，不必再等识别。缓存只在内存，停止会话或切视频即清空；直播页不启用。
- **时间映射**：后端音频时钟按 1× 实时推进（静音也在捕获），扩展记录「音频时钟零点」对应的墙钟时间，并用 `<video>` 的 play/pause/seek/rate 事件建立「墙钟 → 视频时间」时间线，把每段字幕映射到视频位置。误差约 0.1–0.5 s。
- **播放器替换**：`<video>` 元素被替换（迷你播放器、广告、切频道）时自动重新挂载事件。
- **直播**：Twitch 频道页 / YouTube 直播（`ytp-live` 或 `duration === Infinity`）视为直播：不启用回放缓存。

## 稳定性与诊断（Phase 5）

- **会话时长上限**：默认 3 小时（「字幕样式」→「会话上限」可改为 1/2/3/6 小时或不限制），到时自动停止并在 popup 提示。上限由 Offscreen Document 计时，不受 Service Worker 休眠影响。
- **心跳**：扩展每 15 s 发 `session.ping`，30 s 收不到任何消息即判定断线并走重连；后端对 30 s 无音频也无 ping 的连接主动关闭（`IDLE_TIMEOUT_MS`）。
- **速率限制**：云端引擎按每分钟请求数限流（`GEMINI_RPM` 默认 12，`LLM_RPM` 默认不限）；收到 429 后冷却 15 s；后端对超过每秒 25 帧的音频丢弃多余帧。
- **诊断区（popup）**：后端是否运行与运行时长、各引擎状态（✓ 已加载 / ○ 已配置未加载 / ✗ 未配置）、会话时长与上限、字幕数、重连次数、识别/翻译延迟、最近一次原始错误；「复制诊断信息」把以上内容（不含密钥）复制为 JSON，便于排查。popup 为此新增了 `http://127.0.0.1:8787/*` 权限，只用于读取 `/healthz`。
- **错误提示**：常见错误已翻译成可操作的中文（后端未运行、引擎未配置、需要先打开 popup、页面需刷新等）；原始信息保留在诊断区。

## 字幕可读性（Phase 6）

「字幕样式」新增：**字号随播放器大小自动缩放**（以 1280 px 宽为基准，0.55–2.2 倍）、**控制条出现时自动上移**（YouTube 按 `ytp-autohide` 状态，Twitch 按控制层可见性）、**文字描边**、**字体**（系统 / 无衬线 / 衬线 / 圆体 / 等宽）、**每行最多 1–3 行**（超出截断）。partial 更新时若文字只是变短（模型回退）保留较长版本，当前字幕框保持固定高度，避免上下跳动。

## 质量指标（Phase 6）

- 后端每个会话结束时把**不含文本**的摘要追加到 `packages/server/logs/sessions.jsonl`（时长、音频秒数、句数、识别 p50/p95、翻译 p50/p95、覆盖率、失败数、错误码）；`LOGS_DIR=off` 关闭。`/healthz` 返回最近 10 个会话。
- popup 诊断区显示当前会话的识别/翻译 p95 与翻译覆盖率；本机翻译跟不上（覆盖率 < 60% 或平均 > 5 s）时提示改用 LM Studio / Gemini；自动检测到多种语言时提示在「来源」指定语言。
- `npm run bench -- --port 8787 --minutes 3 --engine hy-mt2`：用固定多语音频跑标准基准，输出延迟分位数、覆盖率与后端 CPU/RSS。

## 排查

| 现象 | 处理 |
|---|---|
| popup 显示「本地后端未运行」 | 终端 `npm run dev:server`，等到 `Server listening`；模型加载约 5–15 s |
| 开始后立刻报「翻译引擎不可用」 | 诊断区看该引擎是 ✗（未配置）还是预热失败；按提示补 `.env` 或换模型；`.env` 改后需重启后端 |
| 字幕一直不出现 | 诊断区看「音频」秒数是否增长（否 → 捕获问题，刷新页面后重新打开 popup 再开始）、「识别延迟」是否正常 |
| 译文很慢 | 换引擎：LM Studio（局域网）最快，Gemini 约 1 s，本机 2–5 s；关闭「边说边翻译」 |
| 反复重连 | 后端日志是否崩溃/重启；诊断区「重连次数」 |
| 需要报告问题 | 「复制诊断信息」+ 后端终端最近日志 |

## 隐私与密钥

- 音频只在本机：tab → 扩展 → `127.0.0.1` 后端 → 本机模型；不录音、不落盘。字幕文本默认**不写日志**（调试可设 `LOG_TRANSCRIPTS=1`）。回放缓存只在内存。
- 数据离开本机的**唯一**情形：你选择了云端翻译引擎——`gemini` 把**原文句子**发送到 Google AI Studio；`google` 发送到 Google Cloud Translation；`llm` 发送到你配置的端点（如局域网 LM Studio 则不出内网）。
- 密钥只放 `packages/server/.env`（gitignore，建议 `chmod 600`，后端启动时权限过宽会警告）；扩展永不接触密钥；启动日志中密钥只显示前 4 位与后 3 位。**轮换**：在提供方控制台重新生成 → 改 `.env` → 重启后端。

## 已知限制（Phase 5）

- 译文比原文晚 2–4 s 出现（本机翻译）；机器繁忙时更久。
- Twitch 广告期间会识别广告里的语音（没有广告检测）。
- 回放缓存按会话保存，重开会话或刷新页面后失效（持久化留到 Phase 5）。
- 变速播放时映射按 `playbackRate` 推算，极端倍速下缓存对齐误差变大。
- 后端一次只面向一个用户设计，无鉴权，请勿改为对外监听。
- 识别切错的句子（如软切分切在词中）翻译也会跟着错。
- 背景音乐 / 多人同时说话会明显降低识别质量，这是 ASR 模型本身的限制。
- Auto Detect 按整句判断语种；一句话内中英夹杂时 SenseVoice 表现尚可，日英夹杂未系统评估。
- 首次启动后端需加载模型（约 3–7 s）。
- 密集语音的「软切分」按能量最低点切，偶尔会切在词中间，边界处一两个词可能识别偏差（Phase 4 结合翻译粒度再优化）。
- 只捕获**当前活动 tab**，同一时间只能有一个 session。
- 捕获期间视频声音由扩展的 Offscreen Document 回放。Chrome 标签页级「静音此网站」可能不会静音这路回放，Stop 后恢复正常。
- 捕获期间 popup 必须先被点开（这是 Chrome `tabCapture` 的「扩展需先被用户调用」限制）。
- YouTube 站内切换视频 / 全屏 / 剧场模式时字幕层会自动重挂（事件 + 每秒一次的健康检查）；音频捕获跟随 tab，不受影响。
- Twitch 只做页面/播放器检测，音频捕获兼容性留到 Phase 4。
- 页面在扩展安装/重载之前就已打开时，content script 不存在，popup 会提示 `reload page`。
- 后端只绑定 127.0.0.1、无鉴权；不要改为对外监听。

## 安全 / 隐私

- 音频只在本机 Offscreen Document 内用于回放与电平计算，**不发送、不录制、不落盘**。
- 扩展代码中不含任何 API key（Phase 0 也不需要）。
