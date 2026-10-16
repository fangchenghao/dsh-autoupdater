import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * dsh-autoupdater — 定时检查 DSH 本体与已装 bundle 插件的更新。
 * 零第三方依赖。
 *
 * 配置分两层：
 *  - 初始值：cordis.patch.yml 的 config（loader 注入）
 *  - 运行值：$DSH_HOME/autoupdater/config.json（Web 面板写入，保存即生效，无需重启）
 * 安全门槛字段（idleSeconds/idleTimeoutMinutes/graceMinutes）由面板提交但服务端强制 clamp，
 * 不提供绕过空闲判定的选项。
 *
 * 安全门槛（缺一不可）：
 *  1. 所有 Agent 状态为 idle
 *  2. 连续 idleSeconds 秒无任何会话活动
 *  3. DSH 本体重启额外要求：graceMinutes 宽限期内 activity 时间戳无推进
 */

const DEFAULTS = Object.freeze({
  scheduleMode: 'daily',        // daily | everyHours | everyDays | everyMinutes
  dailyTime: '04:30',           // daily / everyDays 锚定时刻
  everyHours: 6,                // 每 N 小时（整点对齐）
  everyDays: 1,                 // 每 N 天（锚定 dailyTime）
  everyMinutes: 60,             // 每 N 分钟（从启动/保存时刻起算）
  idleTimeoutMinutes: 120,
  idleSeconds: 300,
  verbose: true,
  harnessMode: 'notify',        // off | notify | auto（默认 notify：陌生人安装保守起步）
  graceMinutes: 30,
  distTag: 'latest',
  systemdUnit: '',              // 重启用的 systemd 服务名；空 = 自动探测
  pluginMode: 'regexmode-ignore', // regexmode-ignore | auto-all | notify-all | off | whitelist-auto
  whitelist: [],
});

const PLUGIN_MODES = new Set(['regexmode-ignore', 'auto-all', 'notify-all', 'off', 'whitelist-auto']);
const HARNESS_MODES = new Set(['off', 'notify', 'auto']);
const SCHEDULE_MODES = new Set(['daily', 'everyHours', 'everyDays', 'everyMinutes']);

// ─────────────────────────── 小工具 ───────────────────────────

const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 规范化任意来源的配置对象，返回安全可用的完整配置。 */
function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS, ...(raw ?? {}) };
  c.scheduleMode = SCHEDULE_MODES.has(c.scheduleMode) ? c.scheduleMode : DEFAULTS.scheduleMode;
  c.harnessMode = HARNESS_MODES.has(c.harnessMode) ? c.harnessMode : DEFAULTS.harnessMode;
  c.pluginMode = PLUGIN_MODES.has(c.pluginMode) ? c.pluginMode : DEFAULTS.pluginMode;
  if (typeof c.dailyTime !== 'string' || !HHMM_RE.test(c.dailyTime)) c.dailyTime = DEFAULTS.dailyTime;
  c.everyHours = clampInt(c.everyHours, 1, 168, DEFAULTS.everyHours);
  c.everyDays = clampInt(c.everyDays, 1, 365, DEFAULTS.everyDays);
  c.everyMinutes = clampInt(c.everyMinutes, 1, 10080, DEFAULTS.everyMinutes);
  c.idleSeconds = clampInt(c.idleSeconds, 30, 3600, DEFAULTS.idleSeconds);
  c.idleTimeoutMinutes = clampInt(c.idleTimeoutMinutes, 5, 720, DEFAULTS.idleTimeoutMinutes);
  c.graceMinutes = clampInt(c.graceMinutes, 1, 720, DEFAULTS.graceMinutes);
  c.whitelist = Array.isArray(c.whitelist)
    ? [...new Set(c.whitelist.filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim()))]
    : [];
  c.verbose = c.verbose !== false;
  return c;
}

/** 下次调度触发的时间戳（ms）。 */
function nextRunAt(c, fromMs = Date.now()) {
  const [h, m] = String(c.dailyTime).split(':').map(Number);
  if (c.scheduleMode === 'daily') {
    const target = new Date(fromMs);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= fromMs) target.setDate(target.getDate() + 1);
    return target.getTime();
  }
  if (c.scheduleMode === 'everyHours') {
    // 整点对齐：每 everyHours 小时的边界整点触发
    const interval = c.everyHours * 3600_000;
    const dayStart = new Date(fromMs); dayStart.setHours(0, 0, 0, 0);
    for (let i = 1; i <= 24; i++) {
      const t = dayStart.getTime() + i * interval;
      if (t > fromMs) return t;
    }
    return dayStart.getTime() + 24 * 3600_000;
  }
  if (c.scheduleMode === 'everyDays') {
    const target = new Date(fromMs);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= fromMs) target.setDate(target.getDate() + c.everyDays);
    return target.getTime();
  }
  // everyMinutes：从现在起算
  return fromMs + c.everyMinutes * 60_000;
}

function semverGt(a, b) {
  if (!a || !b) return false;
  const pa = String(a).replace(/^v/, '').split(/[.+-]/).map(Number);
  const pb = String(b).replace(/^v/, '').split(/[.+-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function log(...args) {
  console.log('[dsh-autoupdater]', ...args);
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

// ─────────────────────────── 主插件 ───────────────────────────

export const inject = ['agents', 'pluginManager', 'webServer'];

export function apply(ctx, rawConfig = {}) {
  const home = process.env.DSH_HOME || `${process.env.HOME}/.dsh`;
  const stateDir = `${home}/autoupdater`;
  const statePath = `${stateDir}/status.json`;
  const historyPath = `${stateDir}/history.jsonl`;
  const pendingPath = `${stateDir}/pending-update.json`;
  const hotConfigPath = `${stateDir}/config.json`;

  let state = { lastRun: null, lastNotice: null, updates: [], lastError: null };
  readJson(statePath).then((s) => { if (s) state = { ...state, ...s }; }).catch(() => {});

  // 初始配置 = YAML 注入值；运行时覆盖来自 config.json（每次调度/检查前重读）
  let config = normalizeConfig(rawConfig);

  async function reloadHotConfig() {
    const hot = await readJson(hotConfigPath);
    if (hot) config = normalizeConfig({ ...rawConfig, ...hot });
  }

  // ── profile 目录探测（磁盘版本回读用）──
  // DSH_PROFILE_DIR 优先；否则在 $DSH_HOME/profiles 下找含 node_modules 的目录，
  // 多个时取 node_modules 最近修改的。找不到 = 磁盘回读退化为仅信安装结果。
  let profileDir = process.env.DSH_PROFILE_DIR || null;
  try {
    const base = `${home}/profiles`;
    const candidates = readdirSync(base)
      .map((name) => `${base}/${name}`)
      .filter((dir) => existsSync(`${dir}/node_modules`));
    if (candidates.length === 1) {
      profileDir = candidates[0];
    } else if (candidates.length > 1) {
      profileDir = candidates
        .map((dir) => ({ dir, m: statSync(`${dir}/node_modules`).mtimeMs }))
        .sort((a, b) => b.m - a.m)[0].dir;
    }
    if (profileDir && config.verbose) log('profileDir detected:', profileDir);
  } catch {}

  // ---- 活动追踪 ----
  let lastActivity = nowSec();
  const bump = () => { lastActivity = nowSec(); };

  const disposers = [];
  try { disposers.push(ctx.on('api-session/activity', bump)); } catch {}
  try { disposers.push(ctx.on('agent/inbox/inserted', bump)); } catch {}
  try { disposers.push(ctx.on('session/created', bump)); } catch {}
  try {
    disposers.push(ctx.on('agent/status', ({ status }) => { if (status === 'running') bump(); }));
  } catch {}

  // 借鉴 dsh-self-upgrade 的判定（实测比 agent.status 可靠）：
  // 会话日志 2 分钟内无任何写入 = 无进行中的工作。agent.status 存在 turn 结束
  // 后仍停留 'running' 的情况（本机实测），会永久阻塞空闲判定，故弃用。
  const sessionsDir = `${home}/sessions`;
  let sessionsBusyCache = { at: 0, busy: true };
  const anyAgentRunning = () => {
    const now = Date.now();
    if (now - sessionsBusyCache.at < 8000) return sessionsBusyCache.busy; // 8s 缓存
    try {
      // mtime 探测：-newermt 用固定秒窗避免 -mmin 的分钟取整误差
      const cutoff = new Date(Date.now() - 120_000).toISOString();
      const out = execSync(
        `find ${JSON.stringify(sessionsDir)} -type f -newermt ${JSON.stringify(cutoff)} 2>/dev/null | head -1`,
        { timeout: 8000 },
      ).toString().trim();
      sessionsBusyCache = { at: now, busy: out !== '' };
    } catch { sessionsBusyCache = { at: now, busy: true }; } // 探测失败保守当忙
    return sessionsBusyCache.busy;
  };

  const idleFor = () => nowSec() - lastActivity;
  const isIdle = () => !anyAgentRunning() && idleFor() >= config.idleSeconds;

  /** 等到空闲；true=达成，false=超时。双重采样防瞬时空档误判。 */
  async function waitIdle(maxWaitSec) {
    const deadline = nowSec() + maxWaitSec;
    while (nowSec() < deadline) {
      if (isIdle()) {
        await sleep(15000);
        if (isIdle()) return true;
        continue;
      }
      await sleep(30000);
    }
    return isIdle();
  }

  async function saveState() {
    try {
      await mkdir(stateDir, { recursive: true });
      await writeFile(statePath, JSON.stringify(state, null, 2));
    } catch (e) { log('saveState failed:', e?.message); }
  }
  async function appendHistory(entry) {
    try {
      await mkdir(stateDir, { recursive: true });
      await appendFile(historyPath, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
      // 日志轮转：超过 500 条时保留最近 300 条（防止多年运行无限增长）
      const raw = await readFile(historyPath, 'utf8').catch(() => '');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length > 500) {
        await writeFile(historyPath, lines.slice(-300).join('\n') + '\n');
      }
    } catch {}
  }

  async function notify(title, desp) {
    log('NOTIFY:', title, '—', desp);
    state.lastNotice = { at: new Date().toISOString(), title, desp };
    await saveState();
  }

  // ---- npm 查询 ----
  // 查询源可配置：默认 npmmirror（国内镜像，与官方数据同步，链路稳定 0.3s）；
  // registry.npmjs.org（Cloudflare 海外）在国内链路劣化时会持续 CONNECT_TIMEOUT。
  // 熔断：npmmirror 也失败（罕见）则退回官方源重试一次。
  import('undici').then((u) => { globalThis.__undiciAgentCtor = u.Agent; }).catch(() => {});
  const REGISTRY_PRIMARY = 'https://registry.npmmirror.com';
  const REGISTRY_FALLBACK = 'https://registry.npmjs.org';
  async function npmLatestVersion(pkg) {
    const registries = [REGISTRY_PRIMARY, REGISTRY_FALLBACK];
    for (const base of registries) {
      const t0 = Date.now();
      try {
        const fetchOpts = {
          signal: AbortSignal.timeout(20000),
          headers: { accept: 'application/json' },
        };
        if (globalThis.__undiciAgentCtor) {
          fetchOpts.dispatcher = new globalThis.__undiciAgentCtor({
            connect: { timeout: 15000 },
            bodyTimeout: 20000,
            headersTimeout: 20000,
          });
        }
        const res = await fetch(`${base}/${encodeURIComponent(pkg)}`, fetchOpts);
        if (!res.ok) throw new Error(`${base} ${res.status}`);
        const data = await res.json();
        const v = data?.['dist-tags']?.[config.distTag] ?? null;
        if (config.verbose) log(`npm ${pkg}: ${Date.now() - t0}ms → ${v ?? 'null'} (${new URL(base).host})`);
        return v;
      } catch (e) {
        const cause = e?.cause?.code || e?.cause?.message || e?.message;
        log(`npm ${pkg} via ${new URL(base).host} FAILED after ${Date.now() - t0}ms: ${e.message} (cause: ${cause})`);
        // 主源失败 → 尝试 fallback；fallback 也失败 → 抛出（由熔断计数）
      }
    }
    const wrapped = new Error(`all registries failed for ${pkg}`);
    throw wrapped;
  }

  function harnessPkgPath() {
    const nodeDir = process.execPath.replace(/\/bin\/node$/, '');
    return `${nodeDir}/lib/node_modules/@deepseek-ai/dsh/package.json`;
  }

  function currentArgv() {
    try {
      return readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
    } catch { return null; }
  }

  // ---- DSH 本体 ----
  async function stageHarnessUpdate(latest, cur) {
    const instruction = {
      action: 'apply-harness-update',
      pkg: '@deepseek-ai/dsh',
      tag: config.distTag,
      from: cur,
      to: latest,
      nodeBin: process.execPath,
      argv: currentArgv(),
      // 重启方式：systemdUnit 有值走 systemctl restart；否则按 argv 自行拉起
      systemdUnit: config.systemdUnit || detectSystemdUnit(),
      stagedAt: new Date().toISOString(),
    };
    await mkdir(stateDir, { recursive: true });
    await writeFile(pendingPath, JSON.stringify(instruction, null, 2));
    log('harness update staged →', latest);
  }

  /** 自动探测管理本进程的 systemd 服务名（无则返回空 = 裸进程模式） */
  function detectSystemdUnit() {
    try {
      const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
      const m = cgroup.match(/\/system\.slice\/([a-z0-9@._-]+\.service)/i);
      if (m) return m[1];
    } catch {}
    return '';
  }

  /** 直接执行 systemd 重启（插件更新场景：无需 npm install，只激活磁盘上的新版本）。
   *  在主进程内同步执行；重启成功 = 本进程被杀，执行不到后续代码。 */
  async function restartViaSystemd(unit) {
    const { spawn } = await import('node:child_process');
    const r = spawn('sudo', ['-n', 'systemctl', 'restart', unit], { detached: true, stdio: 'ignore' });
    const code = await new Promise((res) => {
      const t = setTimeout(() => res(-1), 20000);
      r.on('close', (c) => { clearTimeout(t); res(c); });
      r.on('error', () => { clearTimeout(t); res(-1); });
    });
    log(`systemctl restart ${unit} issued (exit=${code})`);
    // systemd restart 对本进程是 SIGTERM：若 20s 后还活着（sudo 失败等），说明重启没发生
    return code === 0;
  }

  async function applyHarnessUpdateNow() {
    const pendingExists = existsSync(pendingPath);
    const unit = config.systemdUnit || detectSystemdUnit();

    // 路径 A：仅插件更新（无 pending 文件）→ 无需 npm install，直接重启激活新插件
    if (!pendingExists) {
      log('no pending harness update — plugin-only restart');
      await appendHistory({ kind: 'plugin-only-restart', unit });
      if (unit) {
        await restartViaSystemd(unit);
        // 走到这里说明 sudo 失败/超时，进程还活着：记录并兜底裸退出让 systemd 判定
        log('restart command did not take effect; falling back to detached child');
      } else {
        log('no systemd unit available; falling back to detached child');
      }
      // 兜底：交给子进程（它走安全重启路径：systemd 幂等重启或按 argv 拉起）
    }
    const { spawn } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const self = join(dirname(fileURLToPath(import.meta.url)), 'apply-update.mjs');
    const child = spawn(process.execPath, [self], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        AUTOUPDATE_STATE_DIR: stateDir,
        AUTOUPDATE_SYSTEMD_UNIT: unit,           // 安全重启路径用
        AUTOUPDATE_ARGV: currentArgv().join(' '), // 裸拉起兜底用（空格分隔；env 值不允许 null byte）
      },
    });
    child.unref();
    log('detached apply child spawned, exiting for update');
    await appendHistory({ kind: 'harness-restart', to: harnessNotice?.version });
    setTimeout(() => process.exit(0), 3000);
  }

  async function checkHarness(report) {
    if (config.harnessMode === 'off') return;
    if (existsSync(pendingPath)) {
      if (config.verbose) log('pending update already staged, skip harness check');
      return;
    }
    const dshPkg = await readJson(harnessPkgPath());
    const cur = dshPkg?.version;
    if (!cur) { log('cannot resolve @deepseek-ai/dsh version at', harnessPkgPath()); return; }
    const latest = await npmLatestVersion('@deepseek-ai/dsh');
    if (!latest) return;
    if (!semverGt(latest, cur)) {
      if (config.verbose) log(`harness up to date (${cur})`);
      return;
    }
    report.push(`DSH 本体 ${cur} → ${latest} (staged)`);
    await stageHarnessUpdate(latest, cur);
    if (config.harnessMode === 'auto') {
      harnessNotice = { from: nowSec(), version: latest };
      await notify(
        `DSH 将自动更新到 ${latest}`,
        `${config.graceMinutes} 分钟后无人使用即自动重启。想推迟：现在打开 DSH 发条消息即可。`
      );
    } else {
      await notify(`DSH 有新版本 ${latest}`, '已暂存更新，空闲时段重启 dsh web 生效。');
    }
  }

  // ---- 插件 ----
  function decide(name) {
    if (config.pluginMode === 'off') return 'skip';
    if (config.pluginMode === 'notify-all') return 'notify';
    if (config.pluginMode === 'auto-all') return 'auto';
    const inWl = config.whitelist.includes(name);
    if (config.pluginMode === 'regexmode-ignore') return inWl ? 'notify' : 'auto';
    if (config.pluginMode === 'whitelist-auto') return inWl ? 'auto' : 'notify';
    return 'notify';
  }

  // 重复更新抑制：24h 内同一 name@to 不重装（installBundle 返回 restart-required 时
  // 运行时视图版本号不变，会每轮误判为待更新）
  const recentAttempts = new Map(); // `${name}@${latest}` -> ts
  const ATTEMPT_TTL = 24 * 3600 * 1000;

  async function checkAndApplyPlugins(report, { exemptQuiet = false } = {}) {
    const pm = ctx.pluginManager;
    if (!pm?.listBundles || !pm?.installBundle) return;
    const now = Date.now();
    for (const [k, ts] of recentAttempts) if (now - ts > ATTEMPT_TTL) recentAttempts.delete(k);
    const bundles = await pm.listBundles();
    const items = (bundles ?? []).filter((b) => b?.installed && b?.removable && b.name !== 'dsh-autoupdater');
    // 动手前的门：手动触发只要求"此刻无运行中会话"（豁免静默等待）；
    // 定时触发走完整空闲判定（无会话 + 静默满 idleSeconds）。
    const gate = exemptQuiet ? () => !anyAgentRunning() : isIdle;
    // 网络熔断：连续 4 个包查询失败即中止本轮（网络整体不可用时，
    // 与其 24 个包 × 30s 干等 12 分钟，不如尽快放弃，下轮再试）
    let consecutiveNetFails = 0;
    const NET_FAIL_LIMIT = 4;
    for (const b of items) {
      if (consecutiveNetFails >= NET_FAIL_LIMIT) {
        report.push(`⚠ 连续 ${NET_FAIL_LIMIT} 个包网络超时，中止本轮（网络恢复后下轮自动重试）`);
        break;
      }
      const decision = decide(b.name);
      if (decision === 'skip') continue;
      try {
        const latest = await npmLatestVersion(b.name);
        consecutiveNetFails = 0;
        if (!latest || !semverGt(latest, b.version)) continue;
        const key = `${b.name}@${latest}`;
        if (recentAttempts.has(key)) {
          report.push(`${b.name} ${b.version} → ${latest} (24h 内已尝试，跳过重复安装)`);
          continue;
        }
        report.push(`${b.name} ${b.version} → ${latest} (${decision})`);
        if (decision !== 'auto') continue;
        if (!gate()) { report.push(`  ⚠ 空闲丢失，跳过 ${b.name}`); continue; }
        recentAttempts.set(key, now);
        // 显式带 @version：installBundle(裸名) 对精确钉版的包只会"确保已装"（pnpm 跳过），
        // 不会升级——这是假更新的根因。
        const result = await pm.installBundle(`${b.name}@${latest}`);
        // 装完回读磁盘真实版本验证，不再信返回值
        let diskVer = null;
        if (profileDir) {
          const diskPkg = await readJson(`${profileDir}/node_modules/${b.name}/package.json`).catch(() => null);
          diskVer = diskPkg?.version ?? null;
        }
        const reallyUpdated = diskVer == null ? true : diskVer !== b.version; // 无 profileDir 时退化为信安装结果
        const ok = (result?.application === 'applied' || result?.application === 'restart-required') && reallyUpdated;
        log(`plugin update ${b.name}:`, result?.application, `disk=${diskVer}`, reallyUpdated ? '✓' : '✗ 未变化', result?.error?.message ?? '');
        await appendHistory({ kind: 'plugin', name: b.name, from: b.version, to: latest, outcome: result?.application, diskVer });
        if (!ok) report.push(`  ✗ ${b.name} 更新失败: ${result?.application}${reallyUpdated ? '' : `（磁盘仍为 ${diskVer}）`}`);
      } catch (e) {
        log(`plugin check ${b.name} failed:`, e?.message);
        consecutiveNetFails++;
      }
    }
  }

  // ---- 主循环 ----
  let harnessNotice = null;
  let running = false;

  async function runCheck(trigger) {
    if (running) return;
    running = true;
    try {
      await reloadHotConfig();
      log(`check start (${trigger})`);
      state.lastRun = new Date().toISOString();

      let got;
      if (trigger === 'manual') {
        // 立即检查语义：无运行中会话 → 立即开始（不等 idleSeconds 静默）；
        // 有会话运行 → 轮询等待其结束，最多 idleTimeoutMinutes。
        const deadline = nowSec() + config.idleTimeoutMinutes * 60;
        got = false;
        while (nowSec() < deadline) {
          if (!anyAgentRunning()) { got = true; break; }
          await sleep(10000);
        }
      } else {
        got = await waitIdle(config.idleTimeoutMinutes * 60);
      }
      if (!got) {
        log('idle window not reached, skip this round');
        state.lastRun += ' (skipped: busy)';
        await saveState();
        return;
      }

      const report = [];
      await checkAndApplyPlugins(report, { exemptQuiet: trigger === 'manual' });
      try {
        await checkHarness(report);
      } catch (e) {
        // 本体检查的网络失败不应抹掉本轮插件检查的成果（report 已有部分结果）
        report.push(`⚠ 本体检查失败（网络）：${e?.message?.slice(0, 80)}`);
        log('harness check failed (network):', e?.message);
      }

      state.updates = report;
      state.lastError = null;
      await saveState();
      await appendHistory({ kind: 'check', trigger, findings: report });
      log('check done:', report.length ? report : 'no updates');

      // 立即检查且本轮有实际更新动作 → 延时 10 秒重启 DSH，
      // 让 restart-required 的新插件与本体重启一并生效。
      const applied = report.filter((line) =>
        typeof line === 'string' && (/\(auto\)$/.test(line) || /\(staged\)$/.test(line)) && !/跳过/.test(line));
      if (trigger === 'manual' && applied.length > 0) {
        log(`updates applied (${applied.length}), restart DSH in 10s`);
        await appendHistory({ kind: 'manual-restart-scheduled', updates: applied, inSeconds: 10 });
        await sleep(10000);
        await applyHarnessUpdateNow(); // 不返回：派生子进程更新+重启
        return;
      }
    } catch (e) {
      log('check error:', e?.message ?? e);
      state.lastError = String(e?.message ?? e);
      await appendHistory({ kind: 'error', trigger, message: String(e?.message ?? e) });
    } finally {
      running = false;
    }
  }

  // ---- 宽限期 tick ----
  async function tick() {
    try {
      if (!harnessNotice || config.harnessMode !== 'auto') return;
      const quietFor = nowSec() - Math.max(harnessNotice.from, lastActivity);
      if (quietFor >= config.graceMinutes * 60 && !anyAgentRunning()) {
        await applyHarnessUpdateNow(); // 不返回
      }
    } catch (e) { log('tick error:', e?.message); }
  }

  // ---- 调度（四种模式；触发后按新配置重排）----
  let scheduleTimer = null;
  let graceTimer = null;

  function reschedule() {
    if (scheduleTimer) { clearTimeout(scheduleTimer); scheduleTimer = null; }
    const at = nextRunAt(config);
    if (!(at > 0)) return;
    const delay = Math.max(1000, at - Date.now());
    scheduleTimer = setTimeout(() => {
      runCheck(config.scheduleMode).catch(() => {});
      reschedule();
    }, delay);
    scheduleTimer.unref?.();
    const when = new Date(at).toLocaleString('zh-CN', { hour12: false });
    log(`next check: ${when} (mode=${config.scheduleMode})`);
  }

  // ---- Web API ----
  function sendJson(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 64 * 1024) { reject(new Error('body too large')); req.destroy(); } });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  async function installedPluginNames() {
    try {
      const bundles = await ctx.pluginManager.listBundles();
      return (bundles ?? [])
        .filter((b) => b?.installed)
        .map((b) => ({ name: b.name, version: b.version ?? null, removable: !!b?.removable }));
    } catch { return []; }
  }

  /** 最近活动日志（history.jsonl 尾部，供前端展示） */
  async function recentLogs(limit = 50) {
    try {
      const raw = await readFile(historyPath, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      return lines.slice(-limit).map((l) => {
        try { return JSON.parse(l); } catch { return { at: null, raw: l }; }
      });
    } catch { return []; }
  }

  if (ctx.webServer?.register) {
    try {
      const disposeStatus = ctx.webServer.register({
        kind: 'exact',
        path: '/api/autoupdater/status',
        handler: async (_req, res) => {
          // 诊断：列出每个 agent 的实际状态，定位"恒 running"的来源
          let agentsDetail = null;
          try {
            agentsDetail = (ctx.agents?.list?.() ?? []).map((a) => ({
              id: a.sessionId ?? a.id ?? '?',
              status: a.status,
              kind: a.kind ?? undefined,
            }));
          } catch {}
          sendJson(res, 200, {
            ...state,
            nextRunAt: nextRunAt(config),
            idleForSeconds: idleFor(),
            anyAgentRunning: anyAgentRunning(),
            agentsDetail,
            harnessNotice,
            pendingStaged: existsSync(pendingPath),
            scheduleMode: config.scheduleMode,
            logs: await recentLogs(50),
          });
        },
      });
      if (typeof disposeStatus === 'function') disposers.push(disposeStatus);

      // GET 与 POST 同路径不同方法；webServer 路由不区分方法，这里合并处理
      const disposeConfig = ctx.webServer.register({
        kind: 'exact',
        path: '/api/autoupdater/config',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendJson(res, 200, {
              config,
              installed: await installedPluginNames(),
              nextRunAt: nextRunAt(config),
              running,
              ...state,
              logs: await recentLogs(50),
              idleForSeconds: idleFor(),
              anyAgentRunning: anyAgentRunning(),
              harnessNotice,
              pendingStaged: existsSync(pendingPath),
            });
            return;
          }
          if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return; }
          try {
            const body = await readBody(req);
            const prevMode = config.scheduleMode;
            const next = normalizeConfig({ ...config, ...(body ?? {}) });
            await mkdir(stateDir, { recursive: true });
            await writeFile(hotConfigPath, JSON.stringify(next, null, 2));
            config = next;
            reschedule(); // 新配置立即排程
            if (prevMode !== next.scheduleMode) log('schedule mode changed →', next.scheduleMode);
            sendJson(res, 200, { ok: true, config: next, nextRunAt: nextRunAt(next) });
          } catch (e) {
            sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
          }
        },
      });
      if (typeof disposeConfig === 'function') disposers.push(disposeConfig);

      // 手动触发一次检查（不绕过空闲门槛：runCheck 内部照常 waitIdle）
      const disposeRun = ctx.webServer.register({
        kind: 'exact',
        path: '/api/autoupdater/run-now',
        handler: async (_req, res) => {
          if (running) { sendJson(res, 200, { ok: true, queued: false, reason: 'already-running' }); return; }
          runCheck('manual').catch(() => {});
          sendJson(res, 200, { ok: true, queued: true });
        },
      });
      if (typeof disposeRun === 'function') disposers.push(disposeRun);
    } catch (e) { log('route register failed:', e?.message); }
  }

  // ---- 启动 ----
  reloadHotConfig().then(() => {
    reschedule();
    graceTimer = setInterval(tick, 30000);
    graceTimer.unref?.();
  }).catch((e) => log('startup reload failed:', e?.message));

  // ---- 清理 ----
  return () => {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    if (graceTimer) clearInterval(graceTimer);
    for (const d of disposers) { try { d?.(); } catch {} }
  };
}
