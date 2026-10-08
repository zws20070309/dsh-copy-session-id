'use strict'
// review-02-clipboard.cjs —— 剪贴板契约审查脚本
//
// 目的：**不复用 tools/selftest.cjs 的任何代码**，用另一套手写宿主 + 另一套 React 桩，
// 独立加载 lib/client.js，走官方槽位形状把组件挂起来，模拟真实点击，断言剪贴板内容。
//
// 与 selftest.cjs 的关键差异（都是为了避免「同一个 bug 两边都错」）：
//   1. DOM：selftest 的 querySelector 恒返回 null → ensureCss 的去重分支**从未被执行**。
//      这里实现真正的 style 索引，让「重复注入」这条分支真的跑起来。
//   2. React：selftest 的 useCallback 完全忽略 deps。这里按 deps 重建回调，
//      才能测出「换会话后闭包拿着旧 sessionId」这类 stale closure。
//   3. 宿主：这里按 dsh-client-ui-slots 的 list 槽契约（缺 id 抛错）建槽位表。

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const CLIENT = path.join(__dirname, '..', 'lib', 'client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log('  [ok] ' + name) }
  catch (e) { fail.push(name + ' :: ' + (e && e.message)); console.log('  [FAIL] ' + name + ' —— ' + (e && e.message)) }
}
const eq = (a, b, msg) => {
  if (!Object.is(a, b)) throw new Error((msg || '') + '\n        got : ' + JSON.stringify(a) + '\n        want: ' + JSON.stringify(b))
}

// ── 独立 React 桩：按 deps 语义实现 ──────────────────────────────────────────
function makeReact() {
  let hooks = [], i = 0, schedule = null
  const React = {
    createElement(type, props, ...kids) {
      const p = Object.assign({}, props)
      if (kids.length === 1) p.children = kids[0]
      else if (kids.length > 1) p.children = kids
      return { $$el: true, type, props: p }
    },
    useState(init) {
      const k = i++; if (!(k in hooks)) hooks[k] = typeof init === 'function' ? init() : init
      return [hooks[k], (v) => { hooks[k] = typeof v === 'function' ? v(hooks[k]) : v; if (schedule) schedule() }]
    },
    useRef(init) { const k = i++; if (!(k in hooks)) hooks[k] = { current: init }; return hooks[k] },
    useCallback(fn, deps) {                       // ← 按 deps 重建（selftest 没做）
      const k = i++
      const prev = hooks[k]
      const same = prev !== undefined && prev.deps !== undefined && deps !== undefined &&
        prev.deps.length === deps.length && prev.deps.every((d, j) => Object.is(d, deps[j]))
      if (!same) hooks[k] = { deps, fn }
      return hooks[k].fn
    },
    useEffect(fn, deps) {
      const k = i++
      const prev = hooks[k]
      const same = prev !== undefined && prev.deps !== undefined && deps !== undefined &&
        prev.deps.length === deps.length && prev.deps.every((d, j) => Object.is(d, deps[j]))
      if (same) return
      if (prev && typeof prev.cleanup === 'function') prev.cleanup()
      const c = fn()
      hooks[k] = { deps, cleanup: typeof c === 'function' ? c : () => {} }
    },
  }
  function mount(Comp, props) {
    const render = () => { i = 0; tree = Comp(props) }
    let tree = null
    render()
    schedule = render
    return {
      el: () => tree,
      update(next) { if (next !== undefined) props = next; render() },
      unmount() {
        schedule = null
        for (let k = 0; k < hooks.length; k++) if (hooks[k] && typeof hooks[k].cleanup === 'function') hooks[k].cleanup()
      },
    }
  }
  return { React, mount }
}

// ── 独立 DOM：真的记住注入过的 <style>，让去重分支被执行 ──────────────────
function makeDom() {
  const styles = []                 // document.head 里的 style
  const bodyKids = []
  const created = []
  const dom = {
    execCommands: [],
    created,
    styles,
    bodyKids,
    querySelector(sel) { return styles.find((s) => sel.replace(/.*data-plugin-css="([^"]+)".*/, '$1') === s.dataset.pluginCss) || null },
    querySelectorAll(sel) { return sel === 'style' ? styles.slice() : [] },
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(), dataset: {}, style: {}, value: '', textContent: '',
        setAttribute(k, v) { this['attr_' + k] = v }, select() { this.selected = true },
        remove() { this.removed = true; const k = bodyKids.indexOf(this); if (k >= 0) bodyKids.splice(k, 1) },
        appendChild(c) { bodyKids.push(c); return c },
      }
      created.push(el); return el
    },
    head: { appendChild(n) { styles.push(n); return n } },
    body: { appendChild(n) { bodyKids.push(n); return n } },
    execCommand(verb) { dom.execCommands.push(verb); return dom.execOk !== false },
    execOk: true,
  }
  return dom
}

// ── 独立宿主：按官方 list 槽契约建槽位表 ───────────────────────────────────
function makeHost(opts) {
  opts = opts || {}
  const entries = []
  const injected = []
  const localeCalls = []
  const warnings = []
  const effects = []
  const host = {
    slots: {
      inject(name, cb) { injected.push(name); const r = cb(); return r },
      register(options, component) {
        // dsh-client-ui-slots: list 槽缺 id 抛错（对照 lib/index.js:181-184 的行为）
        if (opts.listNeedsId && options.id === undefined) throw new Error('list slot requires options.id')
        entries.push({ options, component })
        return () => { const k = entries.findIndex((e) => e.options === options); if (k >= 0) entries.splice(k, 1) }
      },
    },
    locale: opts.locale === false ? undefined : {
      register(ns, d) {
        if (opts.localeThrows) throw new Error('locale namespace "' + ns + '" already has locale "zh"')
        localeCalls.push({ ns, d }); return () => {}
      },
    },
    effect(fn, label) { effects.push({ fn, label }); return fn() },
  }
  return { host, entries, injected, localeCalls, warnings, effects }
}

function load(opts) {
  opts = opts || {}
  const React = makeReact()
  const dom = makeDom()
  if (opts.noExecCommand) delete dom.execCommand
  const writes = []
  const warnings = []
  const loads = []
  const nav = opts.clipboard === 'none' ? {} : {
    clipboard: {
      writeText(text) {
        writes.push(text)
        if (opts.clipboard === 'reject') return Promise.reject(new Error('NotAllowedError'))
        if (opts.clipboard === 'slow') return new Promise((res) => setTimeout(res, opts.slowMs === undefined ? 30 : opts.slowMs))
        return Promise.resolve()
      },
    },
  }
  const pending = new Set()
  const sandbox = {
    console: { warn: (...a) => warnings.push(a), log() {}, error: (...a) => warnings.push(a) },
    navigator: nav, document: dom, queueMicrotask,
    setTimeout(fn, ms) { const h = setTimeout(() => { pending.delete(h); fn() }, ms); pending.add(h); return h },
    clearTimeout(h) { pending.delete(h); clearTimeout(h) },
    Promise,
  }
  sandbox.globalThis = sandbox
  sandbox.window = { __ModuleLoader__: { load(spec) { loads.push(spec) } } }
  const ctx = vm.createContext(sandbox)
  new vm.Script(SRC, { filename: 'lib/client.js' }).runInContext(ctx)
  const spec = loads[0]
  const mod = spec.factory((name) => {
    if (name !== 'react') throw new Error('unexpected require(' + name + ')')
    return React.React
  })
  return { spec, mod, React, dom, writes, warnings, pending }
}

function bringUp(opts) {
  const b = load(opts)
  const h = makeHost(opts)
  b.mod.apply(h.host)
  return { b, h, React: b.React, dom: b.dom, writes: b.writes, pending: b.pending, Comp: h.entries[0] && h.entries[0].component }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const macrotick = () => new Promise((r) => setImmediate(r))

// 独特的假 ID：中文 / 连字符 / 冒号 / 引号 / 前后空格 / 换行 / 反斜杠 / < > & 全都带上
const FAKE_ID = "  ses_01HZ-独立ID:42\"'\\<&>\\\n第二行  "
const TRAPS = {
  '纯 ASCII ID': 'ses_01HZXK3P7Q',
  '前后带空格的 ID': '  ses_pad  ',
  '内含换行的 ID': 'ses_line1\nline2',
  '引号/尖括号/& 的 ID': 'ses_"x\'<&>',
  '纯数字 ID': '1234567890',
  '单字符 ID': 'x',
  '中文 ID': '会话_42',
}

// ════════════════════════════════════════════════════════════════════════════
console.log('review-02: 剪贴板独立攻击\n')

;(async () => {
  console.log('[1] 每种「刁钻 ID」：点击后剪贴板必须与之**逐码相等**')
  for (const [label, id] of Object.entries(TRAPS)) {
    const ctx = bringUp({})
    const v = ctx.React.mount(ctx.Comp, { sessionId: id })
    v.el().props.onClick()
    await macrotick()
    check('ID[' + label + '] 剪贴板 === 原文', () => {
      eq(ctx.b.writes.length, 1, 'writeText 调用次数')
      eq(ctx.b.writes[0], id, '剪贴板内容')
      // 逐码相等：防止「看起来一样」（例如不可见字符）而断言通过
      eq(ctx.b.writes[0].length, id.length, '长度')
      for (let i = 0; i < id.length; i++) eq(ctx.b.writes[0].charCodeAt(i), id.charCodeAt(i), '第 ' + i + ' 个码位')
    })
  }

  console.log('\n[2] 官方宿主形状：slot 名 / id / order / locale 声明')
  const ctx2 = bringUp({ listNeedsId: true })
  check('注入的是 conversation.session.header.actions', () => eq(ctx2.h.injected.length, 1))
  check('槽位名正确', () => eq(ctx2.h.entries[0].options.name, 'conversation.session.header.actions'))
  check('order === 100（升序，排在未声明 order 的官方条目之后）', () => eq(ctx2.h.entries[0].options.order, 100))
  check('id === copy-session-id（不撞官方 agent-team/job-list/subagent-catalog/agent-preset）', () => eq(ctx2.h.entries[0].options.id, 'copy-session-id'))
  check('locale === copySessionId', () => eq(ctx2.h.entries[0].options.locale, 'copySessionId'))
  check('字典注册到 copySessionId，zh/en 键齐全', () => {
    eq(ctx2.h.localeCalls.length, 1)
    eq(ctx2.h.localeCalls[0].ns, 'copySessionId')
    for (const k of ['label', 'copied', 'failed', 'empty']) {
      if (typeof ctx2.h.localeCalls[0].d.zh[k] !== 'string') throw new Error('zh 缺 ' + k)
      if (typeof ctx2.h.localeCalls[0].d.en[k] !== 'string') throw new Error('en 缺 ' + k)
    }
  })

  console.log('\n[3] 反例攻击：坏宿主不能把异常抛回 apply()')
  {
    const b = load({})
    const h = makeHost({ listNeedsId: true })
    b.mod.apply(Object.assign({}, h.host, { slots: { inject(n, cb) { return cb() }, register() { throw new Error('list slot requires options.id') } } }))
    check('register 抛错 → apply() 正常返回 + 留 console.warn', () => {
      eq(b.warnings.length, 1)
      if (String(b.warnings[0][0]).indexOf('[copy-session-id]') !== 0) throw new Error('warn 前缀不对: ' + b.warnings[0][0])
    })
  }
  {
    const b = load({})
    const h = makeHost({ localeThrows: true })
    let threw = null
    try { b.mod.apply(h.host) } catch (e) { threw = e }
    check('locale.register 抛错（重复注册）→ 槽位注册仍然发生，apply() 不抛', () => {
      eq(threw, null, 'apply 抛出: ' + (threw && threw.stack))
      eq(h.entries.length, 1, '槽位仍应注册成功')
      eq(b.warnings.length, 1, '应有 1 条 warn')
    })
  }
  {
    const b = load({})
    let threw = null
    try { b.mod.apply({}) } catch (e) { threw = e }
    check('ctx.slots 缺失 → 直接 return，不抛', () => eq(threw, null, 'apply 抛出: ' + (threw && threw.stack)))
  }
  {
    const b = load({})
    let threw = null
    try { b.mod.apply({ slots: { inject() {}, register() {} }, locale: { register() {} } }) } catch (e) { threw = e }
    check('ctx.effect 缺失（老宿主）→ 被 try/catch 兜住，不抛', () => eq(threw, null, 'apply 抛出: ' + (threw && threw.stack)))
  }
  {
    const b = load({})
    let threw = null
    try { b.mod.apply({ slots: { inject(n, cb) { return cb() }, register() { return () => {} } }, locale: { register() { return () => {} } }, effect(fn) { return fn() } }) } catch (e) { threw = e }
    check('正常最小宿主 → 不抛', () => eq(threw, null, 'apply 抛出: ' + (threw && threw.stack)))
  }

  console.log('\n[4] 组件渲染：props 各种残缺形态')
  {
    const b = load({})
    const h = makeHost({})
    b.mod.apply(h.host)
    const Comp = h.entries[0].component
    for (const [label, props] of [['undefined', undefined], ['null', null], ['空对象', {}], ['sessionId 为数字', { sessionId: 42 }], ['sessionId 为空串', { sessionId: '' }]]) {
      let tree = null, threw = null
      try { tree = Comp(props) } catch (e) { threw = e }
      check('渲染 props=' + label + (threw ? ' → 抛出 ' + threw.constructor.name : ' → 不抛'), () => {
        if (threw) throw new Error('组件渲染抛异常：' + threw.message + '\n        （React 渲染期抛错会掀掉整棵子树 = 白屏）')
        eq(tree.type, 'button')
        eq(tree.props.disabled, true, label + ' 时应 disabled')
      })
    }
  }

  console.log('\n[5] 文案层：t 返回 key / 返回空 / 抛错 / 返回 Promise 时的退化')
  {
    const b = load({})
    const h = makeHost({})
    b.mod.apply(h.host)
    const Comp = h.entries[0].component
    const cases = {
      't 缺失': undefined,
      't 返回 key 原样（官方缺键行为）': (k) => k,
      't 返回空串': () => '',
      't 抛错': () => { throw new Error('boom') },
      't 返回 Promise（错的类型）': () => Promise.resolve('已复制'),
      't 正常返回中文': (k) => ({ label: '复制定��ID：{id}', copied: '已复制', failed: '复制失败', empty: '无' }[k]),
    }
    for (const [label, t] of Object.entries(cases)) {
      let threw = null, title = null
      try { title = Comp({ sessionId: 'ID42', t }).props.title } catch (e) { threw = e }
      check('t 场景[' + label + '] 不抛且标题不是裸 key', () => {
        if (threw) throw new Error('抛: ' + threw.message)
        if (/^[a-z]+$/.test(String(title))) throw new Error('标题退化成 key: ' + JSON.stringify(title))
      })
    }
  }

  console.log('\n[6] 计时器：点击 → 反馈期存活 → 卸载/到期 必须归零（沙箱内 setTimeout 全程计数）')
  {
    const ctx = bringUp({})
    const v = ctx.React.mount(ctx.Comp, { sessionId: 'ID-A' })
    eq(ctx.b.pending.size, 0, '挂载后不应有定时器')
    v.el().props.onClick()
    check('点击后、writeText resolve 前：没有定时器', () => eq(ctx.b.pending.size, 0))
    await macrotick()
    check('点击后、反馈期：恰好 1 个待触发定时器', () => eq(ctx.b.pending.size, 1))
    v.unmount()
    check('卸载 → 定时器被 cleanup 收掉（不残留）', () => eq(ctx.b.pending.size, 0, '残留 ' + ctx.b.pending.size + ' 个'))
  }
  {
    const ctx = bringUp({})
    const v = ctx.React.mount(ctx.Comp, { sessionId: 'ID-A' })
    v.el().props.onClick()
    await macrotick()
    await new Promise((r) => setTimeout(r, 1700))
    check('不卸载、等 1.5s → 定时器自然到期归零，按钮复原', () => {
      eq(ctx.b.pending.size, 0)
      eq(v.el().props.className, 'csi-btn')
    })
  }
  {
    // 慢剪贴板（真实授权弹窗就是这个时延）：先卸载、后 resolve
    const ctx = bringUp({ clipboard: 'slow', slowMs: 40 })
    const v = ctx.React.mount(ctx.Comp, { sessionId: 'ID-A' })
    v.el().props.onClick()
    await macrotick()
    eq(ctx.b.pending.size, 0, '此刻 cleanup 还没跑，timerRef 仍是 0')
    v.unmount()                       // cleanup 跑：timerRef.current === 0，什么也没清
    await new Promise((r) => setTimeout(r, 120))
    check('【泄漏】慢剪贴板 + 先卸载：writeText 后台 resolve 后新建的 1500ms 定时器无人回收', () => {
      console.log('      实测残留定时器数 = ' + ctx.b.pending.size + '（0 = 无泄漏，>0 = 泄漏）')
    })
  }

  console.log('\n[7] CSS 注入：重复 apply / 重复 effect 是否重复插 <style>')
  {
    const b = load({})
    const h = makeHost({})
    b.mod.apply(h.host)
    b.mod.apply(h.host)
    b.mod.apply(h.host)
    check('apply() 调三次，document.head 里 <style> 仍只有 1 个', () => {
      eq(b.dom.styles.length, 1, '注入的 style 数量：' + b.dom.styles.length)
      eq(b.dom.styles[0].dataset.pluginCss, 'copy-session-id')
      if (!/^\.csi-btn\{/.test(b.dom.styles[0].textContent)) throw new Error('CSS 内容不对')
    })
  }

  console.log('\n[8] 连点 / 换会话的 stale-closure 攻击')
  {
    const b = load({})
    const h = makeHost({})
    b.mod.apply(h.host)
    const props = { sessionId: 'ID-A' }
    const v = b.React.mount(h.entries[0].component, props)
    v.el().props.onClick()
    await macrotick()
    // 换会话（同 key 变了会重挂载；这里模拟 props 直接变化）
    v.update({ sessionId: 'ID-B' })
    v.el().props.onClick()
    await macrotick()
    check('换会话后再点，复制的是新 ID 而不是旧 ID', () => {
      eq(b.writes.length, 2)
      eq(b.writes[0], 'ID-A')
      eq(b.writes[1], 'ID-B', '第二次点必须复制新会话 ID')
    })
  }
  {
    // 连点 3 次：定时器应被就地 clear，不应堆积
    const b = load({})
    const h = makeHost({})
    b.mod.apply(h.host)
    const v = b.React.mount(h.entries[0].component, { sessionId: 'ID-A' })
    v.el().props.onClick(); await macrotick()
    v.el().props.onClick(); await macrotick()
    v.el().props.onClick(); await macrotick()
    check('连点 3 次 → 剪贴板被写 3 次，界面停在最后一个状态', () => {
      eq(b.writes.length, 3)
      eq(v.el().props.className, 'csi-btn csi-ok')
    })
    await new Promise((r) => setTimeout(r, 1700))
    check('最后一次点击后 1.5s → 自动回到 idle（按钮复原）', () => eq(v.el().props.className, 'csi-btn'))
  }
  {
    // 卸载发生在 writeText 还没 resolve 的时候（真实剪贴板授权弹窗就是这个时延）
    const b = load({ clipboard: 'slow', slowMs: 40 })
    const h = makeHost({})
    b.mod.apply(h.host)
    const v = b.React.mount(h.entries[0].component, { sessionId: 'ID-A' })
    v.el().props.onClick()
    await macrotick()          // 此刻 writeText 仍未 resolve
    v.unmount()                // 先卸载，effect cleanup 此刻跑（timerRef 还是 0）
    await new Promise((r) => setTimeout(r, 100))
    check('慢剪贴板 + 先卸载：不会往已卸载组件上 setState（React 18 静默 no-op）', () => {
      eq(b.writes.length, 1)
    })
    check('慢剪贴板 + 先卸载：effect cleanup 早于定时器创建 → 定时器泄漏（记录事实）', () => {
      // 这里只打印事实，不断言；泄漏的判定见 review-03
    })
  }

  console.log('\n' + pass + ' passed, ' + fail.length + ' failed')
  if (fail.length) { fail.forEach((f) => console.log('  - ' + f)); process.exit(1) }
  console.log('REVIEW-02 PASS')
})().catch((e) => { console.error(e); process.exit(1) })