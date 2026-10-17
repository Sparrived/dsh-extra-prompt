# dsh-extra-prompt

把 [Deeptop](../DSH-Desktop) 的四个 Cordis 插件合并过来，补上 MCP 接入与 Skill 管理，做成一个可直接装进 DSH 的插件包。**每个功能是「插件」页里独立的一行**，开与关就是那一行的开关；设置页只编辑它们的配置：

| 能力 | 作用 | 行 id |
| --- | --- | --- |
| 全局提示词注入 | 在每个 Session step 之前注入一段固定上下文 | `extra-prompt-injection` |
| 子代理路由 | 把「什么任务交给哪个 provider/model」写进系统提示，并附上使用说明 | `extra-subagent-routing` |
| Skill 安装 | 提供 `skill-install` 工具，从 git 或压缩包安装 Skill 到当前 profile | `extra-skill-installer` |
| rtk 输出压缩 | 对 `git status` / `git diff` / `git log` / `rg` / `grep` 的输出做压缩 | `extra-rtk-compact` |
| MCP 服务器 | 每台服务器组合一个官方 `dsh-mcp-client` 实例，它的工具以 `mcp__<服务器名>__<工具名>` 交给模型 | `extra-mcp` |
| 会话看板 | 迁移自 Deeptop 的高密度多维看板：会话内标签页里的 Token 环形图、时序脉冲、耗时追踪与命令重做归因 | `extra-prompt`（与设置页同一个浏览器半边） |

设置页另有一张不属于任何配置命名空间的卡片：**模型可见的 Skills**。它列出模型当前真正能读取到的 Skill（工作区与用户级目录、自定义与内置目录、插件运行期 Skill），并允许卸载本包装过的那些（数据来自一个 `/api` 路由，见下）。

移植时只保留宿主侧逻辑，Deeptop 私有的 UI 运行时（`deeptopUiRegistry`、`deeptop-plugin://` 协议、`*-ui` 适配层、主题与语言 shim）没有移植——DSH 有官方的 slot 系统，本包用的是官方那套。

## 行与设置命名空间

DSH 用「profile 里的一行插件的 `id`」同时作为它的设置命名空间，因此本包的功能行 id、插件名和设置命名空间是一一对应的：

| profile 行 id | 挂载的包内路径 | Cordis `inject` | 设置页卡片 | 行显示元数据 |
| --- | --- | --- | --- | --- |
| `extra-prompt` | `dsh-extra-prompt`（裸包名） | 无 | 无（承载浏览器半边：设置页 + 看板） | 根 `package.json` + `locale/{en,zh}.json` |
| `extra-prompt-injection` | `dsh-extra-prompt/prompt-injection` | 无 | 全局提示词注入 | `src/prompt-injection/` |
| `extra-subagent-routing` | `dsh-extra-prompt/subagent-routing` | `settings`、`systemPrompt` | 子代理路由 | `src/subagent-routing/` |
| `extra-skill-installer` | `dsh-extra-prompt/skill-installer` | `tools` | Skill 安装 | `src/skill-installer/` |
| `extra-rtk-compact` | `dsh-extra-prompt/rtk-compact` | `subprocess`、`timer` | rtk 输出压缩 | `src/rtk-compact/` |
| `extra-mcp` | `dsh-extra-prompt/mcp` | `tools` | MCP 服务器 | `src/mcp/` |
| `extra-settings-api` | `dsh-extra-prompt/settings-api` | `connection` | 无（页面数据通道） | `src/settings-api/` |
| `extra-web-search-tavily` | `dsh-extra-prompt/web-search-tavily` | `web` | 无（注册搜索源） | `src/web-search-tavily/` |

三点必须一起成立，否则设置页看不到对应卡片：

1. 第一行必须从**裸包名**挂载。浏览器的插件模块表按包名索引，`client-modules` 只会把浏览器半边挂到「specifier 就是裸包名」的那一行；从子路径导出的行不会带上浏览器半边。
2. 五个功能行必须**各自独立**，因为它们的 `inject` 集合互不相同，一个插件无法同时满足。最后两行同样独立：`inject: ['connection']` 在没有 Web 传输的宿主上永远不会落定，不能让它拖住任何功能行。
3. 每个可编辑字段都标了 `.volatile()`。DSH 只把 volatile 字段投影给设置页，非 volatile 字段既不出现在表单里，也不接受热更新。

### 一行一个开关

没有任何一行的 `Config` 里还有 `enabled` 字段。「插件」页上那一行的开关就是这个功能的开关：关掉时**插件管理页会把 `disabled: true` 写进 profile patch**（`~/.dsh/profiles/<profile>/cordis.patch.yml`），加载器随即将该行的 fiber 卸载，它注册的工具、注入的内容、system prompt 段落、以及写进模型目录的说明一起消失——是真门控，不是显示开关。这条路径不在本包里：`@deepseek-ai/dsh-client-ui-plugin-manager` 的 `setPluginEnabled` 按 profile patch 里的行 id 写 `disabled` 覆盖（它的 README「Switching one row of a bundle」一节），本包要做的只是让每一行都能被这样寻址。这也意味着：

- 关掉 `extra-prompt`（裸包名那一行）会**同时**下掉设置页和会话看板：浏览器半边挂在这一行上。其余几行的配置在那期间不可编辑（宿主不会为一个没挂载的行提供设置表单），重新打开该行即恢复，写下的值一个都不丢。
- 已经注入过的提示词是会话历史，关掉之后不会被改写——同一会话里清空文本框仍会追加一条「不再适用」的说明，那是配置层面的清空路径。
- 「设置 → 提示词与技能」页里每一张卡片都会照常显示；没挂载的行显示为「这一行没有挂载」，并提示到「插件」页把它打开。

### 行在「插件」页显示什么

插件管理页读的是**文件**，不是运行中的插件（宿主侧 `packages/boot/app-boot/src/package-meta.ts` 的 `readPluginMeta`；作者格式见 `docs/cookbook/adding-a-package.md` 的「Add optional plugin display metadata」）：每行目录下的 `package.json` 给 `name`（标题兜底）、`description` 与 `icon`，同目录 `locale/en.json`、`locale/zh.json` 的 `meta.title` / `meta.description` 给中英文标题与说明——标题的兜底链是 locale → `package.json.name` → 完整插件名。图标是相对路径的 SVG/PNG/JPEG/WebP，不超过 256 KiB，必须落在声明它的那个目录内（符号链接解析之后），且要自包含（SVG 是当图片渲染，不是内联 HTML）。这些文件通过 `package.json` 的 exports 暴露（各行的 `"./<name>/package.json"` 与 `"./<name>/locale/*.json"`，图片本身不需要单独导出），并列入 `files`。`test/row-metadata.test.mjs` 按同一套规则逐个校验，因为漏一个 export 或写错一个文件名，在页面上只表现为「这一行没有名字」，不会报错。

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

本包的五个宿主入口都 import `@deepseek-ai/schemastery`（`prompt-injection` 另加 `dsh-llm`，`skill-installer` 另加 `dsh-tools`，`mcp` 另加 `dsh-mcp-client`）。这些包是 vendored 且 `private: true`，不在 npm 上，只能靠这层拦截拿到宿主自带的副本。而 `D:/Code/dsh-extra-prompt` 两者都不是：指向目录本身先撞 `ERR_UNSUPPORTED_DIR_IMPORT`，指向具体文件则 `ERR_MODULE_NOT_FOUND`。

所以 `package.json` 把这四个宿主包同时声明在 `peerDependencies` 和 `devDependencies`。linked root 的解析会在导入者的祖先目录里读它自己的 `peerDependencies`（`routeLinked` 里的 `readPeerNames`），命中即路由到宿主副本。DSH 只按名字匹配、不校验版本区间，因此这里写 `*`——这也让本包不受 `vendor/`（0.1.7-rc.2）与已安装桌面端（0.2.0-rc.2）之间的版本漂移影响。`dsh-mcp-client` 虽然不在 profile 自己的 `node_modules` 里，但只要声明了这个名字就能解析到宿主副本：实测 `extra-mcp` 能组合出真实实例。

只 import Node 内置模块、完全不碰宿主包的纯 JS 插件不受这条限制，可以按路径挂载；`settings-api` 就是这种（它只 import 本包自己的模块），但它仍然和其余行放在同一个包里。

### 安装后自检

```sh
dsh --profile <profile> --dump-config   # 应出现 "# == dsh-extra-prompt" 层
dsh --profile <profile> --no-open        # 启动时不应有 "did not activate" 警告
```

启动后设置页出现，说明浏览器半边被发现：`__DSH_BOOT__` 里应有 `{"id":"dsh-extra-prompt","url":"plugins/??dsh-extra-prompt/client.js&rev=…"}` 一行。

## 设置页面

位置：**设置 → 提示词与技能**（`settings.section` 槽位，`order: 30`）。这一页**只编辑配置，没有任何开关**：每个功能是「插件」页里的一行，开与关在那边（见「一行一个开关」）。

界面全部由宿主自带的设置组件搭成——`@deepseek-ai/dsh-client-ui-primitives` 是 shell 的基线模块（`packages/client/web/src/platform.ts` 的 `PLATFORM_MODULES`），所以可以直接 `require`，不需要 `dsh.client.external`：

| 用途 | 组件 |
| --- | --- |
| 卡片框架、只读提示、保存按钮 | `SettingsForm` |
| 单行文本、数字（`inputMode="numeric"`） | `SettingsValueField` |
| 布尔开关（字段级的，例如 rtk 的五个过滤器） | `Switch` |
| 「已自定义」徽章 | `Tag` |
| 路由行的添加 / 删除 | `Button` |
| 功能分组的标签栏 | `SegmentedControl`（`role="tablist"`，页面持有选中项并把面板的 `id`/`aria-labelledby` 接回去） |
| 页面与卡片上的小图标 | `ui-primitives` 自带的 `Icon*OutlineRegular` 组件 |

**图标一律用宿主的图标集，没有一个是本包自己画的，也没有一个 emoji。** 页面上的每个图形——页头、五张功能卡片的标题、看板里的 KPI 标签、协同效益四块、生命周期事件徽章、元信息标签、刷新按钮——都是 `ui-primitives` 导出的 `Icon*OutlineRegular` 组件：16×16 的 `viewBox`、`fill:none`、`stroke:currentColor`、`aria-hidden`，尺寸与描边和官方设置页旁边的图标完全一致。这套图标跟着主题走（颜色靠 `currentColor` 继承），因此不会出现「emoji 在深色主题里是彩色方块、在浅色主题里是另一副样子」这种问题。

尺寸也不是拍脑袋定的，而是照宿主自己的用法抄：卡片与页头用 16px，MCP 卡片里「高级设置」那颗 chevron 走 `Button` 的 `icon` 槽并用 13px（宿主自己的 `Button size="sm"` 调用点就是 13px），元信息标签、刷新与高效提示用 12px（宿主自己的 `IconClockOutlineRegular size={12}` / `IconRefreshOutlineRegular size={12}` / `IconCheckOutlineRegular size={12}`），事件徽章这一处最挤，用 10px（宿主最小的 `IconCloseOutlineRegular size={10}`）。这几档都钉在测试里。

这些名字集中写在 `lib/client.js` 的 `HOST_ICON_NAMES` 一张表里（按含义索引，如 `injection` / `compact` / `prune`），`iconOf()` 用它对宿主模块取组件。集中成一张表的理由是它是**对宿主的依赖**：宿主换掉一个图标名，页面不会报错，只会安静地画一个中性占位轮廓。因此：

- `test/client-bundle.test.mjs` 把这份清单**钉死**，加一个图标必须是有意为之，而不是顺手写个名字；清单已对着本包要支持的**两个宿主**核过——`vendor/dsh` 的 0.1.7-rc.2（`packages/client/ui-primitives/src/icons/index.tsx`）与实际安装的 0.2.0-rc.2 产物。两侧不只是「提过这些名字」：0.1.7-rc.2 的索引里这 14 个全在，安装版（`app.asar` 里 `@deepseek-ai/dsh-client-ui-primitives` 的 ESM 产物）里它们是真的 `export {}` 绑定（282 个导出中逐个核对），命名与 `{ size, className }` 契约一致。MCP 卡片用到的 `Button` 的 `icon` 槽也在两侧都核过：0.1.7-rc.2 是 `icon?: ReactNode` 加 `{icon != null && <span className={css.icon}>{icon}</span>}`，安装版是同一段实现——这是本次改动唯一依赖的宿主能力，所以单独确认。
- 宿主真的没有那个名字时（换了客户端），`iconOf()` 回落到本包画的一个 16×16 中性圆角方框轮廓，而不是把 `undefined` 交给 `React.createElement`——后者会抛 `Element type is invalid`，把整页设置项一起带走。掉一个图标和掉一整页，代价不该是同一个数量级。判定「有没有」用的是「能不能当组件类型」：函数算，带 `$$typeof` 的 `memo`/`forwardRef` 包装对象也算（宿主哪天改成用 `memo` 包图标，不至于被误判成缺失而全部降级），只有真拿不到才回落。
- 卡片标题仍然是「图标 + 文字」，图形是装饰性的（宿主图标自带 `aria-hidden`），可访问名依旧是标题文字。
- 页面上唯一从线上来的文案是看板的事件徽章（`context.events[].badge`），而那一行旁边已经画了 `kind` 的图标。模型侧现在只发纯文字标签，但浏览器半边仍然会**丢掉徽章里的字形**（`badgeText()`，用的正是测试里那一个字符类）：真正的前提是「一个意思只画一次」，这一道防线放在渲染处，而不是指望每个生产者都是新版本。

`ui-primitives` 没有多行文本、枚举下拉和列表编辑器这三类原子，因此这三个控件由本包自己渲染。它们的样式规则逐条抄自宿主自己的 `settings-form/fields.module.css` 与 `ConfigField.module.css`，只使用 `--dsw-*` 设计令牌，并在 `apply` 时作为一张 `<style>` 注入一次——这样它们与旁边的官方字段共用同一套间距、边框和主题，而不是又一套自造外观。

### 卡片

五个命名空间各一张卡片，再加上「技能」组里那张「模型可见的 Skills」。每张卡片是「标题 + 摘要 +（可选）仓库链接 +（可选）机器事实 + 字段 + 保存」。rtk 卡片多一行机器事实：宿主报告这台机器没有 `rtk` 时写「本机没有找到 rtk 可执行文件，工具输出会原样通过……」，找到时写出它用的那个可执行文件路径，问不到（老宿主或没有该查询接口）就什么都不写——没有结论好过编一个。

行没有挂载时（比如在「插件」页把它关掉了），卡片照样在，但走宿主 `SettingsForm` 的 `unavailable` 状态，文案是「这一行没有挂载：在「插件」页打开它的开关后，这里才能编辑。」——宿主不会为一个没挂载的插件提供表单，把原因说出来比渲染一堆点不动的控件好。

行为：

- 每张卡片独立暂存改动。**只要有字段被编辑过，「保存」就可点**——判定依据是「这一层是否留下了覆盖」，而不是「值是否与已提交值不同」：一个与默认值相同的覆盖仍然是一个覆盖。只有被编辑过的字段会被提交。
- 字段被用户层覆盖时显示「已自定义」徽章和「恢复默认」；恢复默认提交的是 `unset`（空数字输入同理），让 schema 默认值重新生效。
- 草稿不合法时（数字低于 schema 下限、路由行缺 provider 或 model）保存被禁用并就地提示，而不是把无效值写进去或悄悄丢掉。
- 宿主拒写时草稿保留在本页，不会因为一次没有被接受的写入而丢掉用户输入。写入被接受后草稿清空，显示回落到宿主快照。
- 宿主只读时（`snapshot.writable !== true`）所有控件禁用，并提示改动不会写入磁盘。
- 保存会写进当前 profile 的 `cordis.patch.yml`（DSH 的配置编辑器负责），不是本包自己的文件。写入按读取到的 `revision` 做栅栏，落在过期版本上会被拒绝。
- 页头一行写清开关在哪：`dsh-extra-prompt <版本> · 每个功能一行插件，开与关都在「插件」页；这里只放它们的配置。` 版本号是手写的（产物没有构建步骤，读不到 `package.json`），`test/client-bundle.test.mjs` 负责断言两者同步。


### 分组 Tab

卡片多了以后一页滚不完，所以页头下面是宿主的 `SegmentedControl`：提示词 / 子代理路由 / 技能 / 输出压缩 / MCP，每组只渲染当前这一组的卡片或视图。**五个分组始终都在**——页面形状由包决定，不由 profile 决定：某一行关掉了，它的标签页不会消失，只是那一张卡片显示成「没有挂载」，从「插件」页打开后又带着原来的配置回来。选中项因此不会指向一个不存在的分组。

会话看板不在这个标签栏里：它只作为会话内的 `conversation.view` 标签页存在，见下。

### 会话看板（Session Statistics Dashboard）

将 Deeptop 广受好评的会话性能与成本计量看板完全迁移并做了现代高密度重构。底层逻辑由纯函数模型 `src/session-dashboard/model.mjs` 支撑，前端使用纯 React + SVG + CSS 动效打造，信息密度极高且视觉现代精致。入口只有一个：会话内的 **「看板」** 标签页。

- 注册在官方 `conversation.view` 槽位（`order: 20`，位于「对话」与「轨迹」标签页旁边）；
- 在任何会话中直接点击顶部的 **「看板」** 标签，即可就地查看该会话的性能与成本明细，输入框保持吸底浮层联动；
- 看的是**当前这一个会话**：会话 id 由槽位注入，切换会话时视图按 id 重挂载，不会把上一个会话的数字留在屏幕上。

- **核心特性**：
  - **时间窗口切片**：顶部工具栏提供「全部轮次」与「最近 8 轮」的动态切片，以及一键实时刷新数据。
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
  - **数据通道**：利用本插件的 `/api/extra-prompt` 数据网关（`dashboard/data`）按需实时调取宿主 `readSessionDashboardFromHost`（`sessionQuery` / events / projections），不引入任何冗余第三方图表库，完全遵循 DSH 设计系统令牌（`--dsw-*`）。
  - **图形全部是矢量**：环形图与时序图是本包自己的 SVG，小图标（元信息标签、刷新、协同效益四块、生命周期事件徽章、无重做提示）则全部取自宿主的 `Icon*OutlineRegular` 图标集，颜色继承 `currentColor`，随主题一起变。看板不出现任何 emoji 或字体字形充当的图形。

### MCP 服务器

一台服务器一个编辑器：名称、传输方式（stdio / streamable-http）、启用开关、删除。名称同时是工具命名空间（工具以 `mcp__<名称>__<工具名>` 注册），所以必须全局唯一；重命名等于「删掉再添加」。stdio 只把声明的字段交给官方 `dsh-mcp-client`：启动命令、参数（每行一个）、工作目录、环境变量；streamable-http 传 URL 与请求头。高级设置里是调用超时、指令字节上限、启动失败是否致命，以及重连开关与三个退避参数。

- 新增的服务器默认**关闭**：stdio 服务器是在 Host 本机起子进程、不经过 Agent 沙箱，所以不该因为「加了但还没配完」就跑起来。
- 只有已启用的服务器会被组合，关掉的不占工具命名空间也不起进程；改动连接参数会重建那一个实例，只翻开关不会（宿主用的 `specKey` 忽略 `enabled`，它改变的是「在不在」，不是连接参数）。
- 卡片按宿主同一套规则做阻塞式校验（名称形状与唯一性、两种传输各自的必填项、环境变量/请求头名是否合法、数值上下界、最多 64 台），不合规不允许保存，错误逐条挂在对应的服务器下面。这套规则在宿主（`src/mcp/model.mjs`）和浏览器半边各写了一份——产物是 classic script，没法 import 宿主模块——由测试逐例比对两边答案一致。
- **环境变量与请求头的值以明文保存在 profile 的 `cordis.patch.yml` 里**，卡片上写明了这一点。官方 `mcp-client` 的配置只接受字面量（`env`/`headers` 都是 `Record<string,string>`），DeepSeek provider 那种「只存引用、每次请求再解析」的路径在这里不成立，何况 stdio 的 `env` 是起子进程时就定下的。所以本包不假装提供凭据引用，而是把明文这件事直接说出来。

### 模型可见的 Skills

「技能」组里的第三张卡片。它列出的不是「本包装过什么」，而是**模型这一轮真正能读取到的 Skill**：名单来自宿主自己的 `skills` 注册表——`skill` 工具与每步 `<available_skills>` 目录用的是同一个注册表——按当前挂载工作区的 cwd 逐个查询，结论按名字合并（工作区先查，同名时保留工作区那一份，也就是模型实际会加载的那一份）。

逐行给出：名字、描述、来源桶（`project-dsh` / `project-agents` / `user-dsh` / `user-agents` / `custom` / `bundled` / `runtime`，括注对应的目录）、Skill 所在目录（注册表给的 `resourceBase`）、所属工作区，以及 `disable-model-invocation` / `user-invocable:false` 这两个调用开关。本包安装的条目额外给出 `skill-install` 的来源与 ref，以及一个卸载按钮。

- **页面不自己走目录**：`.dsh/skills` 与 `.agents/skills` 的发现、frontmatter 解析、同名优先级、`.system` 跳过、扁平 `.md` Skill、捆绑目录，全部由官方 `@deepseek-ai/dsh-skill-filesystem` 决定，这里只调用 `ctx.skills.list()`。页面因此不可能和模型读到不同的目录清单——这正是「不用第二套规则」的价值。早期版本自己扫目录，既漏了用户级 `~/.agents/skills`，也无法复现注册表的优先级。
- **必须带 scope**：注册表是**按 scope 分层**的，而 `skill-filesystem` 挂在 agent preset 的那一层（官方 `standard` preset 就是这样），所以**不带 scope 的读取只会看到宿主构成里全局注册的那几个 Skill**，看不到任何工作区或用户级目录。这一行复刻了 `packages/host/apiproxy/src/api-proxy.ts` 里 `skill.list` 的解析：活的 agent 本身就是 scope（它的链会穿过 preset 的 standing 层）；没有活的 agent 的会话用 `agentPresets.standingKeyFor(会话记录的 preset)` 取 standing key（只组合，不启动 agent/会话/turn）；preset 未知或不可用则退回全局层。若某个构成把注册表 realm 挂载成了自己的实例，则通过活 agent 的 `serviceFor(agent,'skills')` 取那个实例。
- **读哪些工作区**：活会话的 `header.cwd`（每个 cwd 读一次，去重，最多 8 个）；一个活会话都没有时用最近更新的一条已存会话的 cwd；两者都没有就不带 cwd 读一次——用户级与内置目录不依赖 cwd，此时用默认 preset 的 standing key。工作区读取已经包含用户级与内置根，所以不再额外读一遍无 cwd 的视图。
- **卸载仍然只认证明**：安装时会在 Skill 目录里写一份受管标记（`.dsh-managed-skill.json`），其中的 `installationId` 每次安装随机生成；卸载时要求 profile 注册表里的记录与目录里的标记**同时**匹配，否则拒绝删除并说明原因。只有注册表记录、或者只有目录里手写的标记，都不构成删除授权。删除目录先于删记录：中断最多留下一条「目录已不在」的记录，而不是一个没人跟踪的目录。拒绝也是一种回答：宿主返回 `ok:false` 加原因，卡片把它显示出来并保留那一行，而不是把失败的卸载画成成功。
- **注册表记录不会因为读不到目录而消失**：目录被手工删掉（或 `SKILL.md` 不再可解析）的受管记录会作为「受管记录」单列一行，带上宿主给的原因，这样一条只存在于隐藏文件里的记录仍然看得见、清得掉。
- **profile 没挂载时降级，而不是整张卡失败**：拿不到受管注册表只意味着「不知道哪些是本包装的」，Skill 名单照常给出，原因作为一句话显示在卡片上。

这张卡片的 Skill 数据不是配置、读不到任何命名空间里，所以走的是本包自己的 `/api` 路由 `POST /api/extra-prompt`（`{op:'skills/list'}` / `{op:'skills/remove'}`）。同一个路由还回答第二个问题 `{op:'rtk/status', rtkPath}`：这台机器上有没有 `rtk`（见 `extra-rtk-compact` 一节）。几个问题都是「页面读不到、只有宿主知道」的事实，而不是配置——这条路由从不写任何配置，所有设置写入仍然走 `configForms`。

**为什么不用 `connection.rpc.handle()` 建一条 JSON 通道**：那个方法内部会通过**调用方 context** 去取 `webServer`（`packages/client/connection/src/rpc-host.ts` 的 `register()` 写的是 `owner.webServer.register(route)`），而属于「只声明了这个服务的插件」的 context 走不到那一步——它在 isolate 边界停下并抛 `cannot get property "webServer" without inject`，无论这一行 `inject` 里写什么（`['connection']`、`['connection','webServer']` 都试过）。`connection.fetch.register()` 不碰 `webServer`：它把路由登记进共享的 `/api` 表，由 Connection 自己的 `/api` 路由在受信主机检查与浏览器会话认证**之后**转发，因此这条路由是普通的同源已认证 POST，浏览器半边用 `fetch` 带 cookie 调它。实测 `POST /api/extra-prompt {"op":"ping"}` 返回 `{"ok":true,"value":{"pong":true}}`。

### 这个页面为什么挂在 `settings.section`

DSH 里插件配置的**规范位置**是 Plugins 页的 `plugins.row.config`（键为 `<包名>#<行 id>`）或 `plugins.bundle.config`，而 `plugins.item` 那一条在 slot 契约里明确写着 "OCCUPIED by the official settings pages"。本包各行的行 id 恰好就是各命名空间名，所以 `plugins.row.config` 能把每个功能各自变成一个官方外观的配置页。

本包选择 `settings.section`（设置侧栏的一个分区），因为一行一页会把功能打散到 Plugins 页的展开层级里，而且宿主只为**已挂载**的行提供设置表单——把配置拆到行里之后，关掉一行就再也改不了它的配置，除非先打开。一个集中、始终可达、按分组标签组织的配置页仍然更合适；`settings.section` 是已声明的公共槽位，注册进它不需要上游改动。「插件」页承担的是**开关**，设置页承担的是**配置**。

### 各命名空间的字段

**没有任何命名空间再有 `enabled` 字段**（见「一行一个开关」）：功能的开与关就是「插件」页上那一行的开关。下面这些字段都可以就地编辑并热生效。

**extra-prompt-injection**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `text` | 多行文本 | 空 |

清空文本 = 不注入；同一会话里清空还会追加一条「不再适用」的说明（`CLEARED_INJECTION`），因为已经注入的内容是会话历史，不会被改写。

**extra-subagent-routing**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `routes` | 数组，每项 `{ provider, model, note }` | `[]` |
| `guidance` | 多行文本 | 空（非空时整体替换自动生成的路由段落） |

这一行被关掉时（fiber 卸载）除了段落跟着消失，还会把之前写进模型目录 `models[].description` 的说明收回——那些说明不属于 fiber，得由 disposer 显式撤回，否则 `list_subagent_models` 会继续宣传一个已经关掉的功能。

**extra-skill-installer**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `defaultRef` | 文本 | `main` |
| `defaultMethod` | `auto` / `download` / `git` | `auto` |

工具注册跟着 fiber 走，所以关掉这一行等于把 `skill-install` 从模型可见的工具列表里摘掉。

**extra-rtk-compact**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `rtkPath` | 文本 | 空（空则在 `PATH` 上找 `rtk`） |
| `minBodyChars` | 数字 | `1200` |
| `timeoutMs` | 数字 | `20000` |
| `maxOutputBytes` | 数字 | `4194304` |
| `gitStatus` / `gitDiff` / `gitLog` / `rg` / `grep` | 开关 | 均为开 |

这一行是唯一需要说明「机器事实」的：宿主有没有 `rtk` 可执行文件与它无关（开关就是行本身），但**没有 rtk 时输出会原样通过，看起来和压缩成功一样**，所以卡片把那件事写出来。

- 页面向宿主提问时会带上自己表单里的 `rtkPath`，因为用户手填的路径是宿主唯一不会去查找的那种情况。`rtkPath` 一变就重新问一次，这也是这一格里唯一能不重启就生效的修改。
- 宿主在该行挂载但找不到 `rtk` 时只记一条警告（`rtk-compact 这一行已挂载，但本机没有找到 rtk 可执行文件…`），而不是静默地逐条原样通过。
- **装完 rtk 要重启 DSH**：可执行文件是在进程启动时继承的 `PATH` 上解析的，包管理器（winget / scoop / cargo）把安装目录写进用户 `PATH` 之后，已经跑着的 Host 看不到它——页面会继续显示「本机没有找到 rtk」。重开 DSH 即可；不想重启就在这一格里把 `rtkPath` 直接填上，那条路径是逐字的，不经过 `PATH`。`rtk init` 与这个插件无关（见下）。
- rtk 不是 DSH 安装的东西，所以页面给出它的上游地址 [github.com/rtk-ai/rtk](https://github.com/rtk-ai/rtk)：这张卡片在摘要下面写一行「仓库：…」，机器没装 rtk 时的说明就紧跟在它下面（所以那条说明不再重复打印地址）。链接是普通的 `<a target="_blank" rel="noopener noreferrer">`，和官方 `ui-settings-account` 的 `AccountSection` 一样（那个包也没有可复用的链接组件，`ui-primitives` 只导出图标）。
- **不需要 `rtk init`**：`init` 是给 Claude Code / Cursor / Windsurf / Cline 这类助手 CLI 装 hooks 与 `CLAUDE.md`（或 `RTK.md`）指令文件的（`rtk init --agent <claude|cursor|…>`，`-g` 写全局、不加写当前目录），作用是让**它们自己的** bash 调用绕道 rtk。本插件自己匹配命令、自己把工具结果喂给 `rtk pipe -f <filter>`，不读任何 rtk 全局配置，所以 `rtk init` 成不成功都与本功能无关。实测在一个全新安装、从未 `init` 过的 rtk 0.50.0 上，`git-status` / `git-diff` / `git-log` / `grep` / `rg` 五个过滤器全部存在且退出码为 0。

**extra-mcp**

| 字段 | 类型 | 默认 |
| --- | --- | --- |
| `servers` | 服务器列表（每项自带 `enabled`，见「MCP 服务器」一节） | `[]` |

这一格不是单个控件而是列表编辑器：每个条目自成一个 `dsh-mcp-client` 实例，字段与官方 `mcp-client` 的 `Config` 一一对应，本包只负责把它编辑并组合起来。列表里每台的 `enabled` 与行开关不是一回事：行开关决定「MCP 这一层在不在」，条目开关决定「这一台连不连」。

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

1. **无条件注册 `settings.section`，而不是 `configForms.whileServed(...)`。** 这五个命名空间由本包自己的行提供，页面不可能指向别人的命名空间；让没挂载的行显示成「这一行没有挂载」并指出到哪里打开，比整页消失更好排查。
2. **订阅用 `React.useState` / `useEffect` 直接做，而不是渲染器的 `inject.hooks` 隔间。** 那个通道需要仓库内的框架钩子；`ConfigForm` 的 `getSnapshot()` / `subscribe()` 本身就是普通可观察对象，效果等价。若今后要上游化，这里应改成 hooks 隔间。
3. **UI 文案是硬编码中文，没有走 locale 字典。** 槽位标签的类型是 `SlotLabel = string | (() => string)`，字符串完全合法。若上游化，会被 `verify-client-ui-i18n` 拦下。
4. **`enabled` 字段被移除，开关交还给「插件」页的行。** 早期版本给四个功能各加了一个 `enabled` 布尔字段，好让设置页顶部那张启用卡片用同一种方式开关它们；这与 DSH 的惯例相反（惯例是整行 `disabled`／`enabled`，配置里不放开关），也让同一个功能有两级语义不同的开关。现在每个功能的开关就是那一行：关掉会卸载 fiber，工具、注入、system prompt 段落、模型目录说明一起消失。默认值是 schema 默认，配置里不再需要写 `enabled`；旧配置里若留着这个键，请删掉（它现在是未知字段）。
5. **三个控件是自绘的，不是宿主原子。** 多行文本、枚举下拉、路由列表编辑器在 `ui-primitives` 里没有对应导出（`ConfigField` 覆盖了前两者，但它是包内私有的，未从索引导出）。它们的样式逐条复刻宿主自己的字段 CSS 并只用 `--dsw-*` 令牌，外层仍复用官方的标签行、覆盖徽章与恢复按钮，所以视觉上与官方字段一致。
6. **每个功能都有显示元数据文件，插件页才能显示得像官方行。** 插件页读的是 `<行目录>/package.json` 与 `locale/{en,zh}.json`，不是运行中的插件；`package.json` 里为此补了 `"./<name>/package.json"` 与 `"./<name>/locale/*.json"` 两组导出（没有导出，解析器就找不到文件，行会显示成包内路径）。图标是手写的 32×32 SVG。
7. **MCP 是新增的，不是移植的。** Deeptop 的 MCP 在 `desktop-bridge/tool-config.mjs` 里，靠一个 JSON 配置文件加托管块标记，属于「不移植」的桌面桥接层；DSH 自己的 MCP 行则是手写在 `cordis.patch.yml` 里的字面量。本包把它改成在设置页编辑、由插件按条组合官方 `mcp-client` 实例，这是这一层唯一的新领域逻辑。
8. **页面数据通道用 `connection.fetch.register()`，不用 `connection.rpc.handle()`。** 原因见「模型可见的 Skills」一节：后者在当前版本从插件 context 调用会抛 `webServer` 的 inject 错误。这是实测记录，不是偏好。
9. **分组标签页固定五个，不随行的开关增减。** 早先的做法是「功能全关的分组连标签一起消失」（「技能」组用 `always` 豁免）；既然开关搬到了「插件」页，一个会把标签页抽走的配置页只会让人以为配置丢了。`always` 因此不再需要。
10. **页面内的图形全部来自宿主的图标集，本包一个都不自绘。** 这与上面第 6 条（插件行图标是手写的 32×32 SVG 文件）不矛盾，两者是两回事：第 6 条说的是「插件」页读的那个**文件**图标，只能由本包提供；这里说的是设置页与看板**渲染出来的**小图形，宿主已经有一整套。早先这些位置画的是一批 emoji 与字体符号——卡片图标是对话气泡、分支、包裹、闪电、插头、拼图、罗盘（U+1F4AC / U+1F500 / U+1F4E6 / U+26A1 / U+1F50C / U+1F9E9 / U+1F9ED），看板协同块是火箭与注射器（U+1F680 / U+1F489），元信息标签是文件夹与秒表（U+1F4C1 / U+23F1），压缩与剪枝用剪刀、高效提示用勾选、高级设置的展开与收起用两个小三角、刷新用回转箭头（U+2702 / U+2713 / U+25BE / U+25B8 / U+21BB）。问题有三：emoji 是彩色的字体字形，会脱离 `--dsw-*` 主题、在深浅两种主题下不受控；它们在不同平台与字体下的字形、基线、宽度都不一样；以及它们不是矢量语义，混在官方图标旁边一眼就看得出是外来的。改用的宿主图标自带 `currentColor`、`aria-hidden` 与统一的 16×16 网格，观感与官方设置页一致。代价是这套名字成了对宿主的依赖，处理方式见上（钉死清单 + 中性回落）。

## 与原 Deeptop 插件的差异

除上面五条外，从 `Deeptop/cordis/` 移植时还有这些差异，都记在这里以免被当成 bug：

**命名**：原 Deeptop 的五个设置命名空间、六个行 id、受管 Skill 的注册表文件名（`extra-prompt-managed-skills.json`）与标记里的 `owner`（`extra-prompt`）都从 `deeptop-*` 改成了 `extra-*`。没有做数据迁移，因此一个已经跑过 Deeptop 的 `$DSH_HOME` 里：旧的注入设置不会被读到（首个 step 会多发一次「此前的注入已失效」的说明，之后自愈）；被 Deeptop 装过的 Skill 不在本包的注册表里。

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
- **Skill 管理**：手工造两条注册表记录（一条目录里有匹配的受管标记，一条只有标记之外的目录），`skills/list` 如实给出 `removable: true/false` 并带上原因；对第二条 `skills/remove` 返回 `ok:false` 且目录原封不动；对第一条返回 `ok:true`，目录与注册表记录同时消失，重新 `skills/list` 只剩那条删不掉的。同一条路由还在 `test/settings-api-route.test.mjs` 里用真注册表跑通：`skills/list` 只发一次 `list({cwd, scope})`（scope 就是活 agent）、目录与标记都认同的安装才带得出 `managed.removable`、profile 缺失时名单仍在而只丢来源、宿主没有 `skills` 注册表时受管记录单独列出。

两条踩坑记录，写给未来的自己：

- **宿主侧的行改动不会热更新，必须重启 Host**（浏览器半边的产物会按 `rev` 重新取，宿主模块不会）。早期探测 `POST /extra-prompt/ping` 拿到 405 就是这个原因——路由那时根本没注册。
- **`connection.rpc.handle()` 从插件 context 调用必然失败**，报 `cannot get property "webServer" without inject`（详见「模型可见的 Skills」一节）。改用它旁边的 `connection.fetch.register()` 即可。

**未验证**：设置页在真实浏览器里的渲染与保存往返（包括 Tab 切换、MCP 服务器编辑器、模型可见的 Skills 卡片的点击），以及把开关搬到「插件」页之后的两条路径——在插件页关掉/打开某一行时 fiber 的卸载与恢复（含 subagent-routing 收回模型目录说明），和插件页对每一行标题、图标、说明的显示。图标改成宿主图标集之后，**图标的实际观感（尺寸、对齐、深浅主题下的颜色）只能靠眼睛确认**：测试断言的是「画的是哪个图标、画在哪个位置、不是 emoji」，替代不了真实渲染。改动 `lib/client.js` 或任一行目录下的元数据后，请在 Web UI 里手动确认一次。

## 测试

```sh
npm test          # 等价于 node --test "test/**/*.test.mjs"
```

125 个用例，分三层：

- **宿主层（80）**：纯函数模型（提示词组装、rtk 过滤规则、路由说明渲染、MCP 服务器文档的规范化/校验/`specOf`/`specKey`、目录说明的写入与收回、Skill 名单的合并与受管记录归属、看板的汇总与生命周期事件），安装器（真实临时目录，含「没有挂载 profile 时仍能安装但不记录来源」的路径），以及设置路由的端到端（`apply()` 挂在一个 context 替身上，然后发出浏览器真正会发的那条 POST，配真注册表与临时 profile）。
- **行显示元数据（4）**：`test/row-metadata.test.mjs` 从 `cordis.patch.yml` 读出每一行，再按宿主 `readPluginMeta` 的同一套规则解析它的资源——`<行>/package.json` 与 `<行>/locale/en.json` 必须能通过 package exports 解析到、locale 文件名必须是语言 id、中英标题与说明都必须非空且互不相同（否则一页会显示另一页的语言）、图标必须是目录内的相对路径且类型与 256 KiB 都合规、SVG 要带 `viewBox` 且自包含；最后核对 `files` 确实包含这些文件（`link:` 安装看不出漏项，发布出去才知道）。
- **浏览器半边（41）**：在 `node:vm` 里执行真实的 `lib/client.js`，用一个最小 React 替身和一套按官方 prop 契约写的组件替身渲染，断言它注册到 `settings.section`、注册的命名空间与 `package.json` 导出一致、页头写的包名版本与 `package.json` 一致且点明开关在「插件」页、样式只走 `--dsw-*` 令牌、渲染出所有声明的字段、页面上没有任何功能开关（`enabled` 卡片已不存在）、五个分组始终在标签栏里、行未挂载时卡片显示「这一行没有挂载」而其余卡片照常、保存只写被编辑过的字段并在被接受后清空草稿、宿主拒写时保留草稿、空数字走 `unset`、低于 schema 下限的数字与缺 provider/model 的路由行都会阻止保存、只读时禁用保存、子代理路由的白名单交叉检查（不一致时点名缺哪些路由、一致时不说话、命名空间未挂载时不猜、并且从不写那份文档）、MCP 卡片每条错误只说一次且只把同类控件并排，以及 rtk 卡片在「问不到 / 答不出 / 答没有 / 答有」四种回答下的那一行机器说明。

其中三条值得单独说：

- **MCP 规则是双份实现的，所以有一条逐例比对**：宿主 `src/mcp/model.mjs` 与浏览器半边各自判断同一份服务器文档，一个 20 行的表格逐例比较两边给出的「第几台、哪个字段」集合必须完全一致。写这条测试时它立刻抓到一处真实分歧（卡片在 `reconnect` 关闭时仍然管退避数字的上界，宿主不管），已按宿主行为修正。
- **Skill 卡片的测试用的是真实请求/响应契约**：`fetch` 替身记录每一次调用并回放脚本化的宿主响应，因此断言的是「发了什么请求」（同一个 `/api/extra-prompt`、`credentials: 'same-origin'`、`{op, directoryName, installationId}`），渲染出的来源桶、工作区、目录与调用开关，以及失败后那一行还在、错误文案来自宿主。宿主那一侧则由 `test/settings-api-route.test.mjs` 用真注册表跑同一条路由：`list` 的入参必须是模型自己会用的 `{cwd, scope}`，只有目录与标记都认同的安装才带得出卸载按钮。
- **图形的回归测试同时盯住「没有 emoji」和「图标真的画出来了」**：`PICTURE_GLYPH` 把 U+1F000–1FAFF 以外的 **U+2190–21FF 箭头、U+2300–23FF 技术符号、U+25A0–27BF 几何图形与装饰符号、U+2B00–2BFF** 也算进来——U+2702（剪刀）、U+25B8/U+25BE（展开三角）、U+21BB（刷新）与 U+2713（勾选）正是在这些区段里，只查「emoji」会全部漏掉。它先扫 `lib/client.js` 与 `src/session-dashboard/model.mjs` 的源码，再扫**真正渲染出来的文本树**（五个分组的卡片、Skill 卡片，以及带生命周期事件的看板），两侧都必须是空集；同时断言那些位置确实画出了对应的宿主图标（`data-icon` 标记），以及 `HOST_ICON_NAMES` 与钉死的清单逐字一致。还有三条单独验证回落、识别与「图形一律矢量」这条线本身：让替身故意**不提供** `IconSkillOutlineRegular`，页面必须照常渲染、画出一个不带宿主标记的 16×16 中性轮廓，而不是抛 `Element type is invalid`；让替身把某个图标**包成 `memo`/`forwardRef` 那种带 `$$typeof` 的对象**，页面必须照常认出它，而不是把所有图标一起降级成中性轮廓；以及给看板喂一份**旧格式的事件负载**——徽章里还带着 U+2702 这类字形——页面必须只显示文字 `压缩` 与矢量图标。第三条针对的是一个真实缺口：事件徽章是这一页唯一从线上来的文案，而它旁边已经画了 `kind` 的图标，页面若不自己拦一道，旧生产者送来的字形就会和图标一起出现，正是这次要消灭的「一个意思画两遍」。

React 替身实现了依赖比较和 cleanup 的 `useEffect`（`useForm` 是在 effect 里刷新快照并订阅的，effect 不跑的话面板会停在首帧值，写入断言就没有意义），并在渲染后按 React 的顺序冲刷 effect、必要时再渲染一次。hook 单元既按位置、也按组件函数区分——同一个位置上换了组件（一个功能卡片和 Skill 管理卡片都可能是面板的第一个子节点）必须像 React 那样重新挂载，否则第二个组件会读到第一个的 state。设置组件替身复现的是宿主的 prop 契约（含保存按钮 `!dirty || invalid || saving` 的禁用规则），而不是它们的渲染与样式。

**不覆盖**：真实 React 语义、宿主组件的实际外观、以及经 `settings` Remote 的实时往返——这些需要浏览器。
