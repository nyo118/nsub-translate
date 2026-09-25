# 回滚流程

发布产物：`release/v<版本>/` 下的两个 zip 与 `SHA256SUMS.txt`（由 `npm run release` 生成，上传到 GitHub Release）。每个版本对应 git tag `v<版本>` 与 `models.lock.json`。

## 1. 回退扩展（1 分钟）
1. 下载上一版 `nsub-translate-extension-v<旧版本>.zip`，解压到一个**新目录**（不要覆盖正在用的目录）。
2. `chrome://extensions` → 移除当前扩展 → Load unpacked 选择解压目录。
3. 刷新影片页面。设置保存在 `chrome.storage.local`，移除扩展会清空设置；如需保留，先在 popup「复制诊断信息」记下设置值。

## 2. 回退后端（2 分钟）
```bash
git fetch --tags
git checkout v<旧版本>
nvm use
npm ci
npm run models:verify        # 旧版本的 models.lock.json；不一致则 npm run models:download
npm run build
npm run start:server         # 或 npm run service:restart（服务从 dist 启动）
```
`.env` 不受版本影响（不入库）。协议版本不兼容时（扩展与后端主版本不同）popup 会报 `unsupported_protocol_version`：请把扩展和后端回退到同一版本。

## 3. 回退模型
模型文件按 `models.lock.json` 锁定；换版本后 `npm run models:verify` 提示不一致时，执行 `npm run models:download` 会按该版本的 URL 与校验和重新获取。

## 4. 回到最新
```bash
git checkout main && git pull
npm ci && npm run build && npm run service:restart
```

## 5. 验证
- `curl 127.0.0.1:8787/healthz` 的 `engines` 正常；
- popup 诊断区显示后端「运行中」；
- 打开一个 YouTube 视频开始字幕，30 秒内出现原文与译文。
