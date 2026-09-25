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
