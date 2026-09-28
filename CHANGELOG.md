# Changelog

## 0.3.0 — 2026-09-28

### 修复 / 改进（多声源）
- **说话人标签不再乱跳**（A → B → A+C 后 A 仍是 A）。根因：旧声纹模型（3D-Speaker ERes2Net zh-cn）在跨句同人上的余弦中位数只有 0.29，而阈值定在 0.45，任何短碎片都能「新建一个人」。现在：
  - 声纹模型换成 **3D-Speaker CAM++ zh/en**（在 8 位中文 + 8 位英语说话人的公开样本上 EER 最低、速度最快，见 `BENCHMARKS.md`「声纹校准」），阈值由校准给出；
  - `SpeakerRegistry` 重写：每人保留 centroid + 8 个 exemplar 取最大相似度；**只有 ≥ 2 s 且与所有已知人都不像的片段才能新建说话人**，新建者先是临时身份、累计 3 s 才转正、60 s 未转正则回收；短碎片只能归入已知人，否则不标字母，永不建人；同一段里多个说话人一对一分配，不会同字母；
  - worker 把同一本地说话人在一段里的全部音频拼起来算一次声纹（更长更准），不再只取第一片。
- **降噪加强**：新增 DPDFNet（DeepFilterNet 系，sherpa-onnx 内置流式实现）`dpdfnet2 / 4 / 8`，默认 `dpdfnet2`；popup「降噪」下新增「强度」：轻（GTCRN）/ 中 / 强。`ASR_DENOISER`、`ASR_DENOISE_ATTENUATION_DB` 可配。
- 新脚本 `scripts/speaker-calib.mjs`：下载公开样本、对比声纹模型、输出 EER 与建议阈值、模拟多人对话评估标签稳定性；`bench.mjs` 新增 `--clip conv`（8 人对话含重叠）与 `--denoiser`。

### 变更
- 协议 v7：`session.start.options.denoiser`、`session.ready.asr.denoiser / speakerModel`。扩展与后端需同为 0.3.x。
- `models.lock.json`：`enhance` 组加入 dpdfnet2/4/8，`diarization` 组换成 CAM++ zh/en（旧 3D-Speaker ERes2Net 文件不再需要，可删除）。

## 0.2.2 — 2026-09-28

### 修复
- 0.2.1 的 `isLlamaInstalled()` 用 `node-llama-cpp/package.json` 探测，该包的 exports 不暴露它，导致**装了**本机翻译的机器也被报成「本机翻译未安装」（只影响 popup 提示与 doctor，会话不受影响）。改为解析裸包名，并加了「本仓库应检测为已安装」的单测。

## 0.2.1 — 2026-09-28

### 变更
- **node-llama-cpp 成为可选依赖**：只用 LM Studio / Gemini 等引擎的机器不再需要安装、下载或编译它。源码不再导入它的类型，缺失时后端照常构建、启动；`hy-mt2` 引擎在 popup 显示「后端未配置此引擎：本机翻译未安装…」，选它开始会话得到 `translation_unavailable` 而不是崩溃。
- `npm run setup -- --lm-studio`：跳过 node-llama-cpp 二进制（`NODE_LLAMA_CPP_SKIP_DOWNLOAD=true`）、只下载识别模型、`.env` 预填 `TRANSLATION_PROVIDER=llm` 与 LM Studio 三项。`npm run setup:local-translation` 用于事后补装本机翻译。
- `hy-mt2.prepare()` 先加载引擎再下载模型：没装引擎的机器不会白下 1.1 GB。
- `npm run doctor` 对 node-llama-cpp 显示三态（已装 / 未装但默认引擎不需要 / 未装且 `TRANSLATION_PROVIDER=hy-mt2`）。
- popup：所选引擎在后端不可用而该后端已配置「自定义 LLM」时，提示可直接改选。

## 0.2.0 — 2026-09-28

### 新增（多声源，全部默认关闭，popup 开启）
- **降噪**：GTCRN 流式语音增强前置于识别，针对游戏音效 / 背景音乐盖住人声的场景（模型 0.5 MB，首次开启时自动下载）。
- **区分说话人**：每句收尾时用 pyannote segmentation 3.0 按说话人切段，3D-Speaker 声纹映射为会话内稳定的 A / B / C… 标签（最多 6 人），字幕前显示彩色字母；每句多约 0.3–0.5 s（模型约 46 MB，首次开启时下载）。
- **多人同时说话**：标记「[多人同时说话]」（默认）/ 跳过 / 照常识别；占位段不翻译。
- 基准脚本新增 `--clip clean|bgm|duet|mixed`、`--denoise`、`--diarize`、`--overlap`、`--show-text`。

### 变更
- 协议 v6：`session.start.options.denoise / diarize / overlap`，`session.ready.asr.denoise / diarize`，`transcript.speaker / overlap`。扩展与后端需同为 0.2.x。
- `models.lock.json` 新增 `enhance`、`diarization` 两组；`/healthz.models` 与 popup 进度按组显示。
- 会话摘要日志新增 `denoise / diarize` 字段。

### 已知限制
- 重叠人声不做语音分离（sherpa-onnx 无绑定），只能标记 / 跳过。
- 本机 Intel 4 核同时开本机翻译与区分说话人会明显吃紧，建议远程后端。

## 0.1.1 — 2026-09-25

### 新增
- **模型自动下载**：后端启动时自动下载缺失的语音识别模型（约 160 MB，校验 SHA-256），期间 popup 显示下载进度、开始按钮禁用，就绪后无需重启；本机翻译模型（1.1 GB）只在第一次选用「本机 Hy-MT2」时下载。`AUTO_DOWNLOAD_MODELS=0` 可关闭。
- `models.lock.json` 成为模型的唯一来源（URL、压缩包、SHA-256、分组）；`npm run models:download` / `models:verify` 改为读取它。
- `/healthz` 新增 `ready` 与 `models` 字段；模型未就绪时 `session.start` 返回带进度的 `asr_unavailable`。

### 变更
- 后端现在**先监听端口再加载模型**，popup 不再把「模型加载中」误报为「后端未运行」。

## 0.1.0 — 2026-09-25（个人使用 Beta）

首个可日常使用的版本。Chrome MV3 扩展 + 本地后端，在 YouTube / Twitch 视频内叠加实时双语字幕。

### 功能
- **语音识别**：本机 SenseVoice-Small（sherpa-onnx，worker 线程），中 / 英 / 日 / 韩 / 粤语自动检测；VAD 分句 + 密集语音软切分；partial 实时修正、final 收句；背压保护。
- **翻译引擎**（popup 可选，按会话生效）：本机 Hy-MT2-1.8B（Q4_K_M GGUF）、Gemini（AI Studio 免费层）、自定义 OpenAI 兼容端点（LM Studio / Groq / Ollama…）、Google Cloud Translation；预热验证、速率限制、429 冷却、失败降级为只显示原文。
- **字幕层**：Shadow DOM 叠加在播放器内，随全屏 / 剧场 / 迷你播放器 / 站内导航重挂；字号 / 位置 / 背景透明度 / 显示原文 / 显示翻译 / 自动缩放 / 控制条上移 / 描边 / 字体 / 行数，改动即时生效。
- **播放同步**：暂停保留、快进快退清屏并丢弃迟到字幕、会话内回放缓存、直播判定。
- **稳定性**：心跳与自动重连、会话时长上限（默认 3 小时）、后端空闲超时、帧速率保护、Offscreen 生命周期与资源释放。
- **诊断**：popup 显示后端状态、引擎可用性、延迟 p95、翻译覆盖率、重连次数；一键复制诊断信息；文本无关的会话摘要日志。
- **隐私**：音频与字幕默认不离开本机；只有选择云端翻译引擎时原文句子才发送到对应服务；密钥仅在后端 `.env`。

### 已知限制
- 本机翻译在 4 核 CPU 上覆盖率约 50%（密集语音），建议 LM Studio 或 Gemini（见 `BENCHMARKS.md`）。
- 广告语音会被识别；画中画窗口无法叠加字幕；Shorts / 部分 Twitch 模式待验证（见 `COMPATIBILITY.md`）。
- 仅在 Chrome 153 + macOS Intel 完整验证。

### 阶段
Phase 0 技术验证 → 1 设置 UI → 2 流式识别 → 3 翻译 → 4 播放同步与 Twitch → 5 稳定性与隐私 → 6 Beta 收敛 → 7 发布。
