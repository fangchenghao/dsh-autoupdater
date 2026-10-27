# dsh-autoupdater

**Auto-update plugin for DeepSeek Harness (DSH)** — 定时检查 DSH 本体与已安装插件的更新，只在无人使用的空闲窗口执行。四种调度模式、双向白名单、可视化设置面板。

> **社区维护分支**：这是 [niubi6668889595/dsh-autoupdater](https://github.com/niubi6668889595/dsh-autoupdater) 的 fork，主要修复 macOS / Windows 桌面版（Electron）插件更新失败的问题。上游 PR：[#1](https://github.com/niubi6668889595/dsh-autoupdater/pull/1)。
> npm 包名：`@fffangchenghao/dsh-autoupdater`；GitHub：`fangchenghao/dsh-autoupdater`。

English below · [English](#english)

## 功能

- **定时检查**：四种调度模式任选——每日 HH:MM / 每 N 小时（整点对齐）/ 每 N 天 / 每 N 分钟
- **空闲门槛**：会话日志 2 分钟无写入 + 无运行中 Agent 才动手；定时触发再叠加持续静默采样，绝不打断使用
- **插件批量更新**：遍历已安装插件，逐个对比 npm 最新版并升级（带 `包名@版本` 显式安装 + 磁盘回读验证，杜绝假更新）
- **双向白名单**：白名单内只提醒 / 白名单内自动升级，两种语义随你切换
- **DSH 本体更新**：三种策略——不管 / 只暂存+通知 / 通知后宽限自动重启（宽限期内任何会话活动即推迟）
- **Web 设置面板**：插件管理器内嵌卡片，改配置保存即生效（热配置，无需重启）
- **最近活动日志**：每次检查/更新/重启都有可读记录，面板内直接查看
- **防变砖检查**：本体更新后校验 dsh 二进制存在才重启，npm 中断不留半更新状态

## 安装

```sh
dsh plugin --profile web add @fffangchenghao/dsh-autoupdater
```

或从 GitHub：

```sh
dsh plugin --profile web add github:fangchenghao/dsh-autoupdater
```

> 用 scoped 包名是为了不和上游 `dsh-autoupdater` 抢注同名包；bundle id 仍是 `dsh-autoupdater`，配置与状态路径不变。
>
> Windows 桌面版更推荐直接在 **插件管理器 → 安装插件** 里填包名安装；装完重启 App。

安装后重启 DSH（systemd 环境：`sudo systemctl restart <你的dsh服务名>`），然后在 **插件管理器 → 自动更新** 卡片配置。

## 配置

面板可改全部配置并即时生效；以下为 `cordis.patch.yml` 初始值：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `scheduleMode` | `daily` | `daily` / `everyHours` / `everyDays` / `everyMinutes` |
| `dailyTime` | `"04:30"` | 每日 / 每 N 天模式的锚定时刻 |
| `everyHours` | `6` | 每 N 小时（整点对齐，1–168） |
| `everyDays` | `1` | 每 N 天（锚定 dailyTime，1–365） |
| `everyMinutes` | `60` | 每 N 分钟（1–10080） |
| `idleSeconds` | `300` | 判定无人使用的持续静默秒数 |
| `idleTimeoutMinutes` | `120` | 每次检查等待空闲的最长时间 |
| `harnessMode` | `notify` | `off` / `notify`（暂存+通知）/ `auto`（宽限后自动重启） |
| `graceMinutes` | `30` | auto 模式通知后的宽限分钟数 |
| `systemdUnit` | `""` | 重启用的 systemd 服务名；空 = 从 cgroup 自动探测 |
| `pluginMode` | `regexmode-ignore` | 白名单内只提醒其余自动 / 白名单内自动其余提醒 / 全自动 / 全提醒 / 关闭 |
| `whitelist` | `[]` | 插件包名列表，含义随 pluginMode |

## 空闲判定原理

1. **会话日志 mtime**：`$DSH_HOME/sessions` 下任意文件 2 分钟内无写入 = 无进行中的工作（借鉴 [dsh-self-upgrade](https://github.com/raomaiping-hash/dsh-self-upgrade)，比 `agent.status` 可靠——实测 turn 结束后 status 可能停留 `running`）
2. **定时触发**额外要求持续静默 `idleSeconds` 秒，双重采样防瞬时空档误判
3. **手动触发**（面板"立即检查"）只要求此刻无运行中会话——你主动点的，不再等静默
4. 探测失败保守当忙，宁可不更新也不冒险

## 本体更新的重启方式

- 配置了 `systemdUnit`（或自动探测到）→ `sudo -n systemctl restart <unit>`。**前置条件**：你的部署用户已配置该命令的 sudoers 免密，例如：

  ```
  youruser ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart your-dsh-service
  ```

  未配置免密时 sudo 会失败，日志里如实记录，插件不会反复重试
- 未探测到 systemd（含 macOS / Windows 桌面 App）→ 不做进程内重启，只把“待重启”写进本轮结果，下次启动生效
- npm 全局安装后校验 dsh 二进制存在，缺失则**放弃重启**（防变砖）

## 桌面 App（macOS / Windows）

桌面版的 DSH 运行在 Electron 里，与 `dsh web` 的 Linux 进程模型不同，本插件做了三处适配：

1. **插件换版**：桌面 App 的 `pluginManager` 会以 `already-installed` 拒绝替换 HMR 下的已装包，
   普通 `dsh` CLI 又拒绝 `desktop` 保留 profile。插件改用安装包自带的
   `dsh-desktop-host/lib/cli.js`（Electron `ELECTRON_RUN_AS_NODE=1`）执行
   `dsh plugin --profile desktop add <pkg>@<ver>`——这是桌面版唯一允许写 desktop profile 的入口。
2. **安装源**：换版命令默认先走 `registry.npmmirror.com`（与版本查询同一个源），失败再退回
   pnpm 默认源，避免 `registry.npmjs.org` 在国内链路上长时间 `CONNECT_TIMEOUT`。
3. **重启**：桌面 App 由 `electron-updater` 自己升级，插件不再检查/暂存 DSH 本体；插件换版后
   只标记“重启后生效”，不会从进程内部 relaunch（那会连带杀掉正在跑的会话）。

因此桌面版的工作方式是：**静默把插件换版到磁盘 → 面板提示重启 → 你下次打开 App 时生效**。

### Windows 支持（0.6.2+）

0.6.2 起 Windows 桌面版与 macOS 使用同一条换版路径，并修掉了 0.6.1 里的几处 Unix-only 假设：

- **空闲判定**不再调用 `find -newermt`（Windows 的 `find.exe` 是文本搜索，不支持这些参数，会让插件永远认为“忙”），改为纯 Node 递归扫描 `%DSH_HOME%\sessions`。目录不存在 = 没有会话 = 空闲；只有根目录不可读才保守当忙。
- **`dsh.cmd` 调用**：PATH / sibling 找到的 `.cmd` 经 `cmd.exe` 执行并正确加引号；超时用 `taskkill /T /F` 结束整棵进程树，避免留下 pnpm 子进程。
- **环境变量**：没有 `HOME` 时用 `homedir()`（Windows 的 `USERPROFILE`）；PATH 兼容 `Path` 键，并额外查找 `%APPDATA%\npm` / `%LOCALAPPDATA%\pnpm`。
- Windows 上不执行 DSH 本体更新（交给安装器/App 自带更新器），插件换版后同样只提示重启。
- **多 profile 选择**：优先使用桌面 App 注入的 `DSH_PROFILE_DIR` / `DSH_PROFILE`；桌面版在两者都缺失时默认 `desktop`，不会因为某个测试 profile 的 `node_modules` 更新时间更近而误选。

开发机是 macOS；Windows 分支是按 Node/Electron 的跨平台语义改的，并做了逻辑测试，但**尚未在真实 Windows 机器上端到端跑过**。如果 Windows 上仍失败，请把面板日志和 `%USERPROFILE%\.dsh\autoupdater\history.jsonl` 发到 GitHub issue。

### 上下文销毁修复（0.6.4）

Cordis 在插件热重载/卸载时会销毁插件上下文。0.6.1 的启动 Promise 可能在销毁后才执行 `reschedule()`，留下一个已失效上下文的定时器；次日 04:30 它会报 `cannot get required service "pluginManager" in inactive context`，而同一时间新实例的插件更新其实已经成功。0.6.4 用 `disposed` 标志在销毁后中止定时器和在途检查，并忽略这种过期上下文错误。

## 维护说明

- 上游项目：[niubi6668889595/dsh-autoupdater](https://github.com/niubi6668889595/dsh-autoupdater)（MIT）。
- 本分支新增：桌面版 CLI 换版、npmmirror 优先、跳过 `link:`/git 来源、只有真正升级成功才算“已应用”、Windows 空闲判定/.cmd 调用适配；完整差异见 git log。
- 发布渠道：npm `@fffangchenghao/dsh-autoupdater`，GitHub `fangchenghao/dsh-autoupdater`，tag `v0.6.4`。
- 与上游同步：把上游加为 remote，rebase/merge 到本分支后重新发版即可。

## 安全模型

- 默认 `harnessMode: notify`——只暂存并通知，重启动作需你显式改为 auto
- 空闲门槛不可绕过：面板不提供"忽略空闲"开关
- 更新前后均有磁盘版本校验，结果写入 `~/.dsh/autoupdater/history.jsonl`
- API 仅写本地 `config.json`，不触碰系统配置

## 已知限制

- 插件更新只覆盖声明 `dsh.bundle` 的 npm 形态插件；GitHub 源码安装的插件版本比对不适用
- 本体更新依赖 npm 全局安装形态（git checkout 形态请用 [dsh-updater](https://github.com/GodCC6/dsh-updater)；桌面 App 不参与本体更新，由 App 自带更新器负责）
- 空闲判定基于本机 `$DSH_HOME/sessions` 的文件 mtime，远程会话（SSH 场景）不计入
- Windows 原生环境尚未实机验证（0.6.2 已移除 Unix-only 依赖，仍建议先看面板日志确认 desktop CLI 路径）

## 致谢

设计借鉴了社区同类项目：[dsh-self-upgrade](https://github.com/raomaiping-hash/dsh-self-upgrade)（会话日志 mtime 空闲判定、防变砖校验）、[dsh-updater](https://github.com/GodCC6/dsh-updater)（保守失败语义）、[dsh-auto-update](https://github.com/a1113622001/dsh-auto-update)（stage + 退出后应用架构）。

## License

MIT

---

<a name="english"></a>
# dsh-autoupdater (English)

**Auto-update plugin for DeepSeek Harness (DSH)** — scheduled update checks for DSH itself and installed plugins, applied only in idle windows.

- **Four schedule modes**: daily HH:MM / every N hours (aligned to clock) / every N days / every N minutes
- **Idle gating**: session-log mtime quiet for 2 minutes + no running agents; scheduled runs additionally require sustained quiet with double sampling
- **Bulk plugin updates**: per-plugin npm version comparison with explicit `name@version` install and post-install disk verification (no phantom updates)
- **Bidirectional whitelist**: whitelist-notified-others-auto, or the reverse
- **Harness update strategies**: off / stage+notify (default) / notify then auto-restart after a grace period where any session activity defers it
- **Web settings panel** embedded in the plugin manager; hot-reload config — changes apply without restart
- **Activity log**: every check, update, and restart recorded and viewable in the panel
- **Brick protection**: verifies the dsh binary exists after npm install before restarting

Install: `dsh plugin --profile web add @fffangchenghao/dsh-autoupdater` (or `github:fangchenghao/dsh-autoupdater`), then restart DSH and configure under **Plugin Manager → dsh-autoupdater**.

**Windows (0.6.2+)**: the desktop path is shared with macOS. 0.6.2 removes the Unix `find` idle check, invokes `dsh.cmd` through `cmd.exe`, falls back to `homedir()` when `HOME` is absent, and leaves DSH core updates to the installer/app. Windows has not been tested end-to-end on a real machine yet; logs are welcome in GitHub issues.

See the Chinese sections above for full details — the configuration table and idle-detection notes apply to both languages.
