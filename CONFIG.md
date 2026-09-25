# 配置参考

## 后端环境变量（`packages/server/.env`，模板 `.env.example`；改动需重启后端）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 只监听本机；**不要**改为 `0.0.0.0` |
| `ASR_PROVIDER` | `sensevoice` | `sensevoice` \| `mock` |
| `ASR_THREADS` | `2` | 识别线程数 |
| `TRANSLATION_PROVIDER` | `hy-mt2` | 默认翻译引擎（popup 可按会话覆盖）：`hy-mt2` \| `gemini` \| `llm` \| `google` \| `mock` \| `none` |
| `TRANSLATION_THREADS` | `3` | 本机翻译线程数 |
| `GEMINI_API_KEY` / `GEMINI_MODEL` / `GEMINI_RPM` | — / `gemini-3.5-flash-lite` / `12` | AI Studio |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` / `LLM_RPM` | — / — / — / `0`(不限) | 任意 OpenAI 兼容端点；裸主机自动补 `/v1` |
| `GOOGLE_TRANSLATE_API_KEY` | — | Google Cloud Translation |
| `MODELS_DIR` | `packages/server/models` | 模型目录 |
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
| 会话上限 | 3 小时 | 下次开始 |
| 字幕样式（字号、位置、透明度、原文/翻译显示、自动缩放、控制条上移、描边、字体、行数） | 22px / 10% / 72% / 开 / 开 / 开 / 开 / 关 / 系统 / 2 行 | 立即 |

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run setup` | 新机器一键：依赖 → 模型（校验）→ `.env` → 构建 |
| `npm run start:server` / `dev:server` | 从 dist 启动 / 开发热重载 |
| `npm run service:install|status|restart|uninstall` | macOS 登录自启（launchd） |
| `npm run models:download` / `models:verify` | 下载并校验 / 只校验 |
| `npm run release [-- --tag]` | 检查 → 干净构建 → zip + SHA256 → 可选打 tag |
| `npm run version:set -- 0.1.1` | 同步版本号到各包与 manifest |
| `npm run bench -- --engine gemini` | 标准性能基准 |
