# 隐私说明

本项目是个人使用工具，没有账号、没有遥测、没有任何数据上传到项目作者。

## 数据流向

| 数据 | 去向 | 说明 |
|---|---|---|
| 标签页音频 | 扩展 → `127.0.0.1:8787`（本机后端） | 16 kHz PCM，只在内存中流转；**不录制、不落盘** |
| 识别文本（原文） | 本机 | 由本机 SenseVoice 生成 |
| 原文句子 → 翻译 | 取决于「翻译引擎」 | `hy-mt2`：本机；`llm`：你配置的端点（如局域网 LM Studio，不出内网）；`gemini`：Google AI Studio；`google`：Google Cloud Translation。**云端引擎会收到每一句原文**，不发送音频 |
| 设置 | `chrome.storage.local` | 语言、引擎、样式、时长上限；不同步到 Google 账号 |
| 回放缓存 | 内存 | 会话结束或换视频即清空 |
| 会话摘要 | `packages/server/logs/sessions.jsonl` | 只有时长、句数、延迟分位数、覆盖率、错误码；**不含任何字幕文本**；`LOGS_DIR=off` 关闭 |
| 后端日志 | 终端 / `logs/backend.*.log`（安装为服务时） | 不含字幕文本（除非显式 `LOG_TRANSCRIPTS=1`）；密钥脱敏 |
| API 密钥 | `packages/server/.env` | 已 gitignore；建议 `chmod 600`；扩展永远接触不到 |

## 权限用途（扩展）

| 权限 | 用途 |
|---|---|
| `tabCapture` | 捕获当前标签页音频 |
| `offscreen` | 在隐形页面里做音频处理与 WebSocket |
| `storage` | 保存设置与会话状态 |
| `activeTab` | 只对你点击扩展的那个标签页生效 |
| `*://*.youtube.com/*`、`*://*.twitch.tv/*` | 注入字幕层 |
| `http://127.0.0.1:8787/*` | popup 读取本机后端 `/healthz` 显示状态 |

## 清除数据

- 设置：popup「恢复默认」，或在 `chrome://extensions` 移除扩展。
- 会话摘要日志：删除 `packages/server/logs/`。
- 模型文件：删除 `packages/server/models/`（约 1.3 GB）。
- 密钥：删除 `packages/server/.env` 并在提供方控制台吊销。
