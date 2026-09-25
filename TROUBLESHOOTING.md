# 排查指南

先看 popup「诊断」区（后端状态、引擎 ✓/○/✗、延迟、错误原文），「复制诊断信息」可得到完整 JSON。

## 启动 / 后端

| 现象 | 原因 | 处理 |
|---|---|---|
| popup 红字「本地后端未运行」 | 后端没起 / 还在加载模型 | `npm run start:server`（或 `npm run service:status`）；等 `Server listening`；模型加载 5–15 s |
| 终端 `Node 18.20.8 is not supported` | 终端里不是 Node 22 | `nvm use`；若 `command not found: nvm`：`source ~/.nvm/nvm.sh` 或 `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"` |
| `listen EADDRINUSE 127.0.0.1:8787` | 最常见：后端已作为 launchd 服务在跑（`npm run service:status` 可见），又手动执行了 `dev:server` / `start:server` | 不必手动启动；改 `.env` 用 `npm run service:restart`，改源码用 `npm run build && npm run service:restart`；要用热重载先 `npm run service:uninstall`。其他情况用 `lsof -nP -iTCP:8787 -sTCP:LISTEN` 找到占用进程 |
| popup「后端准备中：…下载中 xx%」 | 后端正在自动下载模型 | 等待完成即可（识别模型约 160 MB，翻译模型 1.1 GB，只在首次选用本机翻译时下载） |
| popup「…准备失败」/ 后端 `model download failed` | 网络不通或校验失败 | 检查网络后重启后端，或手动 `npm run models:download`；`AUTO_DOWNLOAD_MODELS=0` 时需手动下载 |
| `checksum mismatch` | 下载不完整或文件被改 | 删除该文件后重新 `npm run models:download` |
| `Failed to load model`（GGUF） | 用了需要特殊内核的量化（官方 2-bit/1.25-bit）或损坏文件 | 使用 `models.lock.json` 指定的官方 Q4_K_M |

## 原生模块（`Could not find sherpa-onnx-node` / `ASR worker died`）

`sherpa-onnx-node` 把所有加载错误都吞成一句「Could not find sherpa-onnx-node… 请设置 DYLD_LIBRARY_PATH」，真实原因通常是下面之一。先跑 **`npm run doctor`**，它会指出具体是哪一种并给出命令。

| 原因 | 判断 | 处理 |
|---|---|---|
| 没有在仓库根目录安装依赖 / 用 Node 18 安装 / 用了 `--omit=optional` | `ls node_modules | grep sherpa-onnx-` 没有你平台的包（如 `sherpa-onnx-darwin-arm64`） | 仓库根目录 `nvm use && npm ci` |
| Apple Silicon 上原生库未签名（macOS 拒绝加载未签名 arm64 库） | Intel 机器正常、M 系列机器报错 | `codesign --force --sign - node_modules/sherpa-onnx-darwin-arm64/*.dylib node_modules/sherpa-onnx-darwin-arm64/*.node` |
| 浏览器下载的文件带隔离属性 | `xattr -l node_modules/sherpa-onnx-darwin-*/sherpa-onnx.node` 有 `com.apple.quarantine` | `xattr -dr com.apple.quarantine node_modules/sherpa-onnx-darwin-*` |
| Node 架构与机器不一致（Rosetta 下的 x64 Node） | `node -p process.arch` 与 `uname -m` 不一致 | 装与机器一致的 Node（nvm 会按当前架构安装） |
| Linux 找不到共享库 | 报错含 `LD_LIBRARY_PATH` | `export LD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-linux-x64:$LD_LIBRARY_PATH` |
| 不支持的平台（如 Windows arm64、Linux armv7） | doctor 提示 no prebuilt | 无预编译包，暂不支持 |

注：`npm test` 中真实模型的集成测试只在模型已下载时运行；干净 clone 未下载模型时它会被跳过，不会报这个错。

## 翻译引擎

| 现象 | 原因 | 处理 |
|---|---|---|
| 开始时报 `translation_unavailable … GEMINI_API_KEY` | `.env` 没配 key | 在 `packages/server/.env` 写入后**重启后端**（`.env` 只在启动时读取） |
| `failed its warm-up: … HTTP 404` | 模型名不存在 / 新账号不可用 | 换 `GEMINI_MODEL=gemini-3.5-flash-lite`；用 `curl …/v1beta/models?key=` 查看可用模型 |
| 后端警告 `too slow for live subtitles` | 选了思考型 / 大模型（如 `gemma-4-31b-it`，20 s 一句） | 改用 flash-lite 类模型 |
| 译文从不出现，诊断区翻译 p95 很大 | 本机 CPU 被识别 + 翻译占满 | 改用 LM Studio（局域网）或 Gemini；关闭「边说边翻译」 |
| `HTTP 401` 来自 LM Studio | 需要 API token | `.env` 中 `LLM_API_KEY=<LM Studio token>`；`LLM_BASE_URL` 可只写 `http://host:1234`（自动补 `/v1`） |
| `HTTP 429` | 云端速率限制 | 已自动重试并冷却 15 s；可调 `GEMINI_RPM` |

## 字幕 / 页面

| 现象 | 原因 | 处理 |
|---|---|---|
| 「开始字幕」灰色 | 不是 YouTube/Twitch 影片页、页面未刷新、后端未运行 | 看按钮下方提示卡；刷新页面后**重新打开 popup** |
| `Extension has not been invoked for the current page` | 刷新/导航后 activeTab 授权失效 | 在影片标签页点扩展图标打开 popup 再按开始 |
| 字幕一直不出现，但音频秒数在增长 | 识别正常但视频是纯音乐 / 无人声，或语种不在 zh/en/ja/ko/yue | 换有人声的片段；来源指定语言 |
| 字幕很长一段才更新 | 密集语音 | 已软切分（5 s）；属正常，可调小字号 |
| 字幕挡住控制条 / 位置不对 | 关闭了「控制条出现时自动上移」或位置设置过低 | 打开该选项；调「字幕位置」 |
| 快进后旧字幕闪回 | 过期丢弃依赖音频时钟零点，重连后需重新对齐 | 停止再开始一次 |
| 扩展重载后旧页面报错 | 旧 content script 被作废 | 刷新页面 |
| popup 显示「翻译 …」 | Service Worker 仍是旧代码 | `chrome://extensions` 点扩展刷新 |

## 版本 / 回滚

见 `ROLLBACK.md`。报告问题时请附：`复制诊断信息` 的 JSON、后端终端最近 30 行、Chrome 版本、`git rev-parse --short HEAD`。
