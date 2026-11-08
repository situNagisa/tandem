# PR / CI 集成 · Windows 实机代测步骤

> 更新：2026-11-09。

Tandem 在 Host 机器上调用**本机已安装并登录**的 GitHub CLI（`gh`）或 GitLab CLI（`glab`）创建 / 查看 / 合并 PR 与读取 CI 失败日志；Tandem 不保存任何平台令牌，也不会把仓库地址写入日志或接口（只返回主机名）。开发环境在公司内网，未连接真实 GitHub，以下步骤请在可上公网的 Windows 机器上执行并回传结果。

## 前置

1. Windows 10/11，Tandem Host 与 Web 客户端已更新到包含本功能的版本。
2. 安装 GitHub CLI 并登录（在 Host 所在机器的 PowerShell 中）：

   ```powershell
   winget install --id GitHub.cli
   gh --version
   gh auth login
   gh auth status
   ```

   `gh auth status` 应显示 `Logged in to github.com account <你的用户名>`。Tandem 只读取布尔值与用户名。
3. 准备一个测试仓库（建议私有），并确保本地已有 `origin` 指向 GitHub：

   ```powershell
   git clone https://github.com/<你>/<测试仓库>.git
   cd <测试仓库>
   git checkout -b tandem-pr-test
   ```

4. 在 Tandem 中用该目录新建会话（或把已有会话 cwd 切到该目录）。

## 测试步骤与预期

### 1. 能力检测

- 打开会话，点右上角 **PR** 按钮。
- 预期：面板顶部显示当前分支、上游、远端平台（GitHub）、`gh` 用户名；仓库根目录路径正确。无 PR 时显示「创建 PR」表单。
- 若未安装 / 未登录 `gh`：面板显示安装命令（`winget install --id GitHub.cli` / `brew install gh`）、`gh auth login` 以及 GitHub CLI 官方文档链接；不会出现崩溃或空白面板。

### 2. 让 agent 起草（可选）

- 点「让 agent 起草」。
- 预期：自动向当前会话发送一条消息；回合结束后，标题与描述被填入表单（模型若未按 JSON 格式输出，会提示解析失败，不影响手填）。

### 3. 创建 PR

- 填写标题（或使用 agent 起草结果），点「创建 PR」。
- 预期：出现二次确认弹窗，明确写着「将推送分支 `tandem-pr-test` 到远程 `github.com`」。
- 点「推送并创建」。
- 预期：Host 执行 `git push -u origin HEAD`，再执行 `gh pr create`；成功后顶栏按钮变成 `#<编号>` + 状态点，面板显示 PR 标题、状态「开放」、审查状态与检查列表。
- 若分支无新提交：GitHub 仍可创建 PR；若 `gh` 报错（如已存在 PR），面板应显示 `gh` 的具体错误文本。

### 4. 观察 CI

- 在 PR 中触发一次 GitHub Actions（push 一个新提交即可）。
- 预期：面板「CI 检查」列出每个检查的名称、状态、耗时与详情链接；失败检查显示红色图标与「让 agent 修复」按钮。
- Host 每 60 秒轮询一次当前打开会话的 PR；状态变化时顶栏状态点、面板与收件箱会自动更新，无需手动刷新（也可点面板右上角刷新按钮立即拉取）。

### 5. 让 agent 修复失败检查

- 对一个失败检查点「让 agent 修复」。
- 预期：Host 执行 `gh run view <run-id> --log-failed`（日志过长会截断），把「CI 检查 X 失败 + 日志」作为一条**用户消息**发到当前会话，agent 开始分析并修改代码；界面提示「已把失败日志发给 agent」。
- 回传：聊天中该消息是否包含真实失败日志、agent 是否据此开始修复。

### 6. 合并

- 点面板中的「合并」，选择压缩合并 / 合并提交 / 变基合并。
- 预期：出现二次确认弹窗（写明合并方式与目标分支）；确认后执行 `gh pr merge --squash|--merge|--rebase`，成功后状态变为「已合并」，顶栏状态点变为已合并颜色。

### 7. 收件箱

- 保持会话打开，让 CI 从成功变为失败（或让 PR 被合并）。
- 预期：收件箱出现一条 PR/CI 事件（如「PR #12 CI 失败：build」「PR #12 已合并」），点击可回到会话。

### 8. 提交并创建 PR

- 打开「改动」审阅面板，填写提交信息，点提交按钮旁的 **⋯ → 提交并创建 PR**。
- 预期：先提交全部改动，再打开 PR 面板并预填该提交信息为标题；确认后完成推送与创建。

## 需要回传的内容

1. 每一步的截图（PR 面板：无 PR / 创建确认 / 检查列表 / 失败修复提示 / 已合并；顶栏按钮状态）。
2. `gh --version`、`gh auth status` 的脱敏输出（可隐去用户名）。
3. 失败时 Host 终端里 `[tandem]` 开头的报错（不要包含 token、API Key、完整私有仓库 URL）。
4. 指定回传：
   - 创建失败时 `gh pr create` 的完整 stderr；
   - 修复失败时 `gh run view <id> --log-failed` 是否返回日志、日志是否被截断；
   - 合并失败时 `gh pr merge` 的 stderr；
   - 收件箱是否收到 CI 事件、顶栏状态点是否在 60 秒内变化。

## 已知边界

- 仅支持 GitHub / GitLab；其他托管平台显示提示，不提供 PR 操作。
- 草稿 PR 的合并按钮不可用（需先在 GitHub 标记为可审阅）。
- PR 存在合并冲突时合并按钮禁用。
- 本地开发环境已用假 `gh` 脚本 + 本地 bare 仓库验证创建 PR、CI 失败展示、让 agent 修复消息、合并全流程；真实 GitHub API 行为需以上 Windows 代测确认。
