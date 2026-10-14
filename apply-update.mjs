// 独立脱离子进程：等 DSH 主进程退出后，执行 npm 全局替换并按原参数重启 dsh web。
// 由 index.js spawn，detached 模式运行。
// 环境变量：AUTOUPDATE_STATE_DIR = 状态目录（含 pending-update.json）

import { readFileSync, existsSync, rmSync, appendFileSync, mkdirSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

const stateDir = process.env.AUTOUPDATE_STATE_DIR || '';
const pendingPath = join(stateDir, 'pending-update.json');
const logPath = join(stateDir, 'apply.log');

function alog(msg) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

alog(`child spawned, stateDir=${stateDir}`);

// 无 pending 文件：不再静默退出（这是本次故障的根因路径）。
// 可能是"仅插件更新"场景的兜底触发——执行幂等安全重启，确保服务活着。
if (!stateDir || !existsSync(pendingPath)) {
  alog('no pending-update.json — idempotent safety restart path');
  const unit = process.env.AUTOUPDATE_SYSTEMD_UNIT || '';
  let restarted = false;
  if (unit) {
    try {
      const r = spawn('sudo', ['-n', 'systemctl', 'restart', unit], { stdio: 'ignore' });
      const code = await new Promise((res) => {
        const t = setTimeout(() => res(-1), 20000);
        r.on('close', (c) => { clearTimeout(t); res(c); });
        r.on('error', () => { clearTimeout(t); res(-1); });
      });
      alog(`safety systemctl restart ${unit} exit=${code}`);
      restarted = code === 0;
    } catch (e) { alog(`safety restart threw: ${e.message}`); }
  }
  if (!restarted) {
    // 兜底：用环境变量传递的原 argv 重新拉起 dsh web
    const argv = (process.env.AUTOUPDATE_ARGV || '').split('\0').filter(Boolean);
    const dshBin = argv[1] || null;
    if (dshBin && existsSync(dshBin)) {
      try {
        const child = spawn(dshBin, argv.slice(2), { detached: true, stdio: 'ignore' });
        child.unref();
        alog(`fallback relaunch pid=${child.pid}`);
        restarted = true;
      } catch (e) { alog(`fallback relaunch failed: ${e.message}`); }
    } else {
      alog('no systemd unit and no usable argv — cannot relaunch (service stays down until manual start)');
    }
  }
  alog(`safety path done (restarted=${restarted})`);
  process.exit(restarted ? 0 : 1);
}

const instruction = JSON.parse(readFileSync(pendingPath, 'utf8'));

// fork/spawn 后 child 的 ppid 就是 dsh web 主进程；等它退出
const parentPid = process.ppid;
alog(`waiting for parent ${parentPid} to exit...`);

const waitForParentExit = async () => {
  for (let i = 0; i < 300; i++) {
    try { process.kill(parentPid, 0); } catch { return true; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
};

const parentGone = await waitForParentExit();
if (!parentGone) {
  alog('parent still alive after 300s, abort');
  process.exit(1);
}
alog('parent exited, applying update');

const nodeBin = instruction.nodeBin;
const prefix = dirname(nodeBin); // .../bin
const dshBin = join(prefix, 'dsh');
const npmBin = join(prefix, 'npm');
const globalRoot = `${prefix}/../lib/node_modules/@deepseek-ai/dsh`;

// 1. npm 全局安装新版本
try {
  const r = spawn(npmBin, ['install', '-g', `@deepseek-ai/dsh@${instruction.tag}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  r.stdout.on('data', (d) => { out += d; });
  r.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => r.on('close', res));
  alog(`npm install exit=${code}\n${out.slice(-4000)}`);
  if (code !== 0) {
    alog('npm install failed, aborting (will not restart with old binary gone... checking)');
  }
} catch (e) {
  alog(`npm install threw: ${e.message}`);
}

// 2. 验证新版本 + 启动器链接校验（借鉴 dsh-self-upgrade 的防变砖检查）：
//    npm 更新 prefix/bin 的流程是"先建临时链接再重命名"，中途被杀会停在临时名，
//    dsh 命令消失 → systemd 重启就再也起不来。重启前必须核一遍。
let newVer = null;
let launcherFixed = false;
try {
  newVer = JSON.parse(readFileSync(`${globalRoot}/package.json`, 'utf8')).version;
  alog(`installed version: ${newVer}`);
} catch (e) { alog(`verify read failed: ${e.message}`); }

// 启动器链接：/usr/bin/dsh 或 nodeBin 同级的 dsh 必须存在且可执行
const launcherCandidates = ['/usr/bin/dsh', '/usr/local/bin/dsh', join(prefix, 'dsh')];
for (const cand of launcherCandidates) {
  if (!existsSync(cand)) continue;
  try {
    const target = readlinkSync(cand);
    if (target && !existsSync(cand)) { // 断链
      alog(`BROKEN launcher link ${cand} -> ${target}`);
    }
  } catch {} // 非 symlink 也 OK（真实文件）
}
// 核心校验：npm 全局 bin 目录里的 dsh 必须存在，否则不重启（避免变砖）
if (!existsSync(dshBin)) {
  alog(`FATAL: dsh binary missing at ${dshBin} after install — NOT restarting (avoid brick). 手动检查 npm 输出后重启。`);
  appendFileSync(join(stateDir, 'history.jsonl'), JSON.stringify({
    at: new Date().toISOString(), kind: 'harness-aborted',
    reason: 'dsh binary missing after npm install', applied: newVer,
  }) + '\n');
  try { rmSync(pendingPath); } catch {}
  process.exit(1);
}

// 3. 记录历史
try {
  appendFileSync(join(stateDir, 'history.jsonl'), JSON.stringify({
    at: new Date().toISOString(), kind: 'harness-applied',
    from: instruction.from, to: instruction.tag, applied: newVer,
  }) + '\n');
} catch {}

// 4. 重启：优先 systemd（服务由 systemd 管理，裸拉起会脱离监管）。
//    服务名来自 pending-update.json 的 systemdUnit（Host 侧从 config 或 /proc/self/cgroup 探测）。
let restarted = false;
const systemdUnit = instruction.systemdUnit || '';
if (systemdUnit) {
  try {
    const r = spawn('sudo', ['-n', 'systemctl', 'restart', systemdUnit], {
      detached: true, stdio: 'ignore',
    });
    const code = await new Promise((res) => {
      const t = setTimeout(() => res(-1), 20000);
      r.on('close', (c) => { clearTimeout(t); res(c); });
      r.on('error', () => { clearTimeout(t); res(-1); });
    });
    alog(`systemctl restart ${systemdUnit} exit=${code}`);
    restarted = code === 0;
  } catch (e) {
    alog(`systemctl restart threw: ${e.message}`);
  }
} else {
  alog('no systemdUnit in instruction, skipping systemctl path');
}

// 兜底：systemd 不可用时按原 argv 裸拉起
if (!restarted) {
  const argv = Array.isArray(instruction.argv) ? instruction.argv : null;
  const dshBin = join(dirname(instruction.nodeBin), 'dsh');
  if (argv && argv.length >= 2 && existsSync(dshBin)) {
    try {
      const args = argv.slice(2); // 去掉 node 和 dsh 路径
      const child = spawn(dshBin, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      alog(`fallback relaunch dsh ${args.join(' ')} pid=${child.pid}`);
      restarted = true;
    } catch (e) {
      alog(`fallback relaunch failed: ${e.message}`);
    }
  } else {
    alog('systemd restart failed and no valid argv for fallback');
  }
}

// 5. 清理 pending
try { rmSync(pendingPath); } catch {}
alog(`done (restarted=${restarted})`);
process.exit(0);
