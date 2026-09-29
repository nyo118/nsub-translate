<img src="packages/extension/public/icons/icon48.png" width="40" align="left" alt="">

# N Sub — 即时双语字幕

[English](README.md) | 中文

一个 Chrome 扩展，在 YouTube 和 Twitch 视频上叠加双语实时字幕。标签页音频送到本机后端，由 SenseVoice 识别（中、英、日、韩、粤），再由本机 Hy-MT2 模型或你选的引擎（LM Studio、Gemini、Google）翻译。全部在自己的机器上运行，默认配置不需要账号或 API key。

可选功能：给带音乐、游戏音效的直播降噪；给多人对话加说话人标签（A / B / C）。

## 前置条件

| | |
|---|---|
| Node.js | 22.12 以上。仓库有 `.nvmrc`，执行 `nvm use`。 |
| Chrome | 116 以上。 |
| 系统 | 在 macOS 上开发和测试；Windows、Linux 未验证。 |
| 磁盘 | 识别模型约 200 MB，用本机翻译再加 1.1 GB。模型在首次使用时下载。 |

## 安装

```bash
git clone https://github.com/nyo118/nsub-translate.git
cd nsub-translate
nvm use
npm run setup        # npm ci、下载模型、生成 packages/server/.env、构建
```

然后加载扩展：打开 `chrome://extensions`，开启开发者模式，点 **加载已解压的扩展程序**，选 `packages/extension/dist`。每个 [GitHub Release](https://github.com/nyo118/nsub-translate/releases) 也附带打包好的 zip。

用 `npm run start:server` 启动后端（或 `npm run service:install` 设为登录自启）。打开一个视频，点扩展图标，按 **开始字幕**。

**后端放在另一台机器，或用 LM Studio 翻译：** 在那台机器上改用 `npm run setup -- --lm-studio`。它会跳过本机翻译引擎、只下载识别模型，并在 `.env` 里预填 `TRANSLATION_PROVIDER=llm`。填好 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，加上 `HOST=0.0.0.0`，然后在 popup 的「诊断 → 后端地址」填它的地址。后端没有鉴权，只在可信网络里这样做。

云端引擎的 key 写在 `packages/server/.env`，见 `CONFIG.md`。`.env` 不会被提交。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run setup` | 新 clone 一键安装（`-- --lm-studio` 用于不装本机翻译的机器） |
| `npm run start:server` / `npm run dev:server` | 从 `dist` 启动后端 / 改代码自动重启 |
| `npm run service:install` | 登录自启后端（macOS launchd）；另有 `service:status`、`service:restart`、`service:uninstall` |
| `npm run build` | 构建 protocol、server、extension |
| `npm run doctor` | 检查 Node、原生模块、模型和 `.env` |
| `npm test`、`npm run lint`、`npm run typecheck` | 单元测试、ESLint、TypeScript |
| `npm run test:e2e` | 用 Playwright 跑已构建的扩展 |
| `npm run bench` | 对运行中的后端做延迟基准 |
| `npm run models:download`、`npm run models:verify` | 按 `models.lock.json` 下载或校验模型 |
| `npm run release -- --tag` | 打包发布 zip 并打 tag |

## 设置

所有设置都在 popup 里：来源和目标语言、翻译引擎、降噪、区分说话人、字幕样式、后端地址。语言和引擎的改动在下次开始时生效，样式改动立即生效。

## 更多

- `CONFIG.md` – 环境变量与设置
- `TROUBLESHOOTING.md` – 常见错误与处理
- `ARCHITECTURE.md` – 各部分如何配合、协议版本
- `BENCHMARKS.md` – 延迟、翻译覆盖率、声纹校准
- `PRIVACY.md`、`COMPATIBILITY.md`、`CHANGELOG.md`、`ROLLBACK.md`

## 许可

个人项目。模型各自遵循原有许可（SenseVoice、Silero VAD、Hy-MT2、pyannote、3D-Speaker、GTCRN、DPDFNet）。
