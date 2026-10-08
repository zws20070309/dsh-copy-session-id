// 复制会话 ID —— 浏览器半（手写 lazy-CJS bundle，无构建步骤，源码即运行物）。
//
// 挂载点：官方槽位 `conversation.session.header.actions`
//   * 槽位声明：dsh-client-ui-conversation/lib/client.js:18268-18271（kind:"list"，scope:"session"）
//   * 渲染位置：同文件 :16500-16503（`.headerActions` 容器，紧邻会话标题面包屑）
//   * 槽位契约快照：dsh-cordis-client-runner/lib/client.js:3495-3552
//
// 为什么这个文件长这样：
//   * 所有 client bundle 会被客户端拼成**一个脚本**执行
//     （实测事故：顶层 `const factory` 与别的 bundle 撞名 →
//      整个拼合脚本（含官方 bundle）起不来）。
//     所以顶层**零绑定**，注册必须内联成一条 `window.__ModuleLoader__.load({...})` 语句。
//   * 没有构建步骤，`require` 只解析 `react`；不 import 任何 dsh 包
//     （官方有现成的 writeClipboard，在 dsh-client-ui-primitives/lib/index.js:4551-4574，
//      但引 dsh 包会把「引不到 / 引错」变成整页起不来的风险，本文件自己实现同款降级链）。
//   * 槽位注册必须包 try/catch：register 抛错会**连带炸掉整个 apply()**，
//      官方 bundle 跟着一起死（槽位形状变了就抛，见下）。
window.__ModuleLoader__.load({
  id: '@zws/dsh-copy-session-id',
  factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
  const React = require('react')

  /** 本包 UI 文案的 locale 命名空间（随 slots.register 的 locale 选项绑到组件的 t 上）。 */
  const NS = 'copySessionId'
  /** 槽位注册用的 id：list 槽的「格子」标识，也是官方 owner 按 id 定位我们的唯一句柄。 */
  const ENTRY_ID = 'copy-session-id'
  /** 成功/失败提示停留时长（毫秒）。用户拍板 1500ms。 */
  const FEEDBACK_MS = 1500

  // ── 文案 ────────────────────────────────────────────────────────────────────
  // 字典写在 JS 里、apply 时 ctx.locale.register(NS, { zh, en })（官方
  // dsh-experimental-client-ui-agent-team 同款写法）；locale/*.json 只放插件页的
  // meta.title / meta.description，不放按钮文案 —— 浏览器半不读 JSON 文件。
  const zh = {
    label: '复制会话 ID：{id}',
    copied: '已复制',
    failed: '复制失败',
    empty: '当前没有会话 ID',
  }
  const en = {
    label: 'Copy session ID: {id}',
    copied: 'Copied',
    failed: 'Copy failed',
    empty: 'No session ID',
  }

  /** `{key}` 插值（官方字典也是这个形状，见 dsh-client-ui-conversation 的 "terminal.session"）。 */
  function fmt(text, params) {
    if (typeof text !== 'string') return ''
    if (params === undefined || params === null) return text
    return text.replace(/\{(\w+)\}/g, (match, key) => (params[key] === undefined ? match : String(params[key])))
  }

  /**
   * 取文案：优先框架注入的 `t`（注册时声明了 locale: NS），字典没注册或缺键时
   * 回退本文件自带的 zh —— 官方查找链缺键会**原样返回 key**
   * （dsh-client-locale/lib/types/client/index.d.ts:87-90 描述的查找链），
   * 页面不能退化成 "copied" 这种字符串。
   */
  function makeText(t) {
    return function text(key, params) {
      let out
      if (typeof t === 'function') {
        try { out = t(key) } catch (error) { out = undefined }
      }
      if (typeof out !== 'string' || out.length === 0 || out === key) out = zh[key]
      if (typeof out !== 'string') out = key
      return fmt(out, params)
    }
  }

  // ── 样式 ────────────────────────────────────────────────────────────────────
  // 直接用宿主 alias 令牌，主题切换自动翻转（令牌名见同机器上跑通的
  // @linxin666/dsh-client-ui-session-id 的 client bundle 内联 CSS）。
  const CSS =
    '.csi-btn{display:inline-flex;align-items:center;gap:6px;height:32px;min-width:32px;' +
    'padding:0 7px;border:none;border-radius:8px;flex:none;cursor:pointer;' +
    'background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);' +
    'font:inherit;font-size:12px;line-height:1;transition:background-color .12s,color .12s}' +
    '.csi-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));' +
    'color:var(--dsw-alias-label-primary,inherit)}' +
    '.csi-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.2))}' +
    '.csi-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-2,#fff),' +
    '0 0 0 4px var(--dsw-alias-brand-primary,#2563eb)}' +
    '.csi-btn:disabled{cursor:not-allowed;opacity:.45}' +
    '.csi-btn.csi-ok{color:var(--dsw-alias-state-success,#1a7f37)}' +
    '.csi-btn.csi-fail{color:var(--dsw-alias-state-error,#d1242f)}' +
    '.csi-glyph{display:block;flex:none}' +
    '.csi-status{white-space:nowrap;font-size:12px}'

  function ensureCss() {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css="copy-session-id"]')) return
    const tag = document.createElement('style')
    tag.dataset.plugin = 'copy-session-id'
    tag.dataset.pluginCss = 'copy-session-id'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  // ── 图标 ────────────────────────────────────────────────────────────────────
  // 用 createElement 建而不是 dangerouslySetInnerHTML：路径是常量，但没有任何理由
  // 让一个按钮去碰 HTML 解析器。
  function glyph(paths) {
    return React.createElement(
      'svg',
      {
        className: 'csi-glyph',
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      paths,
    )
  }

  /** 复制：前后两张纸。 */
  function copyIcon() {
    return glyph([
      React.createElement('path', { key: 'back', d: 'M15 7.5V6.8A2.3 2.3 0 0 0 12.7 4.5H6.3A2.3 2.3 0 0 0 4 6.8v6.4a2.3 2.3 0 0 0 2.3 2.3h.7' }),
      React.createElement('rect', { key: 'front', x: 9, y: 8.5, width: 11, height: 11, rx: 2.3 }),
    ])
  }

  /** 成功：对勾。 */
  function checkIcon() {
    return glyph([React.createElement('path', { key: 'tick', d: 'M4.5 12.5 9.5 17.5 19.5 6.5' })])
  }

  /** 失败：感叹号。失败必须**看得见**，不许静默吞错（这是用户拍板的要求）。 */
  function failIcon() {
    return glyph([
      React.createElement('circle', { key: 'ring', cx: 12, cy: 12, r: 9 }),
      React.createElement('path', { key: 'bang', d: 'M12 7.5V13.2M12 16.4h.01' }),
    ])
  }

  // ── 复制 ────────────────────────────────────────────────────────────────────
  /**
   * 三级降级链，**任何一级失败都必须让调用方看得见**：
   *   1. navigator.clipboard.writeText（现代路径，需要安全上下文 + 权限）
   *   2. 隐藏 textarea + document.execCommand('copy')（非安全上下文 / 旧内核）
   *   3. 都失败 → 返回 false，按钮显示「复制失败」
   *
   * 与官方 writeClipboard（dsh-client-ui-primitives/lib/index.js:4551-4574）同策略，
   * 差别是这里不吞错误（它只返回 true/false，本函数还多一层可见反馈在组件里）。
   * ⚠️ 写入内容是**纯 sessionId 原文**：不加前缀、不加后缀、不加换行、不加引号。
   * @returns Promise<boolean> 只有宿主真的接收了写入才是 true。
   */
  function writeClipboard(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && navigator.clipboard !== null &&
        typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(
        () => true,
        () => legacyCopy(text),
      )
    }
    return Promise.resolve(legacyCopy(text))
  }

  /** 老内核降级：临时 textarea 选中后 execCommand('copy')，元素一定回收。 */
  function legacyCopy(text) {
    try {
      if (typeof document === 'undefined') return false
      const exec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined
      if (exec === undefined) return false
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      try {
        return exec('copy') === true
      } finally {
        el.remove()
      }
    } catch {
      return false
    }
  }

  // ── 组件 ────────────────────────────────────────────────────────────────────
  /**
   * 会话标题栏的纯图标复制按钮。
   *
   * props（官方契约 dsh-cordis-client-runner/lib/client.js:3521-3539）：
   *   * `sessionId` —— session 作用域的**标准 props**，不是 owner props。
   *     来源链：dsh-client-ui-session/lib/client.js:121-130（BUILTIN_SOURCE 的 props:['sessionId']
   *     → resolve 返回 props:{ sessionId: binding.sessionId }）→ :391 `key: binding.sessionId`
   *     → dsh-client-ui-renderer/lib/client.js:659-681 standardProps 把 binding.props 摊进组件。
   *     类型是 `SessionId`，但运行时就是普通字符串
   *     （dsh-session/lib/index.js:13-15 → brandString → dsh-brand/lib/index.js:20-22 原样返回），
   *     所以下面仍保留 typeof 守卫，成本为零。
   *   * `t` —— 本槽位注册时声明了 `locale: NS`，框架合成的文案函数。
   *   * ⚠️ **没有 `view` 字段**：ownerProps 只有 marker（契约快照 :3521），
   *     先例注释里记的 `({ t, view })` 是配置页（plugins.bundle.config）的形状，别照抄。
   */
  function CopySessionIdButton(props) {
    // `props ?? {}`：官方渲染路径恒传对象，这里不可达；但一次可选链的成本，
    // 换掉「整个 header 的 entry boundary 报崩」（代价是本按钮不出现）——值得。
    const safe = props ?? {}
    const sessionId = typeof safe.sessionId === 'string' ? safe.sessionId : ''
    const t = makeText(safe.t)
    const [phase, setPhase] = React.useState('idle')
    const timerRef = React.useRef(0)

    /** 卸载或换会话时把待还原的定时器收掉：按钮已经不是那个按钮了，还它变对勾没意义。 */
    React.useEffect(() => () => {
      if (timerRef.current !== 0) {
        clearTimeout(timerRef.current)
        timerRef.current = 0
      }
    }, [])

    const onClick = React.useCallback(() => {
      // 会话还没拿到 ID（scope binding 缺 key 时官方会先抛，这里只是兜底）：点不动。
      if (sessionId === '') return
      if (timerRef.current !== 0) {
        clearTimeout(timerRef.current)
        timerRef.current = 0
      }
      setPhase('busy')
      writeClipboard(sessionId).then((ok) => {
        setPhase(ok ? 'copied' : 'failed')
        timerRef.current = setTimeout(() => {
          timerRef.current = 0
          setPhase('idle')
        }, FEEDBACK_MS)
      })
    }, [sessionId])

    const hasId = sessionId !== ''
    // tooltip / aria-label 带完整 ID：悬停就能核对复制对不对，同时不违背「不常驻显示文本」。
    const label = hasId ? t('label', { id: sessionId }) : t('empty')
    const status = phase === 'copied' ? t('copied') : phase === 'failed' ? t('failed') : ''

    return React.createElement(
      'button',
      {
        type: 'button',
        className: 'csi-btn' + (phase === 'copied' ? ' csi-ok' : phase === 'failed' ? ' csi-fail' : ''),
        title: label,
        'aria-label': label,
        disabled: !hasId,
        onClick,
        'data-copy-session-id': '',
      },
      phase === 'copied' ? checkIcon() : phase === 'failed' ? failIcon() : copyIcon(),
      status === '' ? null : React.createElement('span', { className: 'csi-status', role: 'status' }, status),
    )
  }

  // ── 挂载 ────────────────────────────────────────────────────────────────────
  /** 失败必须看得见（控制台），但绝不允许把异常抛回 apply() 外层。 */
  function warn(scope, error) {
    console.warn('[' + ENTRY_ID + '] ' + scope + ':', error)
  }

  function apply(ctx) {
    // 样式同样在 try/catch 里：document.head 缺失（或被换掉）时 ensureCss 会抛，
    // 而「按钮没样式」远好过「整个 apply() 连带官方 bundle 一起炸」。
    try {
      ensureCss()
    } catch (error) {
      warn('ensureCss', error)
    }
    const slots = ctx.slots
    if (slots === undefined || slots === null) return

    // 字典注册。locale 是声明过的硬依赖（见文件尾 exports.inject）。
    const locale = ctx.locale
    if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
      try {
        ctx.effect(() => locale.register(NS, { zh, en }), ENTRY_ID + ': dictionaries')
      } catch (error) {
        warn('locale.register', error)
      }
    }

    // 槽位注册。
    //
    // order = 100 的依据。
    //
    // (1) 排序方向：**升序**，数值越小越靠左。
    //     dsh-client-ui-slots/lib/index.js:221 → `(a.options.order ?? 0) - (b.options.order ?? 0)`；
    //     渲染侧再排一次 dsh-client-ui-renderer/lib/client.js:1181（`order: entry.options.order ?? 0`）
    //     与 :1193（`list.sort((a, b) => a.order - b.order)`），按序渲染进 `.headerActions`。
    //     契约快照也这么写：dsh-cordis-client-runner/lib/client.js:3499
    //     「Title-adjacent Session actions in ascending order.」、:3512
    //     「Position among the entries, ascending (default 0).」
    //
    // (2) 本槽位**四个官方占位者各自显式声明了 order**（不是默认 0）。逐个读自
    //     DSH 自带包根（<npm 全局>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/）下各自的 lib\client.js：
    //       subagent-catalog  order -30  ← dsh-client-ui-subagent\lib\client.js:968-971
    //       agent-team        order -20  ← dsh-experimental-client-ui-agent-team\lib\client.js:491-494
    //       agent-preset      order -10  ← dsh-client-ui-agent-preset\lib\client.js:1650-1653
    //       job-list          order  20  ← dsh-client-ui-jobs\lib\client.js:610-613
    //     官方给本槽位的**唯一注册示例**用的也是 order: 100（dsh-cordis-client-runner\lib\client.js:3551）。
    //
    // 结论：100 > 20，落在**已知最大 order 的右边** → 排序后位于
    // subagent-catalog(-30) → agent-team(-20) → agent-preset(-10) → job-list(20) → **copy-session-id(100)**，
    // 即 `.headerActions` 的最右端，在官方「智能体团队」（id 'agent-team'）的**右边**。
    //
    // 不取先例的 -19：那是团队插件用它**自己的不可见锚点**去贴着 TeamAction 的 order 打补丁的
    // 内部约定（它锚在 -19/-20 之间），跟一个用户可见按钮的语义位置是两回事。
    //
    // ⚠️ 整段包 try/catch：槽位形状若变了（比如 list 改成要 key 的 keyed），
    //    register 抛错会**连带炸掉整个 apply()**，官方 bundle 跟着死。
    //    一个复制按钮坏了只该是「按钮不出现」，不该是「页面打不开」。
    try {
      ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions',
        id: ENTRY_ID,
        order: 100,
        locale: NS,
      }, CopySessionIdButton)), ENTRY_ID + ': header button')
    } catch (error) {
      warn('slot register', error)
    }
  }

  exports.name = 'dsh-copy-session-id-client'
  exports.inject = ['slots', 'locale']
  exports.apply = apply
  return module.exports
  },
})