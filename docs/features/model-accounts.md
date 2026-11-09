# 账号与模型（设置）

> 更新：2026-11-09。用户决定见 [design.md 反馈包 #10](../design.md)；根因见 [feedback-ledger.md](../feedback-ledger.md) 的 R42/R43/R37。协议字段见 `packages/protocol/src/index.ts`。

设置 → 账号与模型（`components/settings/ProfilesSection.tsx`）。账号对应一个 Base URL，下面可有多个分组（各自协议与 Key），会话按所选分组运行。

## 编辑时保护 Key（反馈10#05 / R42）

- 已有 Key 的分组只显示掩码占位「已保存 · ••••abcd」和「更换 Key」按钮，**不再渲染可编辑的密码输入框**；点「更换 Key」才出现输入框（可取消）。
- 保存时 Key 未修改就不发送 `apiKey`；客户端也永远不会把掩码当明文回传。服务端 `ProfileStore.update` / `buildKeys` 对缺省、空字符串、看起来像掩码（含 `****` / `••••`）的 key 一律保留原值；删除 Key 必须走 Key 列表（展开账号 → Key 面板删除）。
- Key 列表按 `id` 保留未重传的 `apiKey`，重排、停用、改标签不会丢 Key。Secrets 编辑的值默认为空、留空不改；MCP 的环境变量由 Host 原样返回，编辑不会丢。

## 拉取模型默认只勾选最新一代（反馈10#04 / R43）

- 「自动拉取模型」后按厂商/系列解析模型名：去掉日期快照（`YYYYMMDD` / `YYYY-MM-DD`），把字母部分作为系列、数字部分作为版本。同系列取版本号最大的一代；同版本同时有别名与日期快照时取别名，两个快照取日期更新的；完全判断不出系列/版本（如 `deepseek-chat`）的默认不勾选。
- 用户手动勾选/取消过之后再次拉取：保留原来的选择，只对本次新出现的模型应用「最新一代」规则。没手动改过时，再次拉取会按规则重新收敛。
- 实现：`packages/web/src/lib/modelSelection.ts`（`identifyModel` / `isNewerModel` / `selectLatestModels` / `mergeFetchedSelection`），单测 `modelSelection.test.ts` 覆盖截图里的 claude 系列、别名优先、快照排序与合并规则。

## 下拉与候选列表（反馈10#06 / R37、R01）

- 所有下拉都走 `ui/MenuSelect`（设置里的 `Controls.Select` 也是它的包装）；可输入 + 候选的模型 ID 输入走 `ui/Combobox`（单价覆盖、预算按模型），不再使用浏览器自带 `<datalist>` / `input list=`。
- `scripts/ui-audit.mjs` 新增 `native-datalist`、`native-input-list`，与既有的 `native-select` 一样在 `ui/` 以外直接失败，不设白名单例外。

## 验证

- 单测：`packages/server/test/profile-keys.test.ts`（空值/掩码不覆盖、Key 列表按 id 保留、老账号账号级 Key）、`packages/web/src/lib/modelSelection.test.ts`。
- 回归：`e2e/regression.mjs`「账号编辑：Key 掩码不回传、拉取模型只选最新、无原生下拉」；「菜单行文字行高不被裁切」。
- 全量：`node scripts/check.mjs`。
