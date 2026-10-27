# Windows audit — host half (`main.js` 1195 lines, `apply-update.mjs` 235 lines)

Repo HEAD `232be3b` (v0.6.4), clean tree, read in full. No source file edited.

## 0. The `undefined\.dsh` path — located, but it is NOT in HEAD

The string-concatenated home path is real, but **it was deleted in `5c048c8` ("fix(windows): replace Unix-only idle scan and CLI assumptions", 2026-10-26)**. There is no `process.env.HOME` anywhere in `main.js` today (`Select-String` count: 0).

Historical source, `git show 5c048c8^:main.js` **lines 188-189**:

```js
188:  const home = process.env.DSH_HOME || `${process.env.HOME}/.dsh`;
189:  const stateDir = `${home}/autoupdater`;
```

That is the exact defect that created the stray directory: with `HOME` absent, `` `${undefined}/.dsh` `` becomes the *relative* path `undefined/.dsh`, so the write lands under the process CWD (the desktop Host runs with CWD = the profile dir) and Windows normalises `/` to `\` → `profiles\desktop\undefined\.dsh\autoupdater\status.json`.

Current code — `main.js:148-155` (the replacement), `main.js:262-266` (all state paths via `join`):

```js
148: function resolveDshHome(env = process.env) {
149:   const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME : '';
150:   if (raw.trim().length === 0) return join(homedir(), '.dsh');
...
262:   const stateDir = join(home, 'autoupdater');
263:   const statePath = join(stateDir, 'status.json');
```

**Proof the stray dir is stale, not a live bug:** the stray `status.json` was created `2026-10-27 06:30:13`, while the current plugin copy (`%DSH_HOME%\profiles\desktop\node_modules\@fffangchenghao\dsh-autoupdater`, version `0.6.3`) was installed `2026-10-27 10:53:39` — i.e. four hours *later*, and 0.6.3 already ships `resolveDshHome()`/`homedir()`. The live Host writes the correct `%USERPROFILE%\.dsh\autoupdater\status.json`. Action: delete the stray tree, do **not** re-patch home resolution.

## 1. POSIX assumptions in `main.js` with no `process.platform` branch of their own

All six are reachable only through already-guarded callers today; none throws on Windows as shipped. "Gate" names the only thing standing between the code and a Windows crash.

| # | Location | Gate | Severity if gate removed | Issue |
|---|----------|------|--------------------------|-------|
| H1 | `main.js:554-557` | `checkHarness` returns at `:731-735` | silent no-op (BROKEN) | POSIX npm-global package path |
| H2 | `main.js:559-566` | `try/catch` only (works) | COSMETIC | `/proc/self/cmdline` probe; different argv semantics on fallback |
| H3 | `main.js:673`, `main.js:711` | `:641-645` | BROKEN | argv flattened with `join(' ')`, re-split in apply-update |
| H4 | `main.js:604-617` | `:641-645` (+ darwin `unit === ''`) | BROKEN | `sudo -n systemctl restart <unit>` |
| H5 | `main.js:679` | `:641-645` | COSMETIC | `USER`/`LOGNAME`; Windows exports `USERNAME` |
| H6 | `main.js:680-687` | `:641-645` | BROKEN | `systemd-run --uid/--gid` transient unit |

**H1 — `main.js:554-557`** — no platform branch inside the function; its only caller is gated.

```js
554:   function harnessPkgPath() {
555:     const nodeDir = process.execPath.replace(/\/bin\/node$/, '');
556:     return `${nodeDir}/lib/node_modules/@deepseek-ai/dsh/package.json`;
557:   }
```

The regex matches only a POSIX `/bin/node`, so on `win32` it is a no-op and the string becomes `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe/lib/node_modules/...`; the Windows global root is `%APPDATA%\npm\node_modules` and the launcher is `dsh.cmd`. Failure mode is silent: `readJson()` → `null` → `log('cannot resolve @deepseek-ai/dsh version …')` and the harness check ends.
Fix: platform-specific root (`npm root -g` or `join(process.env.APPDATA,'npm','node_modules')` vs POSIX layout) built with `join()`.

**H2 — `main.js:559-566`** — only a `try/catch`, no platform branch.

```js
559:   function currentArgv() {
560:     try {
561:       return readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
562:     } catch {
564:       return process.argv.slice(1);
```

On Windows `/proc/...` resolves drive-relative to `C:\proc\self\cmdline` → `ENOENT` → caught, so no crash; but the two branches disagree on whether `argv[0]` is present (that is why `apply-update.mjs:166` tests `argv[1]`).

**H3 — `main.js:673` and `main.js:711`** — the lossy argv round-trip.

```js
673:       ['AUTOUPDATE_ARGV', currentArgv().join(' ')],
711:           AUTOUPDATE_ARGV: currentArgv().join(' '),
```

Consumed at `apply-update.mjs:165` by `.split(/\s+/)`: any path containing a space (for example `%LOCALAPPDATA%\Programs\DeepSeek Harness\...`) is torn apart. Fix: pass `JSON.stringify(argv)` and `JSON.parse` on the other side.

**H4 — `main.js:604-617`** — no platform branch; a `win32`/`darwin` spawn of `sudo` is guaranteed `ENOENT` (handled at `:610`, so it logs instead of throwing).

```js
606:     const r = spawn('sudo', ['-n', 'systemctl', 'restart', unit], { detached: true, stdio: 'ignore' });
```

The comment block at `:607-609` also encodes Linux `SIGTERM`/cgroup semantics that do not exist on Windows.

**H5 — `main.js:679`** — POSIX-only username variable.

```js
679:         const svcUser = process.env.USER || process.env.LOGNAME || 'ban';
```

**H6 — `main.js:680-687`** — Linux-only `systemd-run` invocation with `--uid`/`--gid` and `--setenv` pairs, spawned through `sudo` at `:687`.

```js
680:         const args = ['-n', 'systemd-run', '--unit=dsh-autoupdater-apply', '--collect',
683:           `--uid=${svcUser}`, `--gid=${svcUser}`,
687:         const r = spawn('sudo', args, { detached: true, stdio: 'ignore' });
```

## 1b. `apply-update.mjs` — zero `process.platform` references in the whole file

| # | Location | Severity on Windows | Issue |
|---|----------|--------------------|-------|
| A1 | `:39-42`, `:94` | BROKEN | POSIX global layout + `dsh`/`npm` shim names |
| A2 | `:75` | BROKEN | `spawnSync(npmBin, …)` — `.cmd` cannot be spawned without a shell |
| A3 | `:114-120` | BROKEN, destructive | external `grep`; ENOENT silently means "service missing" → rollback |
| A4 | `:152-163`, `:183-187` | BROKEN | `sudo`/`systemctl` |
| A5 | `:165-173` | BROKEN | whitespace argv re-split |
| A6 | file top (`:1`) | structural | no platform gate at all — protection lives only in `main.js:641-645` |

**A1 — `apply-update.mjs:39-42`**

```js
39: const prefix = dirname(nodeBin);
40: const dshBin = join(prefix, 'dsh');
41: const npmBin = join(prefix, 'npm');
42: const globalRoot = `${prefix}/../lib/node_modules/@deepseek-ai/dsh`;
```

On Windows these are `dsh.cmd`/`npm.cmd`, and globals live in `%APPDATA%\npm\node_modules`. Note the ordering hazard at `:85` (install) → `:94` (`existsSync(dshBin)` false → `FATAL: dsh binary missing` → `exit 1`): the package is replaced on disk and the process exits without restart.

**A2 — `apply-update.mjs:75`**

```js
75:     const r = spawnSync(npmBin, ['install', '-g', targetSpec], { encoding: 'utf8', timeout: 900000 });
```

Since the CVE-2024-27980 fix Node refuses `.cmd`/`.bat` without `{ shell: true }` (`EINVAL`), so the install reports failure with empty output.

**A3 — `apply-update.mjs:114-120`** (worst item in the file)

```js
115:     const nm = `${globalRoot}/node_modules/@deepseek-ai`;
117:     const r = spawnSync('grep', ['-rl', '--include=*.js', name, nm], { encoding: 'utf8' });
118:     return (r.stdout || '').trim() !== '';
119:   } catch { return true; }
```

`spawnSync` does **not** throw on `ENOENT` — it returns `{ status: null, error }` with `stdout: null`. So `catch { return true }` (the "assume present" net) never runs, the function returns `false` = "service missing", and `:127-137` rolls a healthy install back to the previous version. Same outcome wherever `grep` is absent or lacks `--include`.

**A4 — `apply-update.mjs:155` and `:184`**

```js
155:       const r = spawn('sudo', ['-n', 'systemctl', 'restart', unit], { stdio: 'ignore' });
184:       const r = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' });
```

Empty stdout means `st !== 'active'` forever → every health check fails → rollback of a good install.

**A5 — `apply-update.mjs:165-168`**

```js
165:   const argv = (process.env.AUTOUPDATE_ARGV || '').trim().split(/\s+/).filter(Boolean);
166:   if (argv.length >= 2 && existsSync(argv[1])) {
168:       const child = spawn(argv[1], argv.slice(2), { detached: true, stdio: 'ignore' });
```

Producer is `main.js:673`/`711`; paths with spaces break the fallback relaunch on Windows and macOS alike.

**A6** — `apply-update.mjs` contains no `process.platform` check (0 occurrences), no `sh -c`, no `bash`, no `chmod`, no `/tmp`, no `ps`/`pgrep`/`lsof`, no `sqlite3`. It also has **no shebang** (`:1` is a comment) and is started as `process.execPath` + script path (`main.js:686`, `:704-713`), so the *invocation* is portable; only the body is POSIX.

## 2. Existing `process.platform === 'win32'` branches — verdict per branch

| Location | Verdict |
|---|---|
| `main.js:193-197` `windowsShellCommand` | **Correct and complete.** `.cmd`/`.bat` routed through `cmd.exe` with `""` escaping; returns `null` for `.exe`/POSIX so the direct-spawn path keeps working. Residual (COSMETIC): `cmd` still expands `%VAR%`, but every argument is a package spec, version, profile name or registry URL. |
| `main.js:222-231` `killTree` | **Correct and complete.** `taskkill /pid <pid> /T /F` reaches the whole tree, which `child.kill()` cannot do for a `shell: true` child (`cmd.exe` wrapper); `stdio: 'ignore'` + `try/catch` prevents a throw. |
| `main.js:348-350` `binName = 'dsh.cmd'` | **Correct and complete** for Windows; the same `binName` is reused by the PATH scan at `:360`, so both probes use `.cmd`. |
| `main.js:353` `process.env.Path ?? process.env.PATH` | **Correct.** Windows env keys are case-insensitive in Node but the canonically-spelled key here is usually `Path`; the `??` chain covers both. |
| `main.js:355-358` `%APPDATA%\npm`, `%LOCALAPPDATA%\pnpm` | **Correct, slightly incomplete.** `%APPDATA%\npm` is the real global bin (verified: `dsh.cmd` exists there). `%LOCALAPPDATA%\pnpm` on this machine holds only `store\` — pnpm's global bin is configured elsewhere — so that probe never matches. Harmless, but it is dead code, not coverage. |
| `main.js:593` `detectSystemdUnit` | **Correct and complete.** `if (process.platform !== 'linux') return '';` runs before any `/proc` read. |
| `main.js:641-645` win32 → `restart-required` | **Correct and complete — and load-bearing.** It is the *only* thing preventing H3-H6 and every `apply-update.mjs` finding (A1-A5) from executing on Windows. Do not relax it without replacing `apply-update.mjs` wholesale. |
| `main.js:731-735` win32 → skip harness check | **Correct and complete.** Returns before `harnessPkgPath()` (H1) is ever called, which is why H1 is latent rather than active. |

Missing branch (not a bug today, a structural gap): there is no `win32` short-circuit at the top of `apply-update.mjs`; if the file is ever launched by hand on Windows it runs the full POSIX sequence.

## 3. The one defect to fix first after the client.js crash

**`apply-update.mjs:114-120` (the `grep` service precheck).** It is the only remaining POSIX assumption in the repo whose failure mode is *destructive*: a missing `grep` does not raise — `spawnSync` swallows ENOENT — so the precheck reports every `ctx.<service>` reference as missing and `:127-137` downgrades a perfectly good DSH install to the previous version, then exits 1.

Why it matters to a Windows user specifically: today the `win32` return at `main.js:641-645` hides it, but that guard is exactly what the first Windows "enable host updates" request will remove — and the moment it is removed, that user's first self-update silently rolls itself back, with the only trace being `PRECHECK FAILED: … 找不到服务 …` in `%DSH_HOME%\autoupdater\apply.log`. The fix is three lines (treat `r.error != null || r.status == null` as "assume present", or replace the shell-out with the pure-Node directory scan already used at `main.js:162-186`), and it removes the only path in this repo that can un-install a working version on a machine it cannot fully inspect.

Second in line: `main.js:554-557` (`harnessPkgPath()`), because it is the piece a Windows harness-check would need and it currently returns a nonsense path silently.
