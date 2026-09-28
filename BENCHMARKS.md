# 性能基准（Phase 6）

测量方法：`npm run bench -- --port <port> --minutes 3 --engine <engine>`。固定音频 = SenseVoice 自带的 en / ja / zh / ko 测试片段拼接、句间 0.6 s 停顿、循环 3 分钟，以实时速率经 WebSocket 送入 **dist 后端**（`node packages/server/dist/index.js`）。基准运行时机器空闲（Chrome 有若干标签页，无其他重负载）。

环境：MacBook Pro（Intel i7-8559U，4 核 8 线程）· macOS 15 · Node 22.16 · Chrome 153 · SenseVoice int8（2 线程）· Hy-MT2-1.8B Q4_K_M（3 线程）。

## 结果（2026-09-25）

| 引擎 | 翻译覆盖率 | 识别延迟 avg / p95 | 识别解码 avg | 翻译耗时 avg / p95 | final → 译文 p50 / p95 | 后端 CPU 均值 | 后端 RSS |
|---|---|---|---|---|---|---|---|
| 本机 Hy-MT2（Q4_K_M） | **53%** | 585 / 1024 ms | 511 ms | 7032 / 8325 ms | 8.7 / 10.8 s | 216% | 2.35 → 2.37 GB |
| LM Studio（局域网，Hy-MT2） | **98%** | 168 / 294 ms | 156 ms | 561 / 850 ms | 0.6 / 0.85 s | 63% | 2.38 → 2.39 GB |
| Gemini 3.5 Flash-Lite（AI Studio） | **94%** | 243 / 345 ms | 206 ms | 1048 / 1315 ms | 1.1 / 2.4 s | 57% | 2.40 → 2.39 GB |

每次 3 分钟内均为 49 句 final、0 错误。

## 声纹校准与对话模拟（0.3.0，2026-09-28）

方法：`node scripts/speaker-calib.mjs --sim`。公开样本 16 位说话人 / 67 段：sherpa `sr-data`（fangjun / leijun / liudehua，中文，各 4–5 段）、LibriSpeech dev-clean 前 8 位英语说话人各 6 段、SenseVoice `test_wavs`（en / ja / ko / zh / yue 各 1 段）。每段再派生 1 s / 2 s / 4 s 切片、叠 −12 dB 合成 BGM、±10 % 变速 → 每个模型 1691 个声纹、111 110 对**跨文件**同人对比、约 1.3 M 对异人对比。EER 取 FRR = FAR 处；「建议阈值」= EER 点（match）、异人 p99（create）、异人 p95（weak）。对话模拟：30 场 × 40 轮、每场 4–6 人，把真实声纹按剧本喂给 `SpeakerRegistry`（dist 版本），统计标签纯度（一个字母里主说话人占比）、每人平均字母数（碎片率）、A→B→A 后 A 是否保持。

| 声纹模型 | 大小 | ms / 音频秒 | 同人余弦 p5 / p50 | 异人 p50 / p95 / p99 | EER（全部） | EER 1 s / 2 s / 4 s 切片 | 纯度 | 字母/人 | A→B→A 保持 |
|---|---|---|---|---|---|---|---|---|---|
| **3D-Speaker CAM++ zh/en advanced（选用）** | 28 MB | **17** | 0.18 / 0.44 | 0.04 / 0.23 / 0.35 | **7.1 %** @0.195 | 3.7 / 9.2 / 0.0 % | 0.998 | 1.01 | 100 % |
| NeMo TitaNet-large（英语） | 101 MB | 42 | 0.18 / 0.45 | 0.02 / 0.20 / 0.33 | 5.9 % @0.18 | 3.5 / 8.1 / 0.0 % | 0.987 | 1.02 | 98.9 % |
| 3D-Speaker ERes2Net zh-cn（0.2.0 用的） | 40 MB | 38 | **0.06 / 0.29** | 0.07 / 0.24 / 0.33 | 18.7 % @0.15 | 13.5 / 22.0 / 0.8 % | 0.977 | 1.04 | 95.2 % |
| WeSpeaker ResNet34-LM VoxCeleb | 26 MB | 44 | 0.31 / 0.59 | 0.47 / 0.71 / 0.86 | 34.1 % | — | （分数区间挤在一起，不可用） | | |

解读：
- 0.2.0 的问题被数据坐实：旧模型跨句同人余弦中位数 0.29、p5 只有 0.06，而旧阈值是 0.45 → 大多数「同一个人再次开口」都被判成新人，这就是 A 变 C、新人变 D。
- CAM++ zh/en 与 TitaNet 的 EER 接近（7.1 % vs 5.9 %），但 CAM++ 快 2.4 倍、小 3.6 倍，且对中文/英语都有训练 → 选用，阈值 match 0.20 / create 0.35 / weak 0.23。
- 2 s 切片的 EER（9.2 %）明显高于 4 s（0 %）：这就是「≥ 2 s 才能建人、短碎片只归入已知人」规则的依据；worker 现在把同一说话人在一段里的音频拼起来再算声纹，实际长度通常 ≥ 3 s。
- 对话模拟里 CAM++ 在新 registry 下纯度 99.8 %、每人 1.01 个字母、A→B→A 100 % 保持（模拟未含 BGM 混音的重叠段；真实重叠段的边缘碎片走「短碎片继承」规则）。

## 降噪模型对比与 8 人对话（0.3.0，2026-09-28）

同一台 Intel 机器、dist 后端、翻译关闭、每组 1 分钟（`npm run bench -- --clip bgm --denoiser <name>` / `--clip conv --diarize`）。

| 片段 | 降噪 | 1 分钟 final 数 | 识别延迟 avg / p95 | 后端 CPU | 文本 |
|---|---|---|---|---|---|
| bgm | 关 | 10 | 209 / 352 ms | 52% | 中韩两句串成一段，英文两句合并 |
| bgm | gtcrn（轻） | 19 | 162 / 356 ms | 63% | 分段恢复，但日语句被改写成「広販売とパンを買う」、出现「理解 / 不解」碎片 |
| bgm | **dpdfnet2（中，默认）** | 17 | 142 / **274** ms | 77% | 四语文本与干净基线一致（"50 pieces of gold" 正确，"driver chieftain" 小错） |
| bgm | dpdfnet4 | 17 | 157 / 326 ms | 53% | 同 dpdfnet2 |
| bgm | dpdfnet8（强） | 17 | 150 / 300 ms | 74% | 同 dpdfnet2，"gold" 三次全对 |
| clean | dpdfnet2 | 17 | 139 / 249 ms | 52% | 与无降噪基线一致（"code" 同基线） |

结论：DPDFNet 三档在合成 BGM 上文本质量明显优于 GTCRN（GTCRN 保住分段但改写了词），且延迟不升；默认改为 `dpdfnet2`（RTF 0.21），`dpdfnet8` 留给 CPU 富余的远程后端。

**8 人对话（`--clip conv --diarize`，3 位中文男声 + 5 位 LibriSpeech 英语，24 轮含 3 段叠加，1 分钟约播到第 14 轮）**：21 条 final、5 个字母、3 段「[多人同时说话]」、0 错误、p95 426 ms。逐句核对：fangjun 4/4 = A；leijun 长句 2/2 = B；ls1272 = C、ls1462 = D、ls1673 = E 各自独立；A→B→A 后 A 仍是 A（0.2.0 的核心问题已修）。残余错误：leijun 一句 1.5 s 短句被归到 A、liudehua 一句 4 s 长句被归到 B——三位中文男声彼此相似（模型 EER 7 %），两条短碎片与两条开头碎片按规则不标字母。真值对齐按轮次起点估算，与 VAD 分段边界不完全一致，表中数字是人工核对结果。

## 多声源基准（0.2.0，2026-09-28）

方法：`npm run bench -- --port 8790 --minutes 1 --engine none --clip <clip> [--denoise] [--diarize] [--overlap mark|recognize] --show-text`，同一台 Intel 机器、tsx 开发态后端、翻译关闭（只测识别）。四种合成片段都由 SenseVoice 自带测试音频拼成（见 `scripts/bench.mjs` 注释）：`clean` 四语轮播；`bgm` = clean 叠加 −12 dB 合成和弦 + 噪声；`duet` = en / zh / en / zh 两人轮流；`mixed` = en 与 zh 直接叠加（两人同时说话）。

| 片段 | 开关 | 1 分钟 final 数 | 识别延迟 avg / p95 | 后端 CPU | 结果 |
|---|---|---|---|---|---|
| clean | 关 | 17 | 178 / 334 ms | 70% | 基线：四句各自成段，文本正确 |
| clean | 降噪 | 17 | 276 / 535 ms | 84% | 分段不变；文字有轻微扰动（chieftain → chief then、広販売 → ご販売），延迟 +100 ms |
| bgm | 关 | **9** | 435 / **1538** ms | 115% | 音乐填满停顿，VAD 收不了句：日语两句合成一段并串成错句、中韩两句连在一起、延迟翻倍 |
| bgm | 降噪 | **17** | 194 / 614 ms | 71% | 分段与文本恢复到接近 clean（"50 pieces of code"、"派放时间" 等与基线相同的小错） |
| duet | 关 | 15 | 178 / 315 ms | 84% | 文本正确但无人物区分 |
| duet | 区分说话人 | 15 | 211 / 473 ms | 77% | 英语 10 句全部 **A**、中文 5 句全部 **B**，跨 4 轮循环标签零漂移；延迟 +30 ms avg / +160 ms p95 |
| mixed | 关 | 21 | 231 / 515 ms | 46% | 混杂文本："The tribal chief him called for the god and presented him the."、"第皮。" |
| mixed | 区分说话人 + 标记 | 39（18 段重叠） | 176 / 308 ms | 41% | 重叠区显示「[多人同时说话]」，只剩单人边缘碎片（"The tribal." / "And presented him."）；碎片上出现过一次 C 标签 |
| mixed | 区分说话人 + 照常识别 | 38（18 段重叠） | 282 / 573 ms | 92% | 重叠区被硬识别成 "第皮"、"T them part the God" 之类，正如预期不可用 |

结论：
- **降噪对有 BGM 的音频收益显著**（分段数 9 → 17，p95 延迟 1.5 s → 0.6 s，串句消失），对干净语音有可感知但轻微的扰动 → 保持默认关，游戏直播 / 有配乐时手动开。
- **区分说话人**在两人轮流场景标签完全稳定，成本约 +0.2 s p95；重叠场景能把混杂文本换成明确的占位提示。「照常识别」只用于确认模型确实无法拆开重叠人声。
- 每种模式 0 错误；RSS 因多加载三个模型上升约 200 MB（446 → 690 MB，无 Hy-MT2 时）。

## 解读

- **本机翻译与识别争抢 CPU**：Hy-MT2 在本机跑时，识别延迟从约 170 ms 升到 585 ms，翻译一句 7 s，「以新为先」策略只能翻译约一半的句子。这是这台 4 核 CPU 的物理上限，不是软件缺陷；换成局域网 LM Studio 或 Gemini 后，本机 CPU 降到 60% 左右，识别延迟回到 200 ms 内。
- **推荐配置**：日常观看用 LM Studio（局域网另一台机器跑 Hy-MT2）或 Gemini；本机 Hy-MT2 适合语速较慢、句子间有停顿的内容。
- **内存**：后端 RSS 稳定在 2.3–2.4 GB（SenseVoice 约 0.3 GB + Hy-MT2 Q4 约 1.1 GB 常驻 + 运行时），3 分钟内无增长；30 分钟 soak（Phase 5）同样平坦。
- **网络**：扩展 → 后端为本机 16 kHz PCM16，恒定 32 KB/s；云端引擎每句一次 HTTPS 请求（几 KB）。
- **扩展侧**：Chrome 任务管理器中 Offscreen Document 与 content script 的内存需由使用者在真实观看时记录（`TEST_PLAN.md` P5-7）。

## 复现

```bash
npm run build
PORT=8790 LOGS_DIR=off node packages/server/dist/index.js &
npm run bench -- --port 8790 --minutes 3 --engine hy-mt2
npm run bench -- --port 8790 --minutes 3 --engine llm      # 需 .env 中的 LLM_*
npm run bench -- --port 8790 --minutes 3 --engine gemini   # 需 .env 中的 GEMINI_API_KEY
```
