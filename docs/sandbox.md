# 命令沙箱与网络白名单

> 目标：给 agent 执行的 Bash 命令和文件写入加一层分级保护，越界操作转审批；
> 在有条件时用操作系统沙箱做真正的隔离。设置入口：设置 → 权限 → 命令沙箱。

## 1. 写入保护（所有平台）

默认只允许写：

- 会话当前工作目录（`cwd`）；
- 该会话的 git worktree 目录；
- 系统临时目录（`os.tmpdir()`；Linux 另有 `/tmp`、`/var/tmp`，macOS 的 `/private/tmp` 等）。

### 1.1 文件工具

`Write` / `Edit` 的目标路径在工作目录之外时，**即使处于 acceptEdits 模式、bypassPermissions 模式或已会话级 allow_always**，也会转审批。审批卡会显示「将写入工作目录之外：<路径>」。

以下路径属于**受保护路径**，任何写入都转审批（bypassPermissions 也不例外，且不能被 allow 规则绕过）：

- `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.tandem`、`~/.claude`、`~/.codex`；
- 系统目录：`/etc`、`/usr`、`/bin`、`/sbin`、`/boot`、`/dev`、`/proc`、`/sys`、`/var/lib` 等；macOS 的 `/System`、`/Library`、`/Applications`；Windows 的 `%SystemRoot%`、`Program Files`、`ProgramData`；
- 项目里的 `.git/hooks`；
- 文件名以 `.env` 开头的文件（`.env`、`.env.local`、`.envrc` 等）。

`«总是允许»` 对目录外写入会生成一条绝对路径规则（如 `Write /home/me/projects/other`），按目录前缀匹配；受保护路径不会生成规则。这条规则也能由审批策略学习自动建议，或手动在权限页填写。

### 1.2 Bash 静态分析

Bash 是任意程序，无法安全地静态求值。我们解析常见写入形式：

- 重定向：`>`、`>>`、`>|`、`&>`、`&>>`；
- `tee`、`cp`、`mv`、`rm`、`rmdir`、`mkdir`、`touch`、`truncate`、`chmod`、`chown`、`ln`、`install`、`rsync`、`dd of=`、`zip` / `unzip -d`、`tar -C` / `tar -cf`；
- `sed -i`；
- `git -C <dir>` 的写子命令（commit / checkout / reset / merge / pull / clone / worktree add…）；
- `cd <dir> && …`（后续相对路径按新目录解析）；
- 命令中的 `~`、`$HOME` / `${HOME}`。

任一会写路径在工作目录外时转审批；受保护路径优先。静态分析只能识别「看得懂」的形式：变量、通配符、命令替换、heredoc、`find -exec`、`xargs`、脚本/构建工具等会被标记为「无法判断」。

- 默认：无法判断的**不拦截**（避免误伤正常构建、测试）。
- 严格模式：无法判断的也转审批。开启后 `npm run build`、`node script.js`、`bash deploy.sh` 这类命令会频繁询问。

## 2. 网络白名单

Bash 中的常见联网命令会被静态识别：`curl`、`wget`、`git clone/fetch/pull/push/ls-remote`、`npm/pnpm/yarn install|publish`、`pip install`、`ssh`、`scp`、`sftp`、`nc`、`rsync`、`docker pull/push`、`cargo install`、`go get`、`gem install`、`brew install`、`apt install`、`gh` 等。

- 目标主机不在白名单时转审批，审批卡显示命中主机；
- 白名单默认含 `localhost`、`127.0.0.1`、`::1`、`*.localhost`（回环地址始终放行）；
- 支持域名精确匹配、`*.example.com`、IP、IPv4/IPv6 CIDR；
- `git fetch/push` 不写 URL 时，会读取本地 `.git/config` 的 remote URL 判断主机；
- 设置页提供 npm / PyPI / GitHub / crates.io / Go / Debian / Homebrew 官方源一键加入；
- 审批选择「总是允许」时，非白名单主机会加入网络白名单。

## 3. 真沙箱（可用时）

| 平台 | 引擎 | 文件系统隔离 | 断网 |
|---|---|---|---|
| Linux | bubblewrap (`bwrap`) | 只读挂载 `/`，可写挂载 cwd、worktree 与临时目录 | 支持 `--unshare-net` |
| macOS | `sandbox-exec` | 用 seatbelt profile 拒绝 `file-write*`，仅放行 cwd、worktree 与临时目录 | 不支持 |
| Windows | 无 | 仅静态检查 | 不支持 |

- 设置开关关闭或引擎不可用时，命令直接在本机执行，只做静态检查；
- Linux 断网策略开启后，联网命令在沙箱内会失败并转审批；在审批中允许会临时去掉 `--unshare-net` 只跑这一次；
- 安装 bubblewrap：`sudo apt install bubblewrap`（或其他发行版对应包名）。

## 4. 能防什么

- 模型/命令**误写**工作目录之外：例如顺手改 `~/.ssh/config`、`/etc/hosts`、别的项目；
- 意外覆盖 `.env`、项目 `.git/hooks`（可被用来执行任意代码）；
- 在 bypassPermissions 下仍然拦住对敏感路径、目录外路径的写入；
- 把「越界」从静默执行变成用户可见的审批；
- 非白名单网络访问（curl 外发数据、git push 到陌生仓库、scp 上传）；
- 在 bwrap/sandbox-exec 可用时，即使静态分析漏掉某种写法，真实文件系统隔离仍能阻止根目录/系统目录写入；
- 开启断网时，沙盒内所有网络系统调用失败（包括静态分析没识别的程序）。

## 5. 不能防什么

- **静态分析一定可以被绕过**：`python -c "...write..."`、`perl -e`、`find -exec`、`xargs`、编译产物、动态生成的路径、编码/混淆、shell 变量与命令替换等。默认非严格模式下这些不会拦截；
- **Shell 语义复杂**：函数、别名、`eval`、多行脚本、heredoc、子 shell、`exec`、后台进程、管道组合都可能让解析结果偏离真实行为；
- **非 Bash 的写入**：MCP 工具、`Task` 子代理的自定义工具、浏览器下载、Hook 脚本等不经过本层 Bash 分析；
- **只读挂载不等于机密保护**：bwrap 下命令仍能读取根目录（包括 `~/.ssh`）。这不是机密沙箱；
- **bwrap 不能限制本机已有权限能做的事**：如果以 root 运行，或内核未启用 user namespaces，隔离能力有限；WSL/容器内可能直接不可用；
- **网络白名单只是静态识别**：任意程序（Python/Node/编译二进制）可以自行发起连接；只有在 bwrap 断网时才是真正的网络隔离；
- **Windows 没有真沙箱**，只有静态检查；
- 沙箱不替代代码审阅：审批通过后，命令拥有当前用户权限。

## 6. 设置与持久化

- 设置文件：`~/.tandem/sandbox.json`（600 权限，原子写）；
- 权限规则仍在 `~/.tandem/permissions.json`；目录外写入规则支持绝对路径或 `~/目录`，按目录前缀匹配；
- 审批历史与建议仍在 `~/.tandem/approvals.jsonl`，危险路径不会被建议自动允许。
