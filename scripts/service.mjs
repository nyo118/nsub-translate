#!/usr/bin/env node
// macOS launchd user agent for the backend (starts at login, restarts on crash).
//   node scripts/service.mjs install | uninstall | status | restart
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.nsub.translate.backend';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const logsDir = path.join(root, 'packages/server/logs');
const entry = path.join(root, 'packages/server/dist/index.js');
const cmd = process.argv[2];
const uid = process.getuid?.() ?? 501;

function launchctl(args, quiet = false) {
  const r = spawnSync('launchctl', args, { stdio: quiet ? 'pipe' : 'inherit' });
  return r.status;
}

switch (cmd) {
  case 'install': {
    if (process.platform !== 'darwin') {
      console.error('service install is macOS-only (launchd). On other systems run: npm run start:server');
      process.exit(1);
    }
    if (!existsSync(entry)) {
      console.error(`missing ${entry} — run: npm run build`);
      process.exit(1);
    }
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(path.dirname(plist), { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${root}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${path.join(logsDir, 'backend.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logsDir, 'backend.err.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DYLD_LIBRARY_PATH</key><string>${path.join(root, 'node_modules', `sherpa-onnx-darwin-${process.arch}`)}</string>
  </dict>
</dict>
</plist>
`;
    writeFileSync(plist, xml);
    launchctl(['bootout', `gui/${uid}`, plist], true);
    if (launchctl(['bootstrap', `gui/${uid}`, plist]) !== 0) process.exit(1);
    console.log(`installed ${plist}\nnode: ${process.execPath}\nlogs: ${logsDir}/backend.{out,err}.log\nThe backend reads packages/server/.env at start.`);
    break;
  }
  case 'uninstall': {
    launchctl(['bootout', `gui/${uid}`, plist], true);
    if (existsSync(plist)) unlinkSync(plist);
    console.log(`removed ${LABEL}`);
    break;
  }
  case 'restart': {
    if (launchctl(['kickstart', '-k', `gui/${uid}/${LABEL}`]) !== 0) process.exit(1);
    console.log('restarted');
    break;
  }
  case 'status': {
    const out = spawnSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { encoding: 'utf8' });
    if (out.status !== 0) {
      console.log('not installed');
      break;
    }
    const pid = /pid = (\d+)/.exec(out.stdout)?.[1];
    const state = /state = (\w+)/.exec(out.stdout)?.[1];
    let health = 'no response';
    try {
      health = execSync('curl -s -m 2 http://127.0.0.1:8787/healthz', { encoding: 'utf8' }).slice(0, 120);
    } catch {
      /* not listening */
    }
    console.log(`${LABEL}: state=${state ?? '?'} pid=${pid ?? '-'}\nhealthz: ${health}`);
    break;
  }
  default:
    console.error('usage: node scripts/service.mjs install|uninstall|status|restart');
    process.exit(1);
}
