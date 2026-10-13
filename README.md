# dsh-autoupdater

**Auto-update plugin for DeepSeek Harness (DSH)** — 定时检查 DSH 本体与已安装插件的更新，只在无人使用的空闲窗口执行。四种调度模式、双向白名单、可视化设置面板。

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
dsh plugin --profile web add dsh-autoupdater
```

或从 GitHub：

```sh
dsh plugin --profile web add github:<owner>/dsh-autoupdater
```

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
- 未探测到 systemd → 按原 argv 脱离子进程拉起（兜底）
- npm 全局安装后校验 dsh 二进制存在，缺失则**放弃重启**（防变砖）

## 安全模型

- 默认 `harnessMode: notify`——只暂存并通知，重启动作需你显式改为 auto
- 空闲门槛不可绕过：面板不提供"忽略空闲"开关
- 更新前后均有磁盘版本校验，结果写入 `~/.dsh/autoupdater/history.jsonl`
- API 仅写本地 `config.json`，不触碰系统配置

## 已知限制

- 插件更新只覆盖声明 `dsh.bundle` 的 npm 形态插件；GitHub 源码安装的插件版本比对不适用
- 本体更新依赖 npm 全局安装形态（git checkout 形态请用 [dsh-updater](https://github.com/GodCC6/dsh-updater)）
- 空闲判定基于本机 `$DSH_HOME/sessions` 的文件 mtime，远程会话（SSH 场景）不计入

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

Install: `dsh plugin --profile web add dsh-autoupdater`, then restart DSH and configure under **Plugin Manager → dsh-autoupdater**.

See the Chinese sections above for full details — the configuration table and idle-detection notes apply to both languages.
