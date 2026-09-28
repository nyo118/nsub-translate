# 配置参考

## 后端环境变量（`packages/server/.env`，模板 `.env.example`；改动需重启后端）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 默认只监听本机。**远程后端**（把后端放到局域网另一台更快的机器）时在那台机器设 `HOST=0.0.0.0`（后端会警告：无鉴权，仅限可信局域网），并在 popup「诊断 → 后端地址」填 `192.168.x.x:8787` |
| `ASR_PROVIDER` | `sensevoice` | `sensevoice` \| `mock` |
| `ASR_THREADS` | `2` | 识别线程数 |
| `TRANSLATION_PROVIDER` | `hy-mt2` | 默认翻译引擎（popup 可按会话覆盖）：`hy-mt2` \| `gemini` \| `llm` \| `google` \| `mock` \| `none` |
| `TRANSLATION_THREADS` | `3` | 本机翻译线程数 |
| `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_RPM` | — / `gemini-3.5-flash-lite` / `12` | AI Studio |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_RPM` | — / — / — / `0`(不限) | 任意 OpenAI 兼容端点；裸主机自动补 `/v1` |
| `GOOGLE_TRANSLATE_API_KEY` | — | Google Cloud Translation |
| `ASR_DENOISER` | `dpdfnet2` | 会话开了「降噪」但未指定强度时用的模型：`gtcrn`（轻，RTF≈0.09）\| `dpdfnet2`（中，≈0.21）\| `dpdfnet4`（≈0.33）\| `dpdfnet8`（强，≈0.57，Intel 2018 单线程实测） |
| `ASR_DENOISE_ATTENUATION_DB` | `0` | DPDFNet 最大衰减（dB），0 = 不限；人声被压闷时可设 20–30 |
| `SPEAKER_EMBEDDING_MODEL` | lock 中的 CAM++ zh/en | 声纹模型文件名（相对 `MODELS_DIR`），对比其他模型时用 |
| `SPEAKER_THRESHOLDS` | `0.20,0.35,0.23` | `SpeakerRegistry` 的 match / create / weak 余弦阈值（`scripts/speaker-calib.mjs` 给出建议值）；换声纹模型时需重新校准 |
| `MODELS_DIR` | `packages/server/models` | 模型目录。`models.lock.json` 分四组：`asr`（启动时必需）、`translation`（本机 Hy-MT2）、`enhance`（降噪）、`diarization`（说话人分离），后三组在首次使用时按需下载；`npm run models:download -- --group <组>` 可预下载 |
| `AUTO_DOWNLOAD_MODELS` | `1` | 缺失模型自动下载（按 `models.lock.json` 的 URL 与 SHA-256）；`0` 关闭 |
| `LOGS_DIR` | `packages/server/logs` | 会话摘要与服务日志；`off` 关闭摘要文件 |
| `LOG_TRANSCRIPTS` | `0` | `1` 时把 final 文本写入日志（调试用） |
| `METRICS_INTERVAL_MS` | `5000` | `session.metrics` 间隔 |
| `IDLE_TIMEOUT_MS` | `30000` | 无音频/心跳的连接多久关闭 |
| `MOCK_TICK_MS` | `1500` | mock 引擎节奏 |

## 扩展设置（popup，存于 `chrome.storage.local`）

| 设置 | 默认 | 生效时机 |
|---|---|---|
| 来源 / 翻译成 | 自动检测 / 简体中文 | 下次开始 |
| 翻译引擎 | 本机 Hy-MT2 | 下次开始 |
| 边说边翻译 | 关 | 下次开始（翻译过慢时自动只翻整句） |
| 降噪 | 关 | 下次开始；首次开启时后端下载降噪模型组（GTCRN 0.5 MB + DPDFNet2/4/8 约 36 MB） |
| 降噪强度 | 后端默认 | 只在「降噪」开启时显示：轻（GTCRN）/ 中（DPDFNet2）/ 强（DPDFNet8）；「后端默认」= 那台后端的 `ASR_DENOISER` |
| 区分说话人 | 关 | 下次开始；首次开启时后端下载 pyannote + 3D-Speaker CAM++ zh/en 模型（约 30 MB）。本机后端时 popup 提示 CPU 负担 |
| 多人同时说话时 | 标记 | 下次开始；`标记` / `跳过` / `照常识别`，只在「区分说话人」开启时有效 |
| 会话上限 | 3 小时 | 下次开始 |
| 后端地址（诊断区） | `ws://127.0.0.1:8787/ws` | 点「应用」后立即用于状态检查；会话在下次开始时切换。非本机地址会向 Chrome 申请该地址的访问权限（`optional_host_permissions`） |
| 字幕样式（字号、位置、透明度、原文/翻译显示、自动缩放、控制条上移、描边、字体、行数） | 22px / 10% / 72% / 开 / 开 / 开 / 开 / 关 / 系统 / 2 行 | 立即 |

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run setup` | 新机器一键：依赖 → 模型（校验）→ `.env` → 构建 |
| `npm run setup -- --lm-studio` | 同上，但跳过 node-llama-cpp 二进制（`NODE_LLAMA_CPP_SKIP_DOWNLOAD=true`）、只下识别模型、`.env` 预填 `TRANSLATION_PROVIDER=llm` — 给只用 LM Studio / 云端引擎的机器 |
| `npm run setup:local-translation` | 事后补装本机翻译：安装 node-llama-cpp + 下载 Hy-MT2 GGUF + 构建 |
| `npm run start:server` / `dev:server` | 从 dist 启动 / 开发热重载 |
| `npm run service:install|status|restart|uninstall` | macOS 登录自启（launchd） |
| `npm run models:download` / `models:verify` | 下载并校验 / 只校验 |
| `npm run release [-- --tag]` | 检查 → 干净构建 → zip + SHA256 → 可选打 tag |
| `npm run version:set -- 0.1.1` | 同步版本号到各包与 manifest |
| `npm run bench -- --engine gemini` | 标准性能基准 |
