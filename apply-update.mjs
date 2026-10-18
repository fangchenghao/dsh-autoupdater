// DSH 本体更新执行器：npm install -g（运行中执行，只改磁盘）→ 校验 → 重启服务。
// 由 main.js 通过 `systemd-run --unit=dsh-autoupdater-apply` 启动，
// 因此不在 dsh-web.service 的 cgroup 里 —— 重启 dsh-web 不会杀掉本进程。
//
// 环境变量：
//   AUTOUPDATE_STATE_DIR    状态目录（含 pending-update.json）
//   AUTOUPDATE_SYSTEMD_UNIT 要重启的 systemd 服务名（可空）
//   AUTOUPDATE_ARGV         原启动 argv（空格分隔，systemd 不可用时的裸拉起兜底）

import { readFileSync, existsSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
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

alog(`apply-update started (pid=${process.pid}, stateDir=${stateDir})`);

if (!stateDir) {
  alog('AUTOUPDATE_STATE_DIR missing — nothing to do');
  process.exit(1);
}
if (!existsSync(pendingPath)) {
  alog('no pending-update.json — nothing to apply');
  process.exit(0);
}

const instruction = JSON.parse(readFileSync(pendingPath, 'utf8'));
const unit = instruction.systemdUnit || process.env.AUTOUPDATE_SYSTEMD_UNIT || '';
const nodeBin = instruction.nodeBin || process.execPath;
const prefix = dirname(nodeBin);
const dshBin = join(prefix, 'dsh');
const npmBin = join(prefix, 'npm');
const globalRoot = `${prefix}/../lib/node_modules/@deepseek-ai/dsh`;

alog(`target: ${instruction.pkg}@${instruction.tag} (from ${instruction.from}), unit=${unit || 'none'}`);

// 1. npm install -g：服务仍在运行，只替换磁盘文件（运行中进程不受影响）
let installOk = false;
try {
  const r = spawn(npmBin, ['install', '-g', `${instruction.pkg}@${instruction.tag}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  r.stdout.on('data', (d) => { out += d; });
  r.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((res) => r.on('close', res));
  alog(`npm install exit=${code}\n${out.slice(-3000)}`);
  installOk = code === 0;
} catch (e) {
  alog(`npm install threw: ${e.message}`);
}

// 2. 校验磁盘版本 + dsh 二进制存在（防变砖：缺二进制绝不重启）
let newVer = null;
try {
  newVer = JSON.parse(readFileSync(`${globalRoot}/package.json`, 'utf8')).version;
  alog(`disk version after install: ${newVer}`);
} catch (e) {
  alog(`verify read failed: ${e.message}`);
}

if (!existsSync(dshBin)) {
  alog(`FATAL: dsh binary missing at ${dshBin} — NOT restarting (brick guard). Service keeps running old version.`);
  try {
    appendFileSync(join(stateDir, 'history.jsonl'), JSON.stringify({
      at: new Date().toISOString(), kind: 'harness-aborted',
      reason: 'dsh binary missing after npm install', applied: newVer,
    }) + '\n');
  } catch {}
  try { rmSync(pendingPath); } catch {}
  process.exit(1);
}

if (!installOk && !newVer) {
  alog('install failed and no version readable — NOT restarting');
  try { rmSync(pendingPath); } catch {}
  process.exit(1);
}

// 3. 记录落盘结果
try {
  appendFileSync(join(stateDir, 'history.jsonl'), JSON.stringify({
    at: new Date().toISOString(), kind: 'harness-applied',
    from: instruction.from, to: instruction.tag, applied: newVer,
  }) + '\n');
} catch {}

// 4. 重启：本进程在独立的瞬时单元里，重启 dsh-web 不会杀掉自己
let restarted = false;
if (unit) {
  try {
    const r = spawn('sudo', ['-n', 'systemctl', 'restart', unit], { stdio: 'ignore' });
    const code = await new Promise((res) => {
      const t = setTimeout(() => res(-1), 60000);
      r.on('close', (c) => { clearTimeout(t); res(c); });
      r.on('error', () => { clearTimeout(t); res(-1); });
    });
    alog(`systemctl restart ${unit} exit=${code}`);
    restarted = code === 0;
  } catch (e) {
    alog(`systemctl restart threw: ${e.message}`);
  }
}

// 5. 无 systemd 时按原 argv 裸拉起（仅在确实拿到完整 argv 时；空的 argv 绝不擅自再拉一个实例，
//    否则会与仍在运行的服务抢端口）
if (!restarted) {
  const argv = (process.env.AUTOUPDATE_ARGV || '').trim().split(/\s+/).filter(Boolean);
  if (argv.length >= 2 && existsSync(argv[1])) {
    try {
      const child = spawn(argv[1], argv.slice(2), { detached: true, stdio: 'ignore' });
      child.unref();
      alog(`fallback relaunch pid=${child.pid}`);
      restarted = true;
    } catch (e) {
      alog(`fallback relaunch failed: ${e.message}`);
    }
  } else {
    alog('no systemd unit and no usable argv — not relaunching (disk updated; restart dsh manually to activate)');
  }
}

// 6. 清理 pending（保留会永久阻塞后续检查，故一律删除；失败原因已写入日志与 history）
try { rmSync(pendingPath); } catch {}

alog(`done (installed=${newVer}, restarted=${restarted})`);
process.exit(restarted ? 0 : 1);
