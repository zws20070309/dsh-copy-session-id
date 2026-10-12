# dsh-copy-session-id

给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）的会话标题栏加一个「复制会话 ID」按钮。

点一下，当前会话 ID 的**原文**就进剪贴板——没有前缀、没有后缀、没有换行，粘到别处直接可用。

```
┌─ 会话标题栏 ──────────────────────────┐
│  修复登录超时问题        [团队] [📋]  │   ← 点这个
└───────────────────────────────────────┘
                                   ↓
                        图标变 ✓ +「已复制」，1.5 秒后还原
```

## 为什么需要它

跨会话协作时经常要把一个会话 ID 交给另一个会话：转交上下文、让子代理接着干、记进任务清单、贴给同事。DSH 本身不在界面上暴露当前会话 ID——要拿到它得翻目录或读存储文件。

这个插件把它变成一个按钮。

## 特性

| | |
|---|---|
| **复制的是纯 ID** | 剪贴板里就是会话 ID 本体，没有任何包装文本 |
| **不占地方** | 平时只有一个图标按钮，不常驻显示 ID 文本。悬停可看到完整 ID，方便核对复制对不对 |
| **失败看得见** | 复制失败会显式显示「复制失败」，不会静默吞掉 |
| **三级降级** | `navigator.clipboard.writeText` → 隐藏 textarea + `execCommand('copy')` → 显式失败提示 |
| **零依赖零构建** | 只 `require('react')`，不引任何 DSH 包，源码即运行物 |
| **不拖垮页面** | 槽位注册失败只会让按钮不出现，DSH 本身照常工作 |

## 安装

```powershell
git clone https://github.com/zws20070309/dsh-copy-session-id.git
cd dsh-copy-session-id
powershell -ExecutionPolicy Bypass -File .\tools\install-link.ps1
```

然后**完全退出并重启 DSH**。

<details>
<summary>脚本做了什么（点击展开）</summary>

三件事，全部可回滚（改 profile 配置前会先备份）：

| # | 动作 | 落点 |
|---|------|------|
| 1 | 建目录联接（junction）指向源码目录 | `<DSH_HOME>\plugins\dsh-copy-session-id` |
| 2 | `dependencies` 加一条 `link:` 依赖、`dsh.profile.bundles` 加一项 | `<DSH_HOME>\profiles\desktop\package.json` |
| 3 | 建 node_modules 联接 | `<DSH_HOME>\profiles\desktop\node_modules\@zws\dsh-copy-session-id` |

用的是联接而不是复制文件，所以在源码目录里改代码，重启即生效，不用重装。

</details>

<details>
<summary>可选参数与卸载（点击展开）</summary>

```powershell
# 自定义路径 / 装到别的 profile
.\tools\install-link.ps1 -DshHome D:\dsh -ProfileName web -Source C:\path\to\this\repo

# 卸载（保留源码目录）
.\tools\install-link.ps1 -Uninstall
```

`<DSH_HOME>` 默认是 `%USERPROFILE%\.dsh`。插件放在 `plugins\<name>`，profile 在 `profiles\<profileName>`（桌面端是 `desktop`）。

也可以不走脚本：DSH 界面里「插件 → 已安装 → 添加插件」，填本仓库目录的绝对路径。

</details>

### 两个注意事项

**一、必须重启才生效。** DSH 的 HMR 只对 profile 配置生效，源码模块要显式加进监听列表才会热重载，默认不监听插件目录（见官方 `dsh-base/cordis.patch.yml:27-32`，`dsh-hmr` 的 `config.root` 默认是空数组，注释写明 "module roots are opt-in"）。

**二、不要手改 `profiles\<profileName>\cordis.yml` 来注册插件。** 那个文件只是个空列表占位，文件头写着 `Edit cordis.patch.yml, not this file`——插件的树是运行时由各 bundle 层的 patch 拼出来的。要手写注册请改 profile 自己的 `cordis.patch.yml`。

## 它是怎么挂上去的

挂在 DSH 官方的 UI 槽位 `conversation.session.header.actions` 上——会话标题栏右侧的操作区，官方的「智能体团队」等按钮也在这个容器里。

```
sessionId ──► 组件 props（session 作用域的标准 props）
            └─ dsh-client-ui-session → dsh-client-ui-renderer

apply(ctx) ──► slots.inject('conversation.session.header.actions', …)
            └─ 注册本组件，order: 100
```

槽位的 `order` 是升序（数值越小越靠左）。本插件取 `100`，所以排在容器最右端——同槽位的官方条目实测 order 为 `-30 / -20 / -10 / 20`。

> **客户端 bundle 的形态是硬约束**：DSH 会把所有插件的客户端代码拼成**一个脚本**执行，所以顶层不能有任何声明（和其他插件撞名会让整个应用起不来）。注册必须内联成单条 `window.__ModuleLoader__.load({...})` 语句。

## 目录结构

```
lib/client.js           浏览器半。全部行为在这里：注册槽位 + 按钮组件 + 复制降级链
lib/index.js            宿主半。空壳，但必须存在（见下）
cordis.patch.yml        三行，把本包作为一行插件配置新建进 profile
locale/*.json           插件页的标题与描述
icon.svg                插件页图标
tools/install-link.ps1  安装 / 卸载脚本
tools/selftest.cjs      离线自测
tools/review-*.cjs      契约审查脚本
```

<details>
<summary>为什么 <code>lib/index.js</code> 是空的还要有？</summary>

浏览器半的发现机制跟着 cordis 的 fiber 走：一个包只有在 profile 的 cordis 配置里出现过、被真的 import 过，才会有 fiber，浏览器才会加载它的客户端代码。

至于 host 半做什么，官方只校验 `exports["./client"]` 存在，不看 host 半导出什么。所以它是个空壳，但删了插件就不会被加载。

</details>

## 开发

离线自测——不需要 DSH、不需要网络、不装任何包：

```powershell
node tools\selftest.cjs
```

它在假全局（假 `window.__ModuleLoader__`、假 react、假 clipboard、假 document）里真跑一遍 `lib/client.js`，断言注册形态、槽位参数、点击后剪贴板收到的是**全文相等的纯会话 ID**，以及降级链与失败提示。

契约审查——读本机 DSH 的官方包源码，校验依赖的槽位契约没变：

```powershell
node tools\review-01-toplevel.cjs         # 顶层零声明（含与全部官方 bundle 拼合测试）
node tools\review-05-official-slots.cjs   # 用官方真实 SlotCore 验证注册与排序
```

没装 DSH 也能跑：相关检查会自动跳过并说明原因，退出码仍是 0。

## 排错

| 症状 | 看哪里 |
|------|--------|
| 标题栏没有按钮 | DevTools Console 搜 `copy-session-id`，插件会 `console.warn('[copy-session-id] ...')`。一条都没有 = 注册没跑（多数是没重启 DSH） |
| Console 有 `[copy-session-id] slot register:` | 官方槽位形状变了。**页面不会崩，只是按钮不出现** |
| 按钮灰的、点不动 | 当前会话还没有 sessionId |
| 点了显示「复制失败」 | 浏览器不是安全上下文，且 `execCommand('copy')` 也被拒。DSH 本体在 `127.0.0.1` 上，正常不会走到这里 |

## 兼容性

- DSH 44.x（在 44.0.0 上开发与验证）
- 依赖宿主提供的 `@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-plugin-manager`（`>=0.2.0-rc.1 <0.3.0`）
- Windows：安装脚本用目录联接（junction）。Linux/macOS 改用符号链接即可，把脚本里的 `New-Item -ItemType Junction` 换成 `ln -s`

## 许可

MIT
