# Live Subtitle Translator

个人用 Chrome 扩展：在 YouTube / Twitch 视频内叠加**双语实时字幕**。

当前状态：**Phase 0 — 技术验证**。只验证「浏览器 / 音频 / 网络」地基：tab 音频捕获、音频回放、Offscreen Document、本地 WebSocket、模拟字幕叠加层。**没有**接入真实语音识别（ASR）或翻译，字幕内容是本地后端发出的固定脚本（en → zh-CN）。

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
| Node.js | **22.12+**（Vite 8 / Vitest 5 的要求）。仓库根有 `.nvmrc`，用 `nvm use` 切换 |
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
4. 工具栏出现绿色方块图标「Live Subtitle Translator (Phase 0)」。建议点拼图图标把它固定到工具栏。
5. 之后每次重新 `npm run build`，需要在 `chrome://extensions` 点该扩展的 **刷新** 按钮，并**刷新已打开的 YouTube 页面**（旧页面里的 content script 会失效）。

## 如何人工测试 Phase 0

完整步骤与验收清单见 [TEST_PLAN.md](./TEST_PLAN.md)。简版：

1. `npm run dev:server` 保持运行。
2. 打开一个普通 YouTube 视频并开始播放。
3. 点扩展图标 → popup 显示 `Current tab: youtube · player found` → 点 **Start Translation**。
4. 预期：视频声音**继续**可听；popup 的 `Tab audio level` 随声音跳动；视频画面下方出现英文 + 中文的模拟字幕，约每 1.5 秒更新。
5. 点 **Stop**：字幕层消失、popup 回到 `idle`、后端日志出现 `session stopped`。
6. 再 Start / Stop 一次，确认没有重复字幕层、重复 session。

## 已知限制（Phase 0）

- 字幕是固定脚本，与视频内容无关；语言固定 en → zh-CN；样式不可调（Phase 1）。
- 只捕获**当前活动 tab**，同一时间只能有一个 session。
- 捕获期间视频声音由扩展的 Offscreen Document 回放。Chrome 标签页级「静音此网站」可能不会静音这路回放，Stop 后恢复正常。
- 捕获期间 popup 必须先被点开（这是 Chrome `tabCapture` 的「扩展需先被用户调用」限制）。
- YouTube 站内切换视频（SPA 导航）时只保证不报错并尽量重挂字幕层；完整重绑定在 Phase 1。
- Twitch 只做页面/播放器检测，音频捕获兼容性留到 Phase 4。
- 扩展图标是占位纯色方块。
- 页面在扩展安装/重载之前就已打开时，content script 不存在，popup 会提示 `reload page`。
- 后端只绑定 127.0.0.1、无鉴权；不要改为对外监听。

## 安全 / 隐私

- 音频只在本机 Offscreen Document 内用于回放与电平计算，**不发送、不录制、不落盘**。
- 扩展代码中不含任何 API key（Phase 0 也不需要）。
