# dsh-extra-prompt

把 [Deeptop](../DSH-Desktop) 的五个 Cordis 插件合并过来，补上 MCP 接入与 Skill 管理，做成一个可直接装进 DSH 的插件包，并为它们提供一个 Web UI 设置页面：

| 能力 | 作用 |
| --- | --- |
| 全局提示词注入 | 在每个 Session step 之前注入一段固定上下文 |
| 子代理路由 | 把「什么任务交给哪个 provider/model」写进系统提示，并附上使用说明 |
| Skill 编写指导 | 注册 `skill-create` 指导 Skill，可整体替换正文 |
| Skill 安装 | 提供 `skill-install` 工具，从 git 或压缩包安装 Skill 到当前 profile |
| rtk 输出压缩 | 对 `git status` / `git diff` / `git log` / `rg` / `grep` 的输出做压缩 |
| MCP 服务器 | 每台服务器组合一个官方 `dsh-mcp-client` 实例，它的工具以 `mcp__<服务器名>__<工具名>` 交给模型 |
| 统计看板 | 迁移自 Deeptop 的高密度多维看板：Token 环形图、时序脉冲、耗时追踪与命令重做归因 |

设置页另有一张不属于任何配置命名空间的卡片：**已安装的 Skills**，用来列出并卸载本包装过的 Skill（数据来自一个 `/api` 路由，见下）。

移植时只保留宿主侧逻辑，Deeptop 私有的 UI 运行时（`deeptopUiRegistry`、`deeptop-plugin://` 协议、`*-ui` 适配层、主题与语言 shim）没有移植——DSH 有官方的 slot 系统，本包用的是官方那套。

## 行与设置命名空间

DSH 用「profile 里的一行插件的 `id`」同时作为它的设置命名空间，因此本包的六个功能行 id、插件名和设置命名空间是一一对应的：

| profile 行 id | 挂载的包内路径 | Cordis `inject` | 设置页卡片 |
| --- | --- | --- | --- |
| `extra-prompt` | `dsh-extra-prompt`（裸包名） | 无 | 无（仅用于承载浏览器半边，见下） |
| `extra-prompt-injection` | `dsh-extra-prompt/prompt-injection` | 无 | 全局提示词注入 |
| `extra-subagent-routing` | `dsh-extra-prompt/subagent-routing` | `settings`、`systemPrompt` | 子代理路由 |
| `extra-skill-guide` | `dsh-extra-prompt/skill-guide` | `skills` | Skill 编写指导 |
| `extra-skill-installer` | `dsh-extra-prompt/skill-installer` | `tools` | Skill 安装 |
| `extra-rtk-compact` | `dsh-extra-prompt/rtk-compact` | `subprocess`、`timer` | rtk 输出压缩 |
| `extra-mcp` | `dsh-extra-prompt/mcp` | `tools` | MCP 服务器 |
| `extra-settings-api` | `dsh-extra-prompt/settings-api` | `connection` | 无（页面数据通道） |

三点必须一起成立，否则设置页看不到对应卡片：

1. 第一行必须从**裸包名**挂载。浏览器的插件模块表按包名索引，`client-modules` 只会把浏览器半边挂到「specifier 就是裸包名」的那一行；从子路径导出的行不会带上浏览器半边。
2. 六个功能行必须**各自独立**，因为它们的 `inject` 集合互不相同，一个插件无法同时满足。最后一行同样独立：`inject: ['connection']` 在没有 Web 传输的宿主上永远不会落定，不能让它拖住任何功能行。
3. 每个可编辑字段都标了 `.volatile()`。DSH 只把 volatile 字段投影给设置页，非 volatile 字段既不出现在表单里，也不接受热更新。

## 安装

### 安装到 profile

```sh
dsh plugin --profile <profile> add <包目录或包名>
```

pnpm 会把本目录以 `link:` 形式装进 profile；`dsh` 因为 `package.json` 声明了 `dsh.bundle.patch`，把 `dsh-extra-prompt` 追加进该 profile 的 `dsh.profile.bundles`，`cordis.patch.yml` 里的八行随后自动生效。

`--profile desktop` 会被拒绝：desktop profile 由 Electron 应用独占管理（`error: profile "desktop" is managed exclusively by the Electron application`）。要改桌面端，用应用内的插件页面，或直接编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` 与 `package.json`。开发请在自定义 profile 里做：

```sh
dsh --profile dev --from-default-profile web
```

### 为什么不能只按绝对路径挂载

DSH 给 Node 的 ESM/CJS 解析器装了一层拦截（`packages/boot/app-boot/src/profile-resolution/resolver.ts`），用来把插件 import 的宿主包路由到运行中的副本。这层拦截只对两类模块生效：位于 profiles 目录树内的，或已注册为 linked root 的。

本包的六个宿主入口都 import `@deepseek-ai/schemastery`（`prompt-injection` 另加 `dsh-llm`，`skill-installer` 另加 `dsh-tools`，`mcp` 另加 `dsh-mcp-client`）。这些包是 vendored 且 `private: true`，不在 npm 上，只能靠这层拦截拿到宿主自带的副本。而 `D:/Code/dsh-extra-prompt` 两者都不是：指向目录本身先撞 `ERR_UNSUPPORTED_DIR_IMPORT`，指向具体文件则 `ERR_MODULE_NOT_FOUND`。

所以 `package.json` 把这四个宿主包同时声明在 `peerDependencies` 和 `devDependencies`。linked root 的解析会在导入者的祖先目录里读它自己的 `peerDependencies`（`routeLinked` 里的 `readPeerNames`），命中即路由到宿主副本。DSH 只按名字匹配、不校验版本区间，因此这里写 `*`——这也让本包不受 `vendor/`（0.1.7-rc.2）与已安装桌面端（0.2.0-rc.2）之间的版本漂移影响。`dsh-mcp-client` 虽然不在 profile 自己的 `node_modules` 里，但只要声明了这个名字就能解析到宿主副本：实测 `extra-mcp` 能组合出真实实例。

只 import Node 内置模块、完全不碰宿主包的纯 JS 插件不受这条限制，可以按路径挂载；`settings-api` 就是这种（它只 import 本包自己的模块），但它仍然和其余行放在同一个包里。

### 安装后自检

```sh
dsh --profile <profile> --dump-config   # 应出现 "# == dsh-extra-prompt" 层
dsh --profile <profile> --no-open        # 启动时不应有 "did not activate" 警告
```

启动后设置页出现，说明浏览器半边被发现：`__DSH_BOOT__` 里应有 `{"id":"dsh-extra-prompt","url":"plugins/??dsh-extra-prompt/client.js&rev=…"}` 一行。

## 设置页面

位置：**设置 → 提示词与技能**（`settings.section` 槽位，`order: 30`）。

界面全部由宿主自带的设置组件搭成——`@deepseek-ai/dsh-client-ui-primitives` 是 shell 的基线模块（`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`），所以可以直接 `require`，不需要 `dsh.client.external`：

| 用途 | 组件 |
| --- | --- |
| 卡片框架、只读提示、保存按钮 | `SettingsForm` |
| 单行文本、数字（`inputMode="numeric"`） | `SettingsValueField` |
| 布尔开关 | `Switch` |
| 「已自定义」徽章 | `Tag` |
| 路由行的添加 / 删除 | `Button` |
| 启用卡片的圆角开关按钮 | `Pill` |
| 功能分组的标签栏 | `SegmentedControl`（`role="tablist"`，页面持有选中项并把面板的 `id`/`aria-labelledby` 接回去） |
| 每个功能的用途气泡、ⓘ 图标 | `Tooltip` + `IconInfoOutlineRegular` |

`ui-primitives` 没有多行文本、枚举下拉和列表编辑器这三类原子，因此这三个控件由本包自己渲染。它们的样式规则逐条抄自宿主自己的 `settings-form/fields.module.css` 与 `ConfigField.module.css`，只使用 `--dsw-*` 设计令牌，并在 `apply` 时作为一张 `<style>` 注入一次——这样它们与旁边的官方字段共用同一套间距、边框和主题，而不是又一套自造外观。

### 启用卡片

页面顶部是一张启用卡片，每个功能一个圆角开关按钮（宿主的 `Pill`，点亮即启用），装在一个 `flex-wrap` 的容器里，所以**一行显示几个跟着可用宽度走**，不写死列数。按钮上带一个 ⓘ，悬停或聚焦时用宿主的 `Tooltip` 显示该功能的具体用途；点 ⓘ 不会切换开关（它会把点击拦在自己这里）。

关闭某个功能后，它自己的设置卡片就不再渲染——不是被折叠起来，而是根本不在树上。这个开关是**真实门控**，不是显示开关：关掉之后对应的宿主插件不再注册工具、不再注入内容、不再写 system prompt 段落、也不再改动模型目录。

行为：

- 每张卡片独立暂存改动。**只要有字段被编辑过，「保存」就可点**——判定依据是「这一层是否留下了覆盖」，而不是「值是否与已提交值不同」：一个与默认值相同的覆盖仍然是一个覆盖。只有被编辑过的字段会被提交。
- 翻动开关会**立即**显示/隐藏对应的设置卡片（按暂存值判断），不需要先保存启用卡片，两者不会互相锁死顺序。
- 字段被用户层覆盖时显示「已自定义」徽章和「恢复默认」；恢复默认提交的是 `unset`（空数字输入同理），让 schema 默认值重新生效。
- 草稿不合法时（数字低于 schema 下限、路由行缺 provider 或 model）保存被禁用并就地提示，而不是把无效值写进去或悄悄丢掉。
- 宿主拒写时草稿保留在本页，不会因为一次没有被接受的写入而丢掉用户输入。写入被接受后草稿清空，显示回落到宿主快照。
- 没有挂载到当前 profile 的行，它的开关按钮保持可见但禁用（灰掉），ⓘ 说明原因——这个功能存在，只是这一行没在这个 profile 里；直接隐藏会看起来像从没做过。
- 宿主只读时（`snapshot.writable !== true`）所有控件禁用，并提示改动不会写入磁盘。
- 保存会写进当前 profile 的 `cordis.patch.yml`（DSH 的配置编辑器负责），不是本包自己的文件。写入按读取到的 `revision` 做栅栏，落在过期版本上会被拒绝。


### 分组 Tab

卡片多了以后一页滚不完，所以启用卡片下面是宿主的 `SegmentedControl`：提示词 / 子代理路由 / 技能 / 输出压缩 / MCP / 统计看板，每组只渲染当前这一组的卡片或视图。某个分组的功能全部关掉后，它的标签页就不再出现（选中项回落到第一个还在的分组，而不是留一个空面板）；只剩一个分组时标签栏本身不渲染，因为一个分段切不了任何东西。**例外是「技能」组与「统计看板」组**：技能组始终保留「已安装的 Skills」管理卡片；统计看板作为全局分析工具始终常驻。

### 统计看板（Session Statistics Dashboard）

将 Deeptop 广受好评的会话性能与成本计量看板完全迁移并做了现代高密度重构。底层逻辑由纯函数模型 `src/session-dashboard/model.mjs` 支撑，前端使用纯 React + SVG + CSS 动效打造，信息密度极高且视觉现代精致。**支持双入口无缝查看**：

1. **会话内部看板（Conversation View Tab）**：
   - 注册在官方 `conversation.view` 槽位（`order: 20`，位于「对话」与「轨迹」标签页旁边）；
   - 在任何会话中直接点击顶部的 **「看板」** 标签，即可就地查看该会话的性能与成本明细，输入框保持吸底浮层联动；
2. **全局设置看板（Settings Tab）**：
   - 保留在「设置 → 提示词与技能」的 **「统计看板」** 分组中，提供跨会话下拉切换器，方便纵览全局历史会话；

- **核心特性**：
  - **会话选择与快速过滤**：顶部工具栏支持下拉切换当前环境中的任意活跃或历史会话，提供「全部轮次」与「最近 8 轮」的动态时间窗口切片，支持一键实时刷新数据。
  - **6 大核心 KPI 指标卡**：
    - **会话耗时**：端到端墙上时钟持续时长，以及首末事件起止绝对时刻；
    - **对话轮次 / 步骤**：总轮数与底层 Agent 实际执行的步数比率；
    - **消息吞吐**：用户发出提示与模型生成回复的条数对比；
    - **工具调用**：调用总量、执行成功率（百分比）与失败次数；
    - **Token 消耗总量**：总消耗及输入/输出 Token 拆分；
    - **KV 缓存命中率**：上下文缓存命中比例（%），以及 cacheRead / cacheWrite 的具体 Token 量。
  - **动态 SVG 环形图（Token 构成与缓存分布）**：精巧的甜甜圈图表直观展示输入、输出与深度思考推理（Reasoning）的所占弧度与色彩分段，附带平滑动画过渡。
  - **多段色彩耗时追踪轴（Timing Track）**：按比例切分模型推理生成耗时、工具外部执行耗时及其他编排调度开销，辅以首包延迟（TTFT）与解码吞吐速率（tok/s）。
  - **轮次健康度与损耗归因**：直观的微型色块状态条（正常完成、执行失败、任务取消、手动中断），直观揭示异常中止轮次、废弃执行步数、LLM 重试次数以及命令重做率。
  - **轮次执行脉冲时序（Activity Pulse）**：时序流中为每个交互轮次呈现持续耗时、关键行为脉冲点（用户、回复、工具、报错）与 Token 消耗比例条。
  - **工具性能与数据载荷开销表**：排行各工具调用频次、耗时、报错率，并配以微型进度条对比工具返回字符量（Payload Volume），一眼识别吞吐瓶颈。
  - **高频命令重做检测（Rework Detection）**：自动分析终端与脚本工具参数，揪出被反复重复调用的冗余命令。
  - **数据通道**：利用本插件的 `/api/extra-prompt` 数据网关（`dashboard/sessions` 和 `dashboard/data`）按需实时调取宿主 sessionQuery / events，不引入任何冗余第三方图表库，完全遵循 DSH 设计系统令牌（`--dsw-*`）。

### MCP 服务器

一台服务器一个编辑器：名称、传输方式（stdio / streamable-http）、启用开关、删除。名称同时是工具命名空间（工具以 `mcp__<名称>__<工具名>` 注册），所以必须全局唯一；重命名等于「删掉再添加」。stdio 只把声明的字段交给官方 `dsh-mcp-client`：启动命令、参数（每行一个）、工作目录、环境变量；streamable-http 传 URL 与请求头。高级设置里是调用超时、指令字节上限、启动失败是否致命，以及重连开关与三个退避参数。

- 新增的服务器默认**关闭**：stdio 服务器是在 Host 本机起子进程、不经过 Agent 沙箱，所以不该因为「加了但还没配完」就跑起来。
- 只有已启用的服务器会被组合，关掉的不占工具命名空间也不起进程；改动连接参数会重建那一个实例，只翻开关不会（宿主用的 `specKey` 忽略 `enabled`，它改变的是「在不在」，不是连接参数）。
- 卡片按宿主同一套规则做阻塞式校验（名称形状与唯一性、两种传输各自的必填项、环境变量/请求头名是否合法、数值上下界、最多 64 台），不合规不允许保存，错误逐条挂在对应的服务器下面。这套规则在宿主（`src/mcp/model.mjs`）和浏览器半边各写了一份——产物是 classic script，没法 import 宿主模块——由测试逐例比对两边答案一致。
- **环境变量与请求头的值以明文保存在 profile 的 `cordis.patch.yml` 里**，卡片上写明了这一点。官方 `mcp-client` 的配置只接受字面量（`env`/`headers` 都是 `Record<string,string>`），DeepSeek provider 那种「只存引用、每次请求再解析」的路径在这里不成立，何况 stdio 的 `env` 是起子进程时就定下的。所以本包不假装提供凭据引用，而是把明文这件事直接说出来。

### 已安装的 Skills

「技能」组里的第三张卡片，列出本插件安装到用户 Skills 目录（`$DSH_HOME/skills`）的 Skill，逐行给出名称、来源与 ref，并可卸载。

- 卸载必须能证明「这个目录确实是我装的」：安装时会在 Skill 目录里写一份受管标记（`.dsh-managed-skill.json`），其中的 `installationId` 每次安装随机生成；卸载时要求 profile 注册表里的记录与目录里的标记**同时**匹配，否则拒绝删除并说明原因。只有注册表记录、或者只有目录里手写的标记，都不构成删除授权。
- 删除目录先于删记录：中断最多留下一条「目录已不在」的记录，而不是一个没人跟踪的目录。
- 拒绝也是一种回答：宿主返回 `ok:false` 加原因，卡片把它显示出来并保留那一行，而不是把失败的卸载画成成功。

这张卡片的 Skill 数据不是配置、读不到任何命名空间里，所以走的是本包自己的 `/api` 路由 `POST /api/extra-prompt`（`{op:'skills/list'}` / `{op:'skills/remove'}`）。同一个路由还回答第二个问题 `{op:'rtk/status', rtkPath}`：这台机器上有没有 `rtk`（见 `extra-rtk-compact` 一节）。两个问题都是「页面读不到、只有宿主知道」的事实，而不是配置——这条路由从不写任何配置，所有设置写入仍然走 `configForms`。

**为什么不用 `connection.rpc.handle()` 建一条 JSON 通道**：那个方法内部会通过**调用方 context** 去取 `webServer`（`packages/client/connection/src/rpc-host.ts` 的 `register()` 写的是 `owner.webServer.register(route)`），而属于「只声明了这个服务的插件」的 context 走不到那一步——它在 isolate 边界停下并抛 `cannot get property "webServer" without inject`，无论这一行 `inject` 里写什么（`['connection']`、`['connection','webServer']` 都试过）。`connection.fetch.register()` 不碰 `webServer`：它把路由登记进共享的 `/api` 表，由 Connection 自己的 `/api` 路由在受信主机检查与浏览器会话认证**之后**转发，因此这条路由是普通的同源已认证 POST，浏览器半边用 `fetch` 带 cookie 调它。实测 `POST /api/extra-prompt {"op":"ping"}` 返回 `{"ok":true,"value":{"pong":true}}`。

### 这个页面为什么挂在 `settings.section`

DSH 里插件配置的**规范位置**是 Plugins 页的 `plugins.row.config`（键为 `<包名>#<行 id>`）或 `plugins.bundle.config`，而 `plugins.item` 那一条在 slot 契约里明确写着 "OCCUPIED by the official settings pages"。本包六行的行 id 恰好就是六个命名空间名，所以 `plugins.row.config` 能把每个功能各自变成一个官方外观的配置页。

本包选择 `settings.section`（设置侧栏的一个分区），因为一行一页会把五个功能打散到 Plugins 页的展开层级里；`settings.section` 是已声明的公共槽位，注册进它不需要上游改动。要改成规范位置的话，改动只在 `lib/client.js` 末尾的注册处加五个 `key: 'dsh-extra-prompt#<行 id>'` 的条目。

### 各命名空间的字段

六个命名空间都有一个 `enabled` 布尔字段（默认开），由顶部的启用卡片统一编辑，因此下表不再逐个列出。表内其余字段只在对应功能启用时才会显示。

**extra-prompt-injection**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `text` | 多行文本 | 空 |

**extra-subagent-routing**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `routes` | 数组，每项 `{ provider, model, note }` | `[]` |
| `guidance` | 多行文本 | 空（非空时整体替换自动生成的路由段落） |

**extra-skill-guide**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `customGuide` | 多行文本 | 空（非空时替换内置指导正文） |

**extra-skill-installer**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `defaultRef` | 文本 | `main` |
| `defaultMethod` | `auto` / `download` / `git` | `auto` |

**extra-rtk-compact**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `rtkPath` | 文本 | 空（空则在 `PATH` 上找 `rtk`） |
| `minBodyChars` | 数字 | `1200` |
| `timeoutMs` | 数字 | `20000` |
| `maxOutputBytes` | 数字 | `4194304` |
| `gitStatus` / `gitDiff` / `gitLog` / `rg` / `grep` | 开关 | 均为开 |

这个功能的开关是唯一一个**默认值取决于机器**的：设置页先问宿主有没有 `rtk` 可执行文件，问不到就在这台机器上默认关闭。理由是这一格的开关必须诚实——它点亮时代表输出真的会被压缩，而一台没装 `rtk` 的机器上它只能原样通过，和功能失效无法区分。

- 问不到或答不出来（宿主更旧、没有查找可执行文件的接缝）时不动默认值：一个答不上来的问题不应该把一个能用的功能关掉。
- 页面向宿主提问时会带上自己表单里的 `rtkPath`，因为用户手填的路径是宿主唯一不会去查找的那种情况。`rtkPath` 一变就重新问一次，这也是这一格里唯一能不重启就生效的修改。
- 开关仍然可以手动点亮。真正的关闭由配置文档决定（`enabled: false`，或点一次开关再保存），所以页面不会替用户写配置；而一旦文档里写下了 `enabled`，或把 `rtkPath` 指向了别处，就以文档为准——否则「读起来是关闭」的功能会连自己那张装着 `rtkPath` 的设置卡片一起藏起来，用户就再也改不回来了。
- 宿主在启用但找不到 `rtk` 时只记一条警告（`rtk-compact 已启用，但本机没有找到 rtk 可执行文件…`），而不是静默地逐条原样通过。
- **装完 rtk 要重启 DSH**：可执行文件是在进程启动时继承的 `PATH` 上解析的，包管理器（winget / scoop / cargo）把安装目录写进用户 `PATH` 之后，已经跑着的 Host 看不到它——页面会继续显示「本机没有找到 rtk」。重开 DSH 即可；不想重启就在这一格里把 `rtkPath` 直接填上，那条路径是逐字的，不经过 `PATH`。`rtk init` 与这个插件无关（见下）。
- rtk 不是 DSH 安装的东西，所以页面给出它的上游地址 [github.com/rtk-ai/rtk](https://github.com/rtk-ai/rtk)：这张功能的卡片在摘要下面写一行「仓库：…」，而在这台机器没装 rtk 时，启用卡片也会在开关下面补一行同样的链接。链接是普通的 `<a target="_blank" rel="noopener noreferrer">`，和官方 `ui-settings-account` 的 `AccountSection` 一样（那个包也没有可复用的链接组件，`ui-primitives` 只导出图标）。气泡里放不下可点击的地址，所以「为什么是关的」在 ⓘ 上，「去哪里装」在卡片上。
- **不需要 `rtk init`**：`init` 是给 Claude Code / Cursor / Windsurf / Cline 这类助手 CLI 装 hooks 与 `CLAUDE.md`（或 `RTK.md`）指令文件的（`rtk init --agent <claude|cursor|…>`，`-g` 写全局、不加写当前目录），作用是让**它们自己的** bash 调用绕道 rtk。本插件自己匹配命令、自己把工具结果喂给 `rtk pipe -f <filter>`，不读任何 rtk 全局配置，所以 `rtk init` 成不成功都与本功能无关。实测在一个全新安装、从未 `init` 过的 rtk 0.50.0 上，`git-status` / `git-diff` / `git-log` / `grep` / `rg` 五个过滤器全部存在且退出码为 0。

**extra-mcp**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `servers` | 服务器列表（每项自带 `enabled`，见「MCP 服务器」一节） | `[]` |

这一格不是单个控件而是列表编辑器：每个条目自成一个 `dsh-mcp-client` 实例，字段与官方 `mcp-client` 的 `Config` 一一对应，本包只负责把它编辑并组合起来。

启用卡片是页面级的开关；插件管理里整行 `disabled` 是更粗的那一级——两者都能停用一个功能，前者不用重启，后者连插件都不加载。

## 为什么没有构建步骤

`lib/client.js` 是**手写**的浏览器产物，不是生成的。这是可行且经过验证的选择，不是走捷径：

- DSH 官方给 Cordis 插件开发者的模板（`packages/preset/agent-preset/skills/cordis-plugin-development/templates/decoration/`）同样是手写的四文件包，零构建、零依赖。
- 生成这种产物的 `clientBundle()` tsdown 预设只存在于 DSH 仓库内部的 `packages/client/tsdown.client.ts`，没有发布。官方的设置卡片指南（`docs/cookbook/adding-a-settings-card.md`）也明确要求仓库外的包自己复现这个构建。

代价是没有 JSX（只能用 `React.createElement`），以及产物是「lazy-CJS 工厂」形式的一段脚本：

```js
window.__ModuleLoader__.load({ id: 'dsh-extra-prompt', factory: (require) => { … } });
```

`id` 必须等于 `package.json` 的包名——模块表和 `/plugins/<id>/client.js` 路由都按包名索引。浏览器侧只有 8 个 baseline 模块可以直接 `require`，本包用其中两个：`react` 和 `@deepseek-ai/dsh-client-ui-primitives`（设置页组件，见下）。

宿主侧是纯 ESM（`"type": "module"`），八个入口都是函数插件（具名导出 `name` / `inject` / `Config` / `apply`，没有 default export）。本包没有任何 `dependencies`：`@deepseek-ai/schemastery`、`dsh-llm`、`dsh-tools` 由宿主的解析拦截层提供，因此只声明在 `peerDependencies` 与 `devDependencies`（原因见「为什么不能只按绝对路径挂载」）。插件本体放在 `src/<feature>/index.mjs`，纯逻辑放在同目录的 `model.mjs`（不 import 任何宿主 API），纯逻辑因此可以在 DSH 之外用 `node --test` 直接测。

## 与 DSH 惯例的有意偏离

1. **无条件注册 `settings.section`，而不是 `configForms.whileServed(...)`。** 这五个命名空间由本包自己的行提供，页面不可能指向别人的命名空间；把启用卡片和「此行没有挂载」的说明一起显示，比整页消失更好排查。
2. **订阅用 `React.useState` / `useEffect` 直接做，而不是渲染器的 `inject.hooks` 隔间。** 那个通道需要仓库内的框架钩子；`ConfigForm` 的 `getSnapshot()` / `subscribe()` 本身就是普通可观察对象，效果等价。若今后要上游化，这里应改成 hooks 隔间。
3. **UI 文案是硬编码中文，没有走 locale 字典。** 槽位标签的类型是 `SlotLabel = string | (() => string)`，字符串完全合法。若上游化，会被 `verify-client-ui-i18n` 拦下。
4. **五个插件都新增了 `enabled`，而且是真的门控。** 原 Deeptop 插件没有这个字段（停用靠整行 `disabled`，或者把配置清空）。加它是为了让设置页顶部那张启用卡片能用同一种方式开关五个功能。各处的实现不同：prompt-injection 复用它已有的「清空」路径，关闭时把已注入的内容连同一次说明一起撤回，而不是让旧文本无声地留在会话里；subagent-routing 关闭时不再产出段落，并把之前写进模型目录的说明收回；rtk-compact 在每条工具结果上读开关；skill-installer 和 skill-guide 用 dispose 后重新 register，把工具/Skill 真正从模型可见的列表里摘掉。`ctx.tools.register()` 返回 disposer，摘除后再注册是受支持的路径。
5. **三个控件是自绘的，不是宿主原子。** 多行文本、枚举下拉、路由列表编辑器在 `ui-primitives` 里没有对应导出（`ConfigField` 覆盖了前两者，但它是包内私有的，未从索引导出）。它们的样式逐条复刻宿主自己的字段 CSS 并只用 `--dsw-*` 令牌，外层仍复用官方的标签行、覆盖徽章与恢复按钮，所以视觉上与官方字段一致。
6. **启用卡片一次保存跨六个命名空间。** 一张卡片要写六个文档，所以它的暂存值放在页面组件上，提交时逐个命名空间顺序写入（宿主按 `revision` 做栅栏，逐个写才不会互相踩）。任何一次被拒都会保留全部暂存并就地提示失败。
7. **MCP 是新增的，不是移植的。** Deeptop 的 MCP 在 `desktop-bridge/tool-config.mjs` 里，靠一个 JSON 配置文件加托管块标记，属于「不移植」的桌面桥接层；DSH 自己的 MCP 行则是手写在 `cordis.patch.yml` 里的字面量。本包把它改成在设置页编辑、由插件按条组合官方 `mcp-client` 实例，这是这一层唯一的新领域逻辑。
8. **页面数据通道用 `connection.fetch.register()`，不用 `connection.rpc.handle()`。** 原因见「已安装的 Skills」一节：后者在当前版本从插件 context 调用会抛 `webServer` 的 inject 错误。这是实测记录，不是偏好。
9. **「技能」组的标签页不随开关消失。** 它承载的已安装 Skill 卡片与任何功能开关无关，所以给分组加了 `always`；其余分组仍然遵循「功能全关就消失」。

## 与原 Deeptop 插件的差异

除上面五条外，从 `Deeptop/cordis/` 移植时还有这些差异，都记在这里以免被当成 bug：

**命名**：五个设置命名空间、六个行 id、受管 Skill 的注册表文件名（`extra-prompt-managed-skills.json`）与标记里的 `owner`（`extra-prompt`）都从 `deeptop-*` 改成了 `extra-*`。没有做数据迁移，因此一个已经跑过 Deeptop 的 `$DSH_HOME` 里：旧的注入设置不会被读到（首个 step 会多发一次「此前的注入已失效」的说明，之后自愈）；被 Deeptop 装过的 Skill 不在本包的注册表里。

**subagent-routing**：
- 本包**不写**官方的 `subagent-model-selection-settings`（哪条路由可选是 DSH 的策略，由官方「子代理」设置卡片负责；两个写入方会让两份清单悄悄分叉）。Deeptop 是由它的设置面板写这份文档的，所以这里的职责边界变了。
- 代价是「在本页配好路由，但官方白名单没勾选」会让模型拿到一个委派时会被拒的清单。因此设置页**只读**该命名空间并做交叉检查：对不上时在卡片上直接说明缺哪些路由、去哪里勾选。
- system prompt 的 section 名从 `deeptop:subagent-routing` 改成 `extra:subagent-routing`。该名字不进模型可见文本，只在 `order` 相同时影响同级排序。

**skill-installer**：
- 没有挂载 profile 时不再回退猜测 `$DSH_HOME/profiles/deeptop`，而是返回 `undefined` 并只发一条警告。DSH 自己的启动路径都会发布 `profileContext`，所以这只影响没有 profile 的宿主。
- `registered` 从硬编码 `true` 改成「是否真的写下了受管记录」。原实现会在无法注册时仍然告诉模型这个 Skill 已被托管、可自动卸载。
- `ref` / `method` 的参数说明改为指向本包的可配置默认值；「未获批准」的错误文案改为指向本设置页，而不是 Deeptop 的 Tools → Skills。

**rtk-compact**：原实现有一个 `positiveNumber()` 兜底，把任何非数字、非有限或 `≤ 0` 的值悄悄换回默认值，所以 `minBodyChars: 0` 等于 `1200`。本包改为在 schema 边界上校验（`.min(0)` / `.min(1)`），`0` 因此是一个合法且被尊重的显式选择，意思是「不设下限」。校验位置从运行期兜底移到了配置边界，这是 DSH 的惯例。

## 端到端验证情况

在一个自定义 profile 里实测（`dsh --profile extra-dev --from-default-profile web`，再 `dsh plugin --profile extra-dev add D:\Code\dsh-extra-prompt`）：

- `--dump-config` 出现 `# == dsh-extra-prompt` 层，八行 id 与 name 正确。
- 启动时没有 `did not activate` 警告，八行全部激活。
- `__DSH_BOOT__` 中出现 `{"id":"dsh-extra-prompt","url":"plugins/??dsh-extra-prompt/client.js&rev=…","inject":["@deepseek-ai/dsh-client-ui-settings"]}`，浏览器半边已被发现。
- 该 URL 返回 200，内容是 `__ModuleLoader__.load` 注册的产物，且包含 `settings.section` 注册；产物里 `require` 的两个模块都在 shell 的基线模块表内（已在实际安装的 0.2.0-rc.2 客户端产物中确认 `SettingsForm` / `SettingsValueField` / `Switch` 等导出存在）。

三条端到端检查（都在上面那个 profile 上跑，Host 未改动一行）：

- **MCP 组合**：在 profile 的 `cordis.patch.yml` 里给 `extra-mcp` 配一台 stdio 服务器，指向 `test/fixtures/mcp-probe-server.mjs`（一个零依赖、只实现 `initialize` / `tools/list` / `tools/call` 的 MCP 服务器，收到请求就写一行日志）。启动后日志出现 `initialize` → `notifications/initialized` → `tools/list`，说明配置文档被 `ctx.plugin()` 接受、`@deepseek-ai/dsh-mcp-client` 从 `peerDependencies` 解析成功、子进程真的起来了、握手完成并且工具已被发现。**只声明 `peerDependencies` 就够**这一点由此坐实。
- **页面数据通道**：`POST /api/extra-prompt {"op":"ping"}`（带浏览器会话 cookie）返回 `{"ok":true,"value":{"pong":true}}`；未知 `op` 与非法 JSON 都返回 400。未认证时同一条路径是 401，说明它落在 Connection 的认证与受信主机检查之后。
- **rtk 探测**：在没装 rtk 的这台机器上，`{"op":"rtk/status"}` 与 `{"op":"rtk/status","rtkPath":""}` 都返回 `{"available":false,"path":null,"source":"path"}`，与 `Get-Command rtk`（missing）一致；`rtkPath` 指向一个真实存在的可执行文件返回 `{"available":true,"path":"…","source":"configured"}`，指向一个目录返回 `false`，只给空白字符则退回到 `PATH` 查找（`source:"path"`）。
- **Skill 管理**：手工造两条注册表记录（一条目录里有匹配的受管标记，一条只有目录），`skills/list` 如实给出 `removable: true/false` 并带上原因；对第二条 `skills/remove` 返回 `ok:false` 且目录原封不动；对第一条返回 `ok:true`，目录与注册表记录同时消失，重新 `skills/list` 只剩那条删不掉的。

两条踩坑记录，写给未来的自己：

- **宿主侧的行改动不会热更新，必须重启 Host**（浏览器半边的产物会按 `rev` 重新取，宿主模块不会）。早期探测 `POST /extra-prompt/ping` 拿到 405 就是这个原因——路由那时根本没注册。
- **`connection.rpc.handle()` 从插件 context 调用必然失败**，报 `cannot get property "webServer" without inject`（详见「已安装的 Skills」一节）。改用它旁边的 `connection.fetch.register()` 即可。

**未验证**：设置页在真实浏览器里的渲染与保存往返（包括 Tab 切换、MCP 服务器编辑器、已安装 Skills 卡片的点击）。改动 `lib/client.js` 后请在 Web UI 里手动确认一次。

## 测试

```sh
npm test          # 等价于 node --test "test/**/*.test.mjs"
```

87 个用例，分两层：

- **宿主层（54）**：纯函数模型（提示词组装、rtk 过滤规则、路由说明渲染、指导正文解析、MCP 服务器文档的规范化/校验/`specOf`/`specKey`、目录说明的写入与收回）、安装器（真实临时目录，含「没有挂载 profile 时仍能安装但不记录来源」的路径）。
- **浏览器半边（33）**：在 `node:vm` 里执行真实的 `lib/client.js`，用一个最小 React 替身和一套按官方 prop 契约写的组件替身渲染，断言它注册到 `settings.section`、注册的命名空间与 `package.json` 导出一致、页头写的包名版本与 `package.json` 一致、样式只走 `--dsw-*` 令牌、渲染出所有声明的字段、启用卡片是每个功能一个圆角开关且每个都带用途气泡、Tab 分组与「功能全关就消失」（技能组例外）、翻开关会即时显示或隐藏对应功能的设置卡片、未挂载的行仍然出现但不可切换、保存只写被编辑过的字段并在被接受后清空草稿、宿主拒写时保留草稿、空数字走 `unset`、低于 schema 下限的数字与缺 provider/model 的路由行都会阻止保存、只读时禁用保存、子代理路由的白名单交叉检查（不一致时点名缺哪些路由、一致时不说话、命名空间未挂载时不猜、并且从不写那份文档）、MCP 卡片每条错误只说一次且只把同类控件并排，rtk 开关在问不到/答不出/答「没有」/文档已有答案这四种情况下的取值，以及 rtk 仓库链接在「没装」时出现在启用卡片、装了时只出现在 rtk 卡片里。

其中两条值得单独说：

- **MCP 规则是双份实现的，所以有一条逐例比对**：宿主 `src/mcp/model.mjs` 与浏览器半边各自判断同一份服务器文档，一个 20 行的表格逐例比较两边给出的「第几台、哪个字段」集合必须完全一致。写这条测试时它立刻抓到一处真实分歧（卡片在 `reconnect` 关闭时仍然管退避数字的上界，宿主不管），已按宿主行为修正。
- **已安装 Skill 卡片的测试用的是真实请求/响应契约**：`fetch` 替身记录每一次调用并回放脚本化的宿主响应，因此断言的是「发了什么请求」（同一个 `/api/extra-prompt`、`credentials: 'same-origin'`、`{op, directoryName, installationId}`），以及失败后那一行还在、错误文案来自宿主。

React 替身实现了依赖比较和 cleanup 的 `useEffect`（`useForm` 是在 effect 里刷新快照并订阅的，effect 不跑的话面板会停在首帧值，写入断言就没有意义），并在渲染后按 React 的顺序冲刷 effect、必要时再渲染一次。hook 单元既按位置、也按组件函数区分——同一个位置上换了组件（一个功能卡片和 Skill 管理卡片都可能是面板的第一个子节点）必须像 React 那样重新挂载，否则第二个组件会读到第一个的 state。设置组件替身复现的是宿主的 prop 契约（含保存按钮 `!dirty || invalid || saving` 的禁用规则），而不是它们的渲染与样式。

**不覆盖**：真实 React 语义、宿主组件的实际外观、以及经 `settings` Remote 的实时往返——这些需要浏览器。
