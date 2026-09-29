<img src="packages/extension/public/icons/icon48.png" width="40" align="left" alt="">

# N Sub — Live Subtitle Translator

English | [中文](README.zh-CN.md)

A Chrome extension that shows bilingual live subtitles on YouTube and Twitch videos. Tab audio goes to a local backend, which recognises speech with SenseVoice (Chinese, English, Japanese, Korean, Cantonese) and translates it with a local Hy-MT2 model or an engine of your choice (LM Studio, Gemini, Google). Everything runs on your own machines; no account or API key is required for the default setup.

Optional: noise suppression for streams with music or game audio, and speaker labels (A / B / C) for conversations.

## Prerequisites

| | |
|---|---|
| Node.js | 22.12 or newer. The repo has an `.nvmrc`; run `nvm use`. |
| Chrome | 116 or newer. |
| OS | Developed and tested on macOS. Windows and Linux are untested. |
| Disk | About 200 MB of models for recognition, plus 1.1 GB if you use local translation. Models download on first use. |

## Install

```bash
git clone https://github.com/nyo118/nsub-translate.git
cd nsub-translate
nvm use
npm run setup        # npm ci, download models, create packages/server/.env, build
```

Then load the extension: open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick `packages/extension/dist`. Prebuilt zips are also attached to each [GitHub release](https://github.com/nyo118/nsub-translate/releases).

Start the backend with `npm run start:server` (or install it as a login service with `npm run service:install`). Open a video, click the extension icon, press **开始字幕**.

**Backend on another machine, or translation through LM Studio:** on that machine run `npm run setup -- --lm-studio` instead. This skips the local translation engine, downloads only the recognition models and pre-fills `.env` with `TRANSLATION_PROVIDER=llm`. Fill in `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` and set `HOST=0.0.0.0`, then point the popup at it under 诊断 → 后端地址. The backend has no authentication, so only do this on a network you trust.

Cloud engines need a key in `packages/server/.env`; see `CONFIG.md`. The `.env` file is never committed.

## Common commands

| Command | What it does |
|---|---|
| `npm run setup` | One-shot setup for a fresh clone (`-- --lm-studio` for a machine without local translation) |
| `npm run start:server` / `npm run dev:server` | Run the backend from `dist` / with reload on change |
| `npm run service:install` | Start the backend at login (macOS launchd); also `service:status`, `service:restart`, `service:uninstall` |
| `npm run build` | Build protocol, server and extension |
| `npm run doctor` | Check Node, native modules, models and `.env` |
| `npm test`, `npm run lint`, `npm run typecheck` | Unit tests, ESLint, TypeScript |
| `npm run test:e2e` | Playwright tests against the built extension |
| `npm run bench` | Latency benchmark against a running backend |
| `npm run models:download`, `npm run models:verify` | Fetch or check models listed in `models.lock.json` |
| `npm run release -- --tag` | Build release zips and tag the version |

## Settings

The popup holds all settings: source and target language, translation engine, noise suppression, speaker labels, subtitle style and the backend address. Language and engine changes apply to the next session; style changes apply immediately.

## More

- `CONFIG.md` – environment variables and settings
- `TROUBLESHOOTING.md` – common errors and fixes
- `ARCHITECTURE.md` – how the pieces fit together, protocol versions
- `BENCHMARKS.md` – latency, translation coverage, speaker calibration
- `PRIVACY.md`, `COMPATIBILITY.md`, `CHANGELOG.md`, `ROLLBACK.md`

## License

Personal project. Models keep their own licenses (SenseVoice, Silero VAD, Hy-MT2, pyannote, 3D-Speaker, GTCRN, DPDFNet).
