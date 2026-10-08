// 复制会话 ID —— 宿主入口（host plane）
//
// 这个插件**只有浏览器半**：一个标题栏图标按钮，没有服务端路由、没有配置页、没有 host 侧状态。
// 但宿主入口仍然必须存在，原因是源码写死的机制，不是惯例：
//
//   * `dsh-client-modules` 的扫描器是**跟着 cordis 的 fiber 走的**
//     （dsh-client-modules/lib/index.js:114-116
//       「Every cordis `internal/plugin` emission (fiber construction/disposal)
//         marks the fiber's entry name dirty」）。
//     它 resolveMeta 的入口参数是 **Loader 条目名**（同文件 :701/:743），
//     也就是「cordis 真的 import 过这个包、真的建了 fiber」。
//   * `dsh.profile.bundles` 里列一个包名 → cordis 按 cordis.patch.yml 建一行配置 → import 该包 →
//     建 fiber → client-modules 才会发现它的 `dsh.client` 声明并把 client bundle 发到浏览器。
//     没有这一步，浏览器侧永远看不到这个插件。
//
// 至于 host 半本身做什么：`resolveMeta` 只校验 `exports["./client"]`
// （dsh-client-modules/lib/index.js:718-719：「declares dsh.client but exports no "./client" bundle」），
// 完全不看 host 半导出了什么。所以本文件是个空壳，只为让 fiber 建起来。
// 同机器上跑通的第三方插件 @linxin666/dsh-client-ui-session-id 就是这么写的
// （lib/index.js 只有 `function apply(_ctx) {}`）。
//
// 这里保留 `name` / `inject` 两个导出，跟 DSH 官方包的写法一致：
// `inject: []` = 不声明任何宿主服务依赖，cordis 立刻 apply。

/** Cordis 插件名。 */
export const name = '@zws/dsh-copy-session-id';

/**
 * 宿主依赖。**刻意为空**：本插件不需要 webServer / settings / agentTeams 任何一个。
 * 写成 `Inject.resolve(plugin.inject)`（cordis/lib/index.js:1635）时，空数组等价于「无依赖」。
 */
export const inject = [];

/**
 * 宿主平面无事可做。
 *
 * 唯一作用是让 cordis 建出这个 fiber，从而让 `dsh-client-modules` 扫到本包的 `dsh.client`
 * 声明（见文件头）。不要在这里加任何逻辑 —— 加了就是给一个「复制按钮」凭空引入宿主侧故障面。
 */
export function apply() {}