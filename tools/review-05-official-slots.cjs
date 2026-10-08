'use strict'
// review-05-official-slots.cjs —— 契约审查脚本
//
// 目的：拿**官方真实的** SlotCore（@deepseek-ai/dsh-client-ui-slots/lib/index.js）
// 当注册表，让本插件真实的 apply() 去注册，验证：
//   * 槽位形状（kind/list + id + order + locale）被官方代码接受，不抛
//   * order:100 的实际落点（四个官方占位者的真实 order）
//   * 重复注册的官方报错文案（验证插件用 ctx.effect 拿到 disposer 的必要性）
//   * 官方 locale.register 的真实约束（重复 locale 会抛）
// 官方 SlotCore 是普通 ESM 模块，可直接 import —— 不需要 DSH 运行时。
//
// 整份脚本依赖本机装的 DSH 官方包（要 import 它的 SlotCore、读它的 bundle 源码）。
// 没装时打印跳过说明并以 0 退出 —— 环境缺失不是契约违约。

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const url = require('node:url')
const { resolveOfficial, hasOfficial, officialReason } = require('./official-path.cjs')

const OFFICIAL = resolveOfficial()
const CLIENT = path.join(__dirname, '..', 'lib', 'client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')

if (!hasOfficial()) {
  console.log('review-05: 用官方 SlotCore 验证注册')
  console.log('')
  console.log('[skip] 整份脚本被跳过 —— 本机找不到 DSH 官方包，无法 import 官方 SlotCore。')
  console.log('       原因：' + officialReason())
  console.log('       请设置环境变量 DSH_OFFICIAL_ROOT 指向官方包根（@deepseek-ai 那一层），')
  console.log('       或设置 DSH_HOME 指向 DSH 数据目录（默认 %USERPROFILE%\\.dsh）。')
  console.log('')
  console.log('0 passed, 0 failed, 1 skipped（环境缺失，非契约违约）')
  process.exit(0)
}

let pass = 0
const fail = []
function check(name, fn) {
  try { fn(); pass++; console.log('  [ok] ' + name) }
  catch (e) { fail.push(name + ' :: ' + (e && e.message)); console.log('  [FAIL] ' + name + ' —— ' + (e && e.message)) }
}
const eq = (a, b, m) => { if (!Object.is(a, b)) throw new Error((m || '') + ' got=' + JSON.stringify(a) + ' want=' + JSON.stringify(b)) }

// 极简 React 桩（只够组件不炸）
const React = {
  createElement(type, props, ...kids) {
    const p = Object.assign({}, props)
    if (kids.length === 1) p.children = kids[0]; else if (kids.length > 1) p.children = kids
    return { type, props: p }
  },
  useState: (v) => [v, () => {}],
  useRef: (v) => ({ current: v }),
  useCallback: (f) => f,
  useEffect: () => {},
}

// ── 加载官方 SlotCore ──────────────────────────────────────────────────────
const slotsModPath = url.pathToFileURL(path.join(OFFICIAL, 'dsh-client-ui-slots', 'lib', 'index.js')).href
;(async () => {
  const { SlotCore } = await import(slotsModPath)
  console.log('review-05: 用官方 SlotCore 验证注册\n')

  // 按官方真实流程：父条目 conversation.session.header 的 children 里声明 actions 槽
  function freshCore() {
    const core = new SlotCore()
    // root 的 children 里挂 conversation.session.header（single/session）
    core.register({
      name: 'root',
      children: { 'conversation.session.header': { kind: 'single', scope: 'session' } },
    }, () => null)
    // 它的 children 里再挂 actions 槽（list/session）
    core.register({
      name: 'conversation.session.header',
      children: {
        'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      },
    }, () => null)
    return core
  }

  // 官方四个占位者：真实 id / 真实 order（从各自的 lib/client.js 里读出来）
  const OCCUPANTS = [
    { id: 'subagent-catalog', order: -30, file: 'dsh-client-ui-subagent\\lib\\client.js' },
    { id: 'agent-preset', order: -10, file: 'dsh-client-ui-agent-preset\\lib\\client.js' },
    { id: 'agent-team', order: -20, file: 'dsh-experimental-client-ui-agent-team\\lib\\client.js' },
    { id: 'job-list', order: 20, file: 'dsh-client-ui-jobs\\lib\\client.js' },
  ]
  console.log('[0] 官方占位者的 order 直接从官方 bundle 源码里读出来（不靠记忆）')
  for (const o of OCCUPANTS) {
    const ls = fs.readFileSync(path.join(OFFICIAL, o.file), 'utf8').split(/\r?\n/)
    const i = ls.findIndex((l) => l.includes('conversation.session.header.actions'))
    const seg = ls.slice(i, i + 5).join('\n')
    const id = seg.match(/id:\s*"([^"]+)"/)
    const ord = seg.match(/order:\s*(-?\d+)/)
    eq(id && id[1], o.id, o.file + ' 的 id 变了')
    eq(Number(ord && ord[1]), o.order, o.file + ' 的 order 变了')
    console.log('      ' + o.id.padEnd(18) + ' order=' + o.order + '  (' + o.file + ')')
  }
  console.log('')

  // ── 把本插件真实跑起来接到官方 SlotCore 上 ────────────────────────────────
  function bringUp(core, opts) {
    opts = opts || {}
    const loads = []
    const warnings = []
    const styles = []
    const localeDicts = []
    const sandbox = {
      console: { warn: (...a) => warnings.push(a), log() {}, error() {} },
      navigator: { clipboard: { writeText: () => Promise.resolve() } },
      document: {
        querySelector: (s) => styles.find((x) => x.pluginCss === s.replace(/.*data-plugin-css="([^"]+)".*/, '$1')) || null,
        createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }),
        head: { appendChild(n) { styles.push(n); return n } },
        body: { appendChild() {} },
      },
      setTimeout, clearTimeout, Promise,
    }
    sandbox.globalThis = sandbox
    sandbox.window = { __ModuleLoader__: { load(s) { loads.push(s) } } }
    vm.runInContext(SRC, vm.createContext(sandbox), { filename: 'lib/client.js' })
    const mod = loads[0].factory((n) => { if (n !== 'react') throw new Error('require(' + n + ')'); return React })

    const effects = []
    const ctx = {
      slots: {
        inject(key, cb) { return cb() },       // 槽位已声明 → 官方实现是同步跑 callback
        register(options, component) { return core.register(options, component) },
      },
      locale: {
        // 忠实照抄官方 dsh-client-locale/lib/client.js:1387-1412 的 register/disposer 语义：
        // register 返回的函数会把该 ns 的条目从表里删掉，所以「dispose → 重跑」不会撞「already has locale」。
        register(ns, d) {
          for (const loc of Object.keys(d)) {
            if (localeDicts.some((x) => x.ns === ns && x.loc === loc)) {
              throw new Error(`locale namespace "${ns}" already has locale "${loc}"`)
            }
          }
          const pairs = Object.entries(d)
          for (const [loc, entries] of pairs) localeDicts.push({ ns, loc, entries })
          return () => {
            let removed = false
            for (const [loc, entries] of pairs) {
              const k = localeDicts.findIndex((x) => x.ns === ns && x.loc === loc && x.entries === entries)
              if (k >= 0) { localeDicts.splice(k, 1); removed = true }
            }
            return removed
          }
        },
      },
      effect(fn, label) { const r = fn(); effects.push({ fn, label, result: r }); return r },
    }
    mod.apply(ctx)
    return { mod, ctx, warnings, styles, localeDicts, effects }
  }

  console.log('[1] 官方 SlotCore 接受本插件的注册形状')
  const core = freshCore()
  for (const o of OCCUPANTS) core.register({ name: 'conversation.session.header.actions', id: o.id, order: o.order, locale: 'common' }, () => null)
  let up = null
  check('apply() 在真实 SlotCore 上不抛，且官方 register 接受 {name,id,order,locale}', () => {
    up = bringUp(core)
    eq(up.warnings.length, 0, '不该有 warn：' + JSON.stringify(up.warnings.map((w) => String(w[0]))))
  })

  console.log('\n[2] order:100 的真实落点（官方 entriesOfSlot 排序后的顺序）')
  check('排序后 copy-session-id 在四个官方占位者之后', () => {
    const rows = core.entriesOfSlot('conversation.session.header.actions')
      .map((e) => ({ id: e.options.id, order: e.options.order ?? 0 }))
      .sort((a, b) => a.order - b.order)
    console.log('      实际顺序：' + rows.map((r) => `${r.id}(${r.order})`).join('  →  '))
    eq(rows[rows.length - 1].id, 'copy-session-id', '本按钮必须在最右端')
    eq(rows.length, 5, '槽位里应有 5 个条目')
  })

  console.log('\n[3] 官方 list 槽契约：同 id 重复注册的真实报错')
  {
    const c2 = freshCore()
    const a = bringUp(c2)
    let threw = null
    try {
      c2.register({ name: 'conversation.session.header.actions', id: 'copy-session-id', order: 100, locale: 'copySessionId' }, () => null)
    } catch (e) { threw = e }
    check('重复 id 会被官方 SlotCore 拒绝（插件靠 ctx.effect 拿 disposer 避免）', () => {
      if (threw === null) throw new Error('官方居然允许重复 id')
      if (!/already has an entry with id "copy-session-id"/.test(String(threw.message))) throw new Error('报错文案对不上：' + threw.message)
      console.log('      官方报错：' + threw.message)
      // 插件 effect 的返回值必须是 register 的 disposer，否则第二次 apply 必炸
      const eff = a.effects.find((e) => String(e.label).indexOf('header button') >= 0)
      eq(typeof eff.result, 'function', 'ctx.effect 拿到的必须是 disposer（函数），否则 fiber 重载时注册不会撤销')
    })
  }

  console.log('\n[4] 二次 apply 的行为（分两种：没 dispose 就重跑 / 完整 dispose→重跑）')
  {
    const c3 = freshCore()
    const a = bringUp(c3)
    let threw = null
    try { a.mod.apply(a.ctx) } catch (e) { threw = e }
    check('不 dispose 直接重跑 apply：locale 与 slot 两条都只留 warn，apply 仍不抛', () => {
      eq(threw, null, 'apply 抛了：' + (threw && threw.message))
      if (a.warnings.length < 1) throw new Error('一条 warn 都没有')
      const msgs = a.warnings.map((w) => String(w[0]))
      console.log('      实测 warn：' + JSON.stringify(msgs))
      if (!msgs.some((m) => m.indexOf('locale.register') >= 0)) throw new Error('没有 locale.register 的 warn')
      if (!msgs.some((m) => m.indexOf('slot register') >= 0)) throw new Error('没有 slot register 的 warn')
      console.log('      （这两次 warn 都是本审查脚本没跑 disposer 造成的；真实 cordis 会先跑 disposer，见下面 [4b]）')
    })
  }
  {
    // 真实 cordis 语义：fiber 卸载 → 先跑所有 effect 的返回值（disposer）→ 再 apply
    const c5 = freshCore()
    const a = bringUp(c5)
    const before = c5.entriesOfSlot('conversation.session.header.actions').length
    // 按真实顺序 dispose：后进先出
    for (const eff of a.effects.slice().reverse()) if (typeof eff.result === 'function') eff.result()
    const afterDispose = c5.entriesOfSlot('conversation.session.header.actions').length
    a.warnings.length = 0
    let threw = null
    try { a.mod.apply(a.ctx) } catch (e) { threw = e }
    check('完整 dispose → 重新 apply（插件重载场景）：零 warn、零异常、条目数不变', () => {
      eq(threw, null, '重跑 apply 抛了：' + (threw && threw.message))
      eq(afterDispose, before - 1, 'dispose 应撤销本插件的注册')
      eq(a.warnings.length, 0, '重载后不该有 warn：' + JSON.stringify(a.warnings.map((w) => String(w[0]))))
      eq(c5.entriesOfSlot('conversation.session.header.actions').length, before, '重载后条目数应恢复')
      eq(a.localeDicts.length, 2, '重载后 zh/en 两个字典都应重新注册')
      console.log('      实测：注册 ' + before + ' 条 → dispose 后 ' + afterDispose + ' 条 → 重跑 apply 后 ' +
        c5.entriesOfSlot('conversation.session.header.actions').length + ' 条，warn 数 ' + a.warnings.length +
        '，locale 字典 ' + a.localeDicts.length + ' 项')
    })
  }

  console.log('\n[5] 官方「槽位尚未声明」时的行为：inject 之前 register 会抛吗')
  {
    const c4 = new SlotCore()   // 故意不声明 actions 槽
    const loads = []
    const sandbox = {
      console: { warn: (...a) => (load.__w = (load.__w || []).concat([a])), log() {}, error() {} },
      navigator: {}, document: { querySelector: () => null, createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }), head: { appendChild() {} }, body: { appendChild() {} } },
      setTimeout, clearTimeout, Promise,
    }
    sandbox.globalThis = sandbox
    sandbox.window = { __ModuleLoader__: { load(s) { loads.push(s) } } }
    vm.runInContext(SRC, vm.createContext(sandbox), { filename: 'lib/client.js' })
    const mod = loads[0].factory(() => React)
    const warnings = []
    let threw = null
    const fakeInjectRan = []
    try {
      mod.apply({
        slots: {
          inject(key, cb) { fakeInjectRan.push(key); return undefined },   // 模拟「还没声明」：官方 inject 会 defer，不跑 cb
          register() { throw new Error('绝不该走到这里') },
        },
        locale: { register() { return () => {} } },
        effect(fn) { return fn() },
      })
    } catch (e) { threw = e }
    check('槽位未声明时：inject 只登记不执行 → 不抛、也不误注册', () => {
      eq(threw, null, 'apply 抛了：' + (threw && threw.message))
      eq(fakeInjectRan.length, 1)
      eq(fakeInjectRan[0], 'conversation.session.header.actions')
    })
  }

  console.log('\n' + pass + ' passed, ' + fail.length + ' failed')
  if (fail.length) { fail.forEach((f) => console.log('  - ' + f)); process.exit(1) }
  console.log('REVIEW-05 PASS')
})().catch((e) => { console.error(e); process.exit(1) })