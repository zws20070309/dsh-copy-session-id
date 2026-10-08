'use strict'
// 复制会话 ID —— 浏览器半离线自测（无外网、无 DSH 运行时、无 node_modules 依赖）。
//
// 它证明的是「这份 bundle 挂上去会不会炸 + 复制到的到底是不是纯会话 ID」，
// 不是「DSH 里显示好不好看」。真机验收请另见 README。
//
// 做法：把 lib/client.js 当成**普通脚本**在一个假全局里跑一遍 —— 这正是浏览器里的真实形态
// （客户端把所有 client bundle 拼成一个脚本执行，lib/client.js 顶层零绑定）。
// 不走 require()：本包是 "type":"module"，require() 会改变语义。
//
// 用法：node tools/selftest.cjs

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const PKG = '@zws/dsh-copy-session-id'
const SLOT = 'conversation.session.header.actions'
// 独特的假 ID：带中文、带连字符、带冒号，任何前缀/后缀/换行/引号都会让全文相等断言失败。
const FAKE_ID = 'ses_01HZ-SELFTEST-唯一ID_42'

let passed = 0
const failures = []
/**
 * 跑一条断言。**必须 await fn()**：断言体里可以有 async（点击复制是 Promise），
 * 不同步 await 的话这条断言会在它真正执行前就被记成 [ok] 并计入 passed ——
 * 汇总行就成了假账（tools/review-03-mutation.cjs 的变异测试可以证伪这种写法）。
 * 所以本函数是 async，调用点一律 `await check(...)`，断言按书写顺序串行结算。
 */
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  [ok] ' + name)
  } catch (error) {
    failures.push({ name: name, error: error })
    console.log('  [FAIL] ' + name + ' —— ' + (error && error.message))
  }
}

// ── 假 react ────────────────────────────────────────────────────────────────
// 只需要本文件真正用到的那几个 API；createElement 返回普通对象树（不碰 DOM），
// Hook 用一个极小的 slot 数组模拟，并支持 setState 触发重渲染 —— 真实 React 也是这个语义。
function makeReact() {
  let slots = []
  let cursor = 0
  let rerenderHook = null

  function createElement(type, props) {
    const rest = Array.prototype.slice.call(arguments, 2)
    const p = Object.assign({}, props)
    if (rest.length === 1) p.children = rest[0]
    else if (rest.length > 1) p.children = rest
    return { type: type, props: p }
  }

  const React = {
    createElement: createElement,
    useState(initial) {
      const i = cursor
      cursor += 1
      if (!Object.prototype.hasOwnProperty.call(slots, i)) {
        slots[i] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(slots[i]) : next
        slots[i] = value
        if (typeof rerenderHook === 'function') rerenderHook()
      }
      return [slots[i], setState]
    },
    useRef(initial) {
      const i = cursor
      cursor += 1
      if (!Object.prototype.hasOwnProperty.call(slots, i)) slots[i] = { current: initial }
      return slots[i]
    },
    useCallback(fn) { return fn },
    useEffect(fn, deps) {
      const i = cursor
      cursor += 1
      const key = JSON.stringify(deps === undefined ? null : deps)
      const prev = slots[i]
      if (prev !== undefined && prev.deps === key) return
      if (prev !== undefined && typeof prev.cleanup === 'function') prev.cleanup()
      slots[i] = { deps: key, cleanup: fn() }
    },
  }

  /** 挂载一个组件，返回 { element(), rerender(), unmount() }。 */
  function mount(Comp, props) {
    cursor = 0
    let out = Comp(props)
    const rerender = () => {
      cursor = 0
      out = Comp(props)
    }
    rerenderHook = rerender
    return {
      element: () => out,
      rerender: rerender,
      unmount: () => {
        rerenderHook = null
        for (let i = 0; i < slots.length; i += 1) {
          if (slots[i] !== undefined && typeof slots[i].cleanup === 'function') slots[i].cleanup()
        }
      },
    }
  }

  return { React: React, mount: mount }
}

// ── 假 DOM ──────────────────────────────────────────────────────────────────
function makeDom() {
  const appended = { head: [], body: [] }
  const node = (tag) => ({
    tagName: tag,
    dataset: {},
    style: {},
    value: '',
    textContent: '',
    setAttribute() {},
    select() { this.selected = true },
    remove() { this.removed = true },
    appendChild(child) { appended.body.push(child); return child },
  })
  return {
    execCommandResult: true,
    execCommandCalls: [],
    appended: appended,
    createElement: (tag) => node(tag),
    // 只认一种选择器：`style[data-plugin-css="<id>"]`。ensureCss 的去重就靠它，
    // 返回恒 null 会让「去重有效」这条断言失去意义（见 (c3)）。
    querySelector(selector) {
      const m = /^style\[data-plugin-css="([^"]+)"\]$/.exec(selector)
      if (m === null) return null
      return appended.head.find((x) => x.dataset.pluginCss === m[1]) || null
    },
    head: {
      appendChild(child) { appended.head.push(child); return child },
    },
    body: {
      appendChild(child) { appended.body.push(child); return child },
    },
    execCommand(verb) {
      this.execCommandCalls.push(verb)
      return this.execCommandResult
    },
  }
}

// ── 载入 bundle ─────────────────────────────────────────────────────────────
const CLIENT_PATH = path.join(__dirname, '..', 'lib', 'client.js')
const source = fs.readFileSync(CLIENT_PATH, 'utf8')

function loadBundle(options) {
  const opts = options || {}
  const React = makeReact()
  const dom = makeDom()
  const writes = []
  const warnings = []
  const loads = []

  const navigator = opts.clipboard === 'none'
    ? {}
    : {
        clipboard: {
          writeText(text) {
            writes.push(text)
            if (opts.clipboard === 'reject') return Promise.reject(new Error('NotAllowedError'))
            return Promise.resolve()
          },
        },
      }
  if (opts.noExecCommand) delete dom.execCommand
  if (opts.noHead) delete dom.head

  // 插桩的定时器：既真跑（验证 1500ms 到期确实会还原按钮），又留账
  // （created 记每次时长，pending 记还挂着的，cleared 记被收掉的）。
  const timers = { created: [], pending: [], cleared: [], seq: 0 }
  const handles = new Map()
  const fakeSetTimeout = (fn, delay) => {
    const id = ++timers.seq
    timers.created.push({ id: id, delay: delay, fn: fn })
    const handle = setTimeout(() => {
      const i = timers.pending.indexOf(id)
      if (i >= 0) timers.pending.splice(i, 1)
      fn()
    }, delay)
    handles.set(id, handle)
    timers.pending.push(id)
    return id
  }
  const fakeClearTimeout = (id) => {
    const i = timers.pending.indexOf(id)
    if (i >= 0) timers.pending.splice(i, 1)
    timers.cleared.push(id)
    const handle = handles.get(id)
    if (handle !== undefined) clearTimeout(handle)
  }

  const sandbox = {
    console: { warn: (...args) => warnings.push(args), log: () => {}, error: (...args) => warnings.push(args) },
    navigator: navigator,
    document: dom,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    Promise: Promise,
    window: {
      __ModuleLoader__: {
        load(spec) { loads.push(spec) },
      },
    },
  }
  sandbox.globalThis = sandbox

  const context = vm.createContext(sandbox)
  vm.runInContext(source, context, { filename: 'lib/client.js' })

  assert.equal(loads.length, 1, 'bundle 必须且只能调用一次 __ModuleLoader__.load')
  const spec = loads[0]
  const module_ = spec.factory((name) => {
    if (name !== 'react') throw new Error('unexpected require(' + name + ') —— 本 bundle 只应 require("react")')
    return React.React
  })

  return {
    spec: spec,
    exports: module_,
    React: React,
    dom: dom,
    writes: writes,
    warnings: warnings,
    timers: timers,
  }
}

function applyTo(ctx) {
  const bundle = loadBundle(ctx)
  const registered = []
  const injected = []
  const localeCalls = []
  const host = {
    slots: {
      inject(name, callback) { injected.push(name); return callback() },
      register(options, component) { registered.push({ options: options, component: component }); return () => {} },
    },
    locale: {
      register(ns, dicts) { localeCalls.push({ ns: ns, dicts: dicts }); return () => {} },
    },
    effect(fn) { fn(); return () => {} },
  }
  bundle.exports.apply(host)
  return { bundle: bundle, registered: registered, injected: injected, localeCalls: localeCalls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// ── 断言 ────────────────────────────────────────────────────────────────────
// 全部串行跑在一个 async IIFE 里：check() 是 async，调用点必须 await，
// 这样「汇总行」跑出来的时候所有断言真的都结算过了。
;(async () => {
console.log('selftest: ' + PKG)
console.log('client bundle: ' + CLIENT_PATH)

console.log('\n(a) bundle 注册形态')
const a = applyTo({})
await check('__ModuleLoader__.load 的 id === ' + JSON.stringify(PKG), () => {
  assert.equal(a.bundle.spec.id, PKG)
})
await check('factory 返回 name / inject / apply', () => {
  assert.equal(a.bundle.exports.name, 'dsh-copy-session-id-client')
  // 数组来自 vm realm，原型不同，深比较必须先搬到本 realm（Array.from 在本 realm 建数组）。
  assert.deepEqual(Array.from(a.bundle.exports.inject), ['slots', 'locale'])
  assert.equal(typeof a.bundle.exports.apply, 'function')
})
await check('顶层零绑定：把同一份 bundle 并排跑两遍不撞名（客户端就是把多个 bundle 拼成一个脚本）', () => {
  const sandbox = {
    console: { warn() {}, log() {} },
    navigator: {},
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    setTimeout, clearTimeout, Promise,
    window: { __ModuleLoader__: { load() {} } },
  }
  sandbox.globalThis = sandbox
  // 撞名会直接 SyntaxError: Identifier 'x' has already been declared
  vm.runInContext(source + '\n' + source, vm.createContext(sandbox), { filename: 'doubled.js' })
})
await check('locale 字典注册到命名空间 copySessionId', () => {
  assert.equal(a.localeCalls.length, 1)
  assert.equal(a.localeCalls[0].ns, 'copySessionId')
  assert.equal(typeof a.localeCalls[0].dicts.zh.label, 'string')
  assert.equal(typeof a.localeCalls[0].dicts.en.label, 'string')
})

console.log('\n(b) 槽位注册')
await check('slots.inject 的槽名 === ' + SLOT, () => {
  assert.deepEqual(a.injected, [SLOT])
})
await check('slots.register 带 name + id（list 槽缺 id 会抛，见 dsh-client-ui-slots/lib/index.js:181-184）', () => {
  assert.equal(a.registered.length, 1)
  assert.equal(a.registered[0].options.name, SLOT)
  assert.equal(a.registered[0].options.id, 'copy-session-id')
  assert.equal(typeof a.registered[0].component, 'function')
})
await check('order = 100（升序；官方四条实测 -30/-20/-10/20，100 落在最右端，即「智能体团队」按钮右边）', () => {
  assert.equal(a.registered[0].options.order, 100)
})
await check('槽位注册声明 locale，组件拿到 t', () => {
  assert.equal(a.registered[0].options.locale, 'copySessionId')
})
await check('正常路径不产生任何 console 警告（没有静默吞错，也没有注册失败）', () => {
  assert.deepEqual(a.bundle.warnings, [])
})

console.log('\n(c) 点击 → 复制纯会话 ID 原文')
async function clipboardCase(name, options, expected) {
  const ctx = applyTo(options)
  const Comp = ctx.registered[0].component
  const view = ctx.bundle.React.mount(Comp, { sessionId: FAKE_ID, t: undefined })

  const first = view.element()
  assert.equal(first.type, 'button')
  assert.equal(typeof first.props.onClick, 'function')
  assert.equal(first.props.disabled, false)
  // tooltip / aria-label 带完整 ID：不常驻显示文本，但悬停能核对。
  assert.equal(first.props.title, '复制会话 ID：' + FAKE_ID)
  assert.equal(first.props['aria-label'], '复制会话 ID：' + FAKE_ID)

  first.props.onClick()
  await tick()
  view.rerender()
  const after = view.element()

  await check(name + '：按钮进入反馈态并显示可见提示', () => {
    assert.notEqual(after.props.className, first.props.className)
    assert.equal(typeof after.props.children, 'object')
    assert.equal(after.props.children[1].props.role, 'status')
    assert.equal(after.props.children[1].props.children, expected.status)
  })
  await check(name + '：反馈期定时器恰好 1 个，且时长就是 FEEDBACK_MS = 1500', () => {
    assert.equal(ctx.bundle.timers.pending.length, 1, '反馈期应恰好挂 1 个定时器')
    assert.equal(ctx.bundle.timers.created[0].delay, 1500, 'FEEDBACK_MS 被改过？')
  })
  if (options.clipboard !== 'none' && options.clipboard !== 'reject') {
    await check(name + '：clipboard 收到的是**纯 sessionId 原文**（全文相等，无前后缀/换行/引号）', () => {
      assert.equal(ctx.bundle.writes.length, 1)
      assert.equal(ctx.bundle.writes[0], FAKE_ID)
      assert.equal(JSON.stringify(ctx.bundle.writes[0]), JSON.stringify(FAKE_ID))
    })
  }
  if (options.clipboard === 'reject' && options.noExecCommand !== true) {
    await check(name + '：降级到 execCommand，且 textarea 里也是原文', () => {
      assert.equal(ctx.bundle.writes.length, 1, 'writeText 被尝试过')
      assert.equal(JSON.stringify(ctx.bundle.writes[0]), JSON.stringify(FAKE_ID))
      assert.deepEqual(ctx.bundle.dom.execCommandCalls, ['copy'])
      const ta = ctx.bundle.dom.appended.body[ctx.bundle.dom.appended.body.length - 1]
      assert.equal(ta.value, FAKE_ID)
      assert.equal(ta.removed, true, '临时 textarea 必须回收')
    })
  }
  if (options.clipboard === 'reject' && options.noExecCommand === true) {
    await check(name + '：两级都失败 → 明确显示「复制失败」，不静默', () => {
      assert.deepEqual(ctx.bundle.dom.execCommandCalls, [])
    })
  }
  return ctx
}

// 真正的断言体内做 await：既验证「等定时器到期后按钮复原」，也验证「到期前不复原」。
await clipboardCase('navigator.clipboard 成功', {}, { status: '已复制' })
await clipboardCase('writeText 被拒 → execCommand 降级', { clipboard: 'reject' }, { status: '已复制' })
await clipboardCase('两级都失败 → 复制失败', { clipboard: 'reject', noExecCommand: true }, { status: '复制失败' })
await clipboardCase('压根没有 clipboard API → execCommand 降级', { clipboard: 'none' }, { status: '已复制' })

console.log('\n(c2) 反馈期结束：定时器到期后按钮复原，卸载后不残留')
{
  const ctx = applyTo({})
  const view = ctx.bundle.React.mount(ctx.registered[0].component, { sessionId: FAKE_ID })
  view.element().props.onClick()
  await tick()
  view.rerender()
  assert.equal(view.element().props.className, 'csi-btn csi-ok')
  await check('1500ms 到期后自动回到 idle（图标还原、提示消失）', async () => {
    // 真等 1500ms：这条断言就是要证明「时长真的是 1500」，等不到就说明 FEEDBACK_MS 被改过。
    await new Promise((resolve) => setTimeout(resolve, 1600))
    view.rerender()
    assert.equal(ctx.bundle.timers.pending.length, 0, '到期后不应还有挂着的定时器')
    assert.equal(view.element().props.className, 'csi-btn', '按钮应还原成未激活态')
    assert.equal(view.element().props.children[1], null, '提示文字应消失（第二个子节点是 null），只剩图标')
  })
}
{
  const ctx = applyTo({})
  const view = ctx.bundle.React.mount(ctx.registered[0].component, { sessionId: FAKE_ID })
  view.element().props.onClick()
  await tick()
  view.rerender()
  assert.equal(ctx.bundle.timers.pending.length, 1, '反馈期应有 1 个待触发定时器')
  await check('卸载 → useEffect 的 cleanup 把待触发定时器收掉（不残留）', async () => {
    view.unmount()
    assert.equal(ctx.bundle.timers.pending.length, 0, '卸载后残留 ' + ctx.bundle.timers.pending.length + ' 个定时器')
    assert.equal(ctx.bundle.timers.cleared.length >= 1, true, 'cleanup 应当调过 clearTimeout')
  })
}

console.log('\n(c3) ensureCss 去重')
{
  const bundle = loadBundle({})
  const host = {
    slots: { inject(name, cb) { return cb() }, register() { return () => {} } },
    locale: { register() { return () => {} } },
    effect(fn) { fn(); return () => {} },
  }
  bundle.exports.apply(host)
  bundle.exports.apply(host)
  bundle.exports.apply(host)
  await check('apply() 连调三次后 <style> 仍然只有 1 个（ensureCss 的 querySelector 去重生效）', () => {
    assert.equal(bundle.dom.appended.head.length, 1,
      '注入了 ' + bundle.dom.appended.head.length + ' 个 <style>，去重失效')
    assert.equal(bundle.dom.appended.head[0].dataset.pluginCss, 'copy-session-id')
  })
}

console.log('\n(c4) document.head 缺失时 apply() 仍不抛')
{
  const bundle = loadBundle({ noHead: true })
  let threw = null
  try {
    bundle.exports.apply({
      slots: { inject(name, cb) { return cb() }, register() { return () => {} } },
      locale: { register() { return () => {} } },
      effect(fn) { fn(); return () => {} },
    })
  } catch (error) {
    threw = error
  }
  await check('ensureCss 抛错被就地吞掉并留下 warn，apply() 正常返回', () => {
    assert.equal(threw, null, 'apply 抛了：' + (threw && threw.stack))
    assert.equal(bundle.warnings.length, 1, '应有且只有 1 条 warn')
    assert.ok(String(bundle.warnings[0][0]).indexOf('[copy-session-id] ensureCss') === 0,
      '警告应是 ensureCss，实际：' + String(bundle.warnings[0][0]))
  })
}

console.log('\n(d) 空会话 ID 不给可点的按钮')
const empty = applyTo({})
const emptyView = empty.bundle.React.mount(empty.registered[0].component, { sessionId: undefined })
await check('sessionId 缺失 → disabled，且不会写剪贴板', async () => {
  assert.equal(emptyView.element().props.disabled, true)
  emptyView.element().props.onClick()
  await tick()
  assert.equal(empty.bundle.writes.length, 0)
})

console.log('\n(d2) props 本身是 undefined / null 也不抛')
for (const [label, value] of [['undefined', undefined], ['null', null]]) {
  const ctx = applyTo({})
  await check('渲染 props=' + label + ' → 不抛，且按钮 disabled', () => {
    const view = ctx.bundle.React.mount(ctx.registered[0].component, value)
    assert.equal(view.element().props.disabled, true)
  })
}

console.log('\n(e) 槽位形状变化时不拖垮 apply()')
const broken = loadBundle({})
let threw = null
try {
  broken.exports.apply({
    slots: {
      // 真实的 inject 在槽位已声明时**同步**跑回调，回调 setup 失败就同步抛
      // （dsh-client-ui-renderer/lib/types/client/registry.d.ts:109）。
      // 这里如实模拟，否则测不到 apply() 的 try/catch。
      inject(name, callback) { return callback() },
      register() { throw new Error('list slot requires options.id') },
    },
    locale: { register() { return () => {} } },
    effect(fn) { fn(); return () => {} },
  })
} catch (error) {
  threw = error
}
await check('register 抛错被就地吞掉（只少一个按钮），apply() 正常返回', () => {
  assert.equal(threw, null)
  assert.equal(broken.warnings.length, 1, '失败必须留下可见的 console.warn，不许静默')
  const text = String(broken.warnings[0][0])
  assert.ok(text.indexOf('[copy-session-id]') === 0, '警告前缀应是包名，实际：' + text)
  assert.ok(text.indexOf('slot register') !== -1, '警告要说明是槽位注册失败，实际：' + text)
  assert.ok(broken.warnings[0][1] instanceof Error, '原始异常对象要一起给出')
})

await tick()

console.log('\n' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) {
  for (const failure of failures) console.log('  - ' + failure.name + ': ' + failure.error.stack)
  process.exit(1)
}
console.log('SELFTEST PASS')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})