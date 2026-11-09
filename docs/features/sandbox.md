# 命令沙箱与网络白名单

> 更新：2026-11-10。给 agent 的 Bash 与文件写入加分级保护，越界转审批；有条件时用 OS 沙箱隔离。设置入口：设置 → 权限 → 命令沙箱。

## 写入保护（所有平台）

默认只允许写：会话 cwd、该会话的 git worktree、系统临时目录（`os.tmpdir()` 等）。

- 文件工具 `Write`/`Edit` 目标在 cwd 外时，即使 acceptEdits、bypassPermissions 或会话级 allow_always，也转审批，卡上显示「将写入工作目录之外：<路径>」。
- **受保护路径**任何写入都转审批，且不能被 allow 规则绕过：`~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.tandem`、`~/.claude`、`~/.codex`（`~/.tandem/worktrees|checkpoints` 除外）、系统目录（`/etc`、`/usr`、`/bin`、`/sbin`、`/boot`、`/dev`、`/proc`、`/sys`、`/var/lib`；macOS `/System|/Library|/Applications`；Windows `%SystemRoot%`、`Program Files`、`ProgramData`）、项目 `.git/hooks`、`.env*`。
- 「总是允许」对目录外写入生成绝对路径/`~/目录` 规则，按前缀匹配；受保护路径不生成规则。

## Bash 静态分析

解析常见写入：重定向 `>`/`>>`/`&>`；`tee/cp/mv/rm/rmdir/mkdir/touch/truncate/chmod/chown/ln/install/rsync/dd of=/zip/unzip -d/tar -C|-cf`；`sed -i`；`git -C <dir>` 写子命令；`cd <dir> && …`；`~`/`$HOME`。任一会写路径在 cwd 外转审批，受保护路径优先。

静态分析只能识别「看得懂」的形式；变量、通配符、命令替换、heredoc、`find -exec`、`xargs`、脚本/构建工具标为「无法判断」。默认不拦截无法判断的命令（避免误伤构建/测试）；严格模式下也转审批（会频繁询问）。

## 网络白名单

识别 `curl/wget`、`git clone/fetch/pull/push/ls-remote`、`npm/pnpm/yarn install|publish`、`pip install`、`ssh/scp/sftp/nc/rsync`、`docker pull/push`、`cargo install`、`go get`、`gem install`、`brew install`、`apt install`、`gh` 等。目标不在白名单转审批并显示主机；默认放行回环；支持精确域名、`*.example.com`、IP、CIDR；`git fetch/push` 无 URL 时读 `.git/config`；设置页可一键加 npm/PyPI/GitHub/crates.io/Go/Debian/Homebrew 官方源；「总是允许」把非白名单主机加入白名单。

## 真沙箱（可用时）

| 平台 | 引擎 | 文件系统隔离 | 断网 |
|---|---|---|---|
| Linux | bubblewrap (`bwrap`) | 只读 `/`，可写 cwd/worktree/临时目录 | `--unshare-net` |
| macOS | `sandbox-exec` | 拒绝 `file-write*`，仅放行 cwd/worktree/临时 | 不支持 |
| Windows | 无 | 仅静态检查 | 不支持 |

开关关闭或引擎不可用时直接本机执行，只做静态检查。Linux 断网开启后联网命令在沙箱内失败并转审批；审批允许只本次去掉 `--unshare-net`。安装 bubblewrap：`sudo apt install bubblewrap`（或对应包名）。

## 能防 / 不能防

能防：误写 cwd 外（`~/.ssh/config`、`/etc/hosts`、别的项目）；覆盖 `.env`、`.git/hooks`；bypassPermissions 下仍拦敏感/目录外写入；把越界变成可见审批；非白名单网络访问；bwrap/sandbox-exec 下的真实文件系统隔离；断网时所有网络系统调用失败。

不能防：静态分析一定可绕过（`python -c`、`perl -e`、`find -exec`、编译产物、混淆、变量/命令替换）；Shell 语义复杂（函数、别名、eval、多行、heredoc、子 shell、管道）；MCP/自定义工具/浏览器下载/Hook 不经过本层；只读挂载仍可读 `~/.ssh`；root/无 user namespace/WSL 容器内隔离有限；Windows 无真沙箱；网络白名单只是静态识别；审批通过后命令拥有当前用户权限，不替代代码审阅。

## 设置与持久化

`~/.tandem/sandbox.json`（600、原子写）；权限规则在 `~/.tandem/permissions.json`；审批历史/建议在 `~/.tandem/approvals.jsonl`，危险路径不会被建议自动允许。

## 审批卡

审批是对话流里的一条消息，样式与快捷键见 [conversation.md](conversation.md) 的「审批请求内联」；沙箱只负责把越界操作送进审批，不改变审批卡样式。
