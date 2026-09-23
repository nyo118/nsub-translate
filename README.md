# Live Subtitle Translator

个人用 Chrome 扩展：在 YouTube / Twitch 视频内叠加**双语实时字幕**。

当前状态：**Phase 1 — 字幕 UI 与扩展设置**（Phase 0 技术验证已验收）。popup 提供语言选择与字幕样式设置并持久化；字幕层可随 YouTube / Twitch 站内导航自动重绑定。**仍未**接入真实语音识别（ASR）或翻译，字幕内容是本地后端发出的固定脚本。

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

```bash
nvm use            # 读取 .nvmrc → Node 22
npm install
npx playwright install chromium   # 仅当要跑 e2e 时需要（约 100 MB）
```

## 常用命令（在仓库根目录执行）

| 命令 | 作用 |
|---|---|
| `npm run lint` | ESLint（全仓） |
| `npm run typecheck` | 先构建 protocol，再对三个包和 e2e 做 `tsc --noEmit` |
| `npm test` | Vitest 单元 + 后端 WebSocket 集成测试 |
| `npm run build` | 依次构建 protocol → server → extension（产物在各包 `dist/`） |
| `npm run dev:server` | 启动本地后端（`tsx watch`，改代码自动重启），监听 `ws://127.0.0.1:8787/ws` |
| `npm run start:server` | 用 `packages/server/dist` 启动后端（需先 build） |
| `npm run test:e2e` | 先 build，再用 Playwright 加载扩展跑 smoke 测试（自动启动后端） |

后端环境变量：`PORT`（默认 8787）、`HOST`（默认 127.0.0.1，**请勿改成 0.0.0.0**）、`MOCK_TICK_MS`（模拟字幕间隔，默认 1500）。

## 启动本地后端

> **每个新终端都要先 `nvm use`**。所有 root 脚本会先检查 Node 版本，版本不对会直接报错退出（而不是运行到一半崩溃）。

```bash
nvm use
npm run dev:server
# 期望日志：Server listening at http://127.0.0.1:8787
#          WebSocket endpoint: ws://127.0.0.1:8787/ws
curl http://127.0.0.1:8787/healthz   # → {"ok":true,"openConnections":0}
```

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
4. 预期：视频声音**继续**可听；按钮变为 `● 正在翻译`、下方细条随声音跳动；视频画面下方出现英文 + 中文的模拟字幕，约每 1.5 秒更新。
5. 点 **停止**：字幕层消失、状态回到 `● Ready`、后端日志出现 `session stopped`。
6. 再开始 / 停止一次，确认没有重复字幕层、重复 session。

## 设置（Phase 1）

- **来源 / 翻译成**：来源含 `Auto Detect`；语言改动**在下次开始时生效**，会话进行中修改不会影响当前会话（popup 会提示）。
- **字幕样式**（点「字幕样式 ›」展开）：字体大小、字幕位置（距播放器底部的百分比）、背景透明度、显示原文、显示翻译、恢复默认。样式改动**立即生效**，包括会话进行中。
- 所有设置存放在 `chrome.storage.local`，重启 Chrome 后保留；损坏或旧版本的数据会被自动修正为合法值。

## 已知限制（Phase 0）

- 字幕是固定脚本，与视频内容无关；所选语言只会传给后端记录，不影响模拟字幕内容（Phase 2/3 接入真实 provider）。
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
