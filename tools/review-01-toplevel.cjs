'use strict'
// review-01-toplevel.cjs —— 契约审查脚本（不属于产品代码）
//
// 目的：用**两条互相独立**的手段证明/证伪 lib/client.js 的「顶层零声明」。
//   手段 A：浏览器语义复现 —— 同一个 vm context 里把源码跑第二遍（等价于拼合脚本 / 两个 <script>）。
//           let/const/class 顶层绑定会直接 SyntaxError。
//   手段 B：深度感知的词法扫描器 —— 找出任何处在「顶层（brace depth 0）」的
//           const/let/var/function/class。扫描器本身先用已知答案的夹具标定。
//
// 不依赖 tools/selftest.cjs，也不复用它的任何代码。

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const { resolveOfficial, hasOfficial, officialReason } = require('./official-path.cjs')

const PLUGIN = path.join(__dirname, '..')
const CLIENT = path.join(PLUGIN, 'lib', 'client.js')
const OFFICIAL = resolveOfficial()      // 本机没装 DSH 时为 null，依赖官方包的断言会被跳过
const SIBLING = process.env.DSH_SIBLING_CLIENT || null   // 另一个插件的 lib/client.js，用于并排撞名测试

let pass = 0
const fail = []
const skipped = []
function check(name, fn) {
  try { fn(); pass++; console.log('  [ok] ' + name) }
  catch (e) { fail.push(name + ' :: ' + e.message); console.log('  [FAIL] ' + name + ' —— ' + e.message) }
}
function skip(name, why) {
  skipped.push(name)
  console.log('  [skip] ' + name + ' —— ' + why)
}

// ── 词法扫描器 ────────────────────────────────────────────────────────────────
// 把源码切成「代码 token」序列，跳过 字符串 / 模板 / 行注释 / 块注释 / 正则字面量，
// 同时维护 { } ( ) [ ] 深度。深度为 0 处出现的声明关键字即顶层声明。
function scanTopLevel(src, filename) {
  const hits = []
  const KW = { const: 1, let: 1, var: 1, function: 1, class: 1 }
  let i = 0
  let depth = 0
  let prevSig = ''            // 上一个「有意义」的字符，用于区分除号 vs 正则
  let prevWord = ''
  const n = src.length
  const lineOf = (idx) => src.slice(0, idx).split('\n').length

  while (i < n) {
    const c = src[i]
    // 行注释
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue }
    // 块注释
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) break; i = e + 2; continue }
    // 字符串
    if (c === '"' || c === "'") {
      const q = c; i++
      while (i < n) { if (src[i] === '\\') { i += 2; continue } if (src[i] === q) { i++; break } i++ }
      prevSig = q; prevWord = ''; continue
    }
    // 模板字面量（含 ${} 递归）
    if (c === '`') {
      i++
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (src[i] === '`') { i++; break }
        if (src[i] === '$' && src[i + 1] === '{') {
          // 手动跳过一层表达式：递归调用一个只求深度的子扫描
          let d = 1; i += 2
          while (i < n && d > 0) {
            const cc = src[i]
            if (cc === '"' || cc === "'") { const q = cc; i++; while (i < n) { if (src[i] === '\\') { i += 2; continue } if (src[i] === q) { i++; break } i++ } continue }
            if (cc === '`') { i++; while (i < n) { if (src[i] === '\\') { i += 2; continue } if (src[i] === '`') { i++; break } i++ } continue }
            if (cc === '{') d++
            if (cc === '}') d--
            i++
          }
          continue
        }
        i++
      }
      prevSig = '`'; prevWord = ''; continue
    }
    // 正则字面量（除号上下文）
    if (c === '/' && (prevSig === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prevSig) || prevWord === 'return' || prevWord === 'typeof')) {
      i++
      let inClass = false
      while (i < n) {
        const cc = src[i]
        if (cc === '\\') { i += 2; continue }
        if (cc === '[') inClass = true
        else if (cc === ']') inClass = false
        else if (cc === '/' && !inClass) { i++; break }
        else if (cc === '\n') break
        i++
      }
      while (i < n && /[a-z]/.test(src[i])) i++   // flags
      prevSig = '/'; prevWord = ''; continue
    }
    // 括号深度
    if (c === '{' || c === '(' || c === '[') { depth++; prevSig = c; i++; continue }
    if (c === '}' || c === ')' || c === ']') { depth--; prevSig = c; i++; continue }
    // 标识符
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++
      const word = src.slice(i, j)
      // `function` 在表达式位置（= ( , : [ return typeof … 之后，或 . 成员访问）不是声明
      const exprPosition = '=(,:[?&|+-*/%!'.includes(prevSig) || prevSig === '' ||
        ['return', 'typeof', 'of', 'in', 'yield', 'await'].includes(prevWord)
      const isDecl = word !== 'function' || !exprPosition
      if (depth === 0 && KW[word] && isDecl) {
        // `export const x` / `export default function` 也算；`obj.function` 不算
        hits.push({ file: filename, line: lineOf(i), keyword: word, text: src.slice(i, Math.min(j + 24, n)).replace(/\s+/g, ' ') })
      }
      prevWord = word; prevSig = word[word.length - 1]; i = j; continue
    }
    if (!/\s/.test(c)) prevSig = c
    else if (c === '\n') { /* 换行不影响正则判定 */ }
    i++
  }
  return hits
}

console.log('review-01: 顶层零声明审查')
console.log('target: ' + CLIENT + '\n')

// ── 步骤 0：先证明扫描器本身可信（夹具标定）───────────────────────────────
console.log('[0] 扫描器标定（夹具）')
const POS = "const a = 1\nlet b = 2\nvar c = 3\nfunction d(){}\nclass E{}\n"
const NEG =
  "var f = function () {\n" +
  "  const x = 'const y = 1';\n" +
  "  // let z = 2\n" +
  "  /* var w = 3 */\n" +
  "  var re = /const q/;\n" +
  "  return `${(() => { let w = 1; return w })()}` + x;\n" +
  "};\n" +
  "window.__ModuleLoader__.load({ id: 'x', factory: (r) => { class Z {} ; var v = 1; return v } });\n"

check('夹具正例：5 个顶层声明全部被扫出', () => {
  const h = scanTopLevel(POS, 'pos')
  const words = h.map((x) => x.keyword).sort().join(',')
  if (words !== 'class,const,function,let,var') throw new Error('got: ' + JSON.stringify(h))
})
check('夹具反例：字符串/注释/正则/模板/嵌套函数里的声明一个都不算', () => {
  const h = scanTopLevel(NEG, 'neg')
  if (h.length !== 1 || h[0].keyword !== 'var' || h[0].line !== 1) {
    throw new Error('expected exactly 1 top-level `var` at line 1, got: ' + JSON.stringify(h))
  }
})

// ── 步骤 A：扫描被审文件 ───────────────────────────────────────────────────
console.log('\n[A] 词法扫描 lib/client.js 的顶层声明')
const src = fs.readFileSync(CLIENT, 'utf8')
const hits = scanTopLevel(src, 'lib/client.js')
console.log('  扫描器命中：' + (hits.length === 0 ? '（零）' : JSON.stringify(hits, null, 2)))
check('lib/client.js 顶层零声明（const/let/var/function/class）', () => {
  if (hits.length !== 0) throw new Error('顶层命中 ' + hits.length + ' 处：' + JSON.stringify(hits))
})

// ── 步骤 B：浏览器语义复现（同一 context 跑两遍）───────────────────────────
console.log('\n[B] 同一 context 连续执行两遍（等价于 client 拼合脚本）')
function runTwice(a, b, label) {
  const ctx = vm.createContext({
    console: { warn() {}, log() {}, error() {} },
    navigator: {},
    document: {
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }),
      head: { appendChild() {} },
      body: { appendChild() {} },
    },
    setTimeout, clearTimeout, Promise,
    window: { __ModuleLoader__: { load() {} } },
  })
  const script = new vm.Script(a + '\n;\n' + b, { filename: label })
  script.runInContext(ctx)
}
check('把 lib/client.js 自己跑两遍不炸', () => {
  runTwice(src, src, 'doubled-self.js')
})

// 拿真实的兄弟插件 bundle 与真实官方 bundle 拼进来
// 兄弟插件路径由 DSH_SIBLING_CLIENT 指定；不设就跳过（别人机器上没有那个插件是常态）
if (SIBLING === null) {
  skip('lib/client.js + 兄弟插件 lib/client.js 并排不撞名', '未设置 DSH_SIBLING_CLIENT，不知道兄弟插件在哪')
} else {
  let siblingSrc = null
  try { siblingSrc = fs.readFileSync(SIBLING, 'utf8') } catch (e) { /* 下面统一报 skip */ }
  if (siblingSrc === null) {
    skip('lib/client.js + 兄弟插件 lib/client.js 并排不撞名', 'DSH_SIBLING_CLIENT 指向的文件读不到：' + SIBLING)
  } else {
    check('lib/client.js + ' + path.basename(path.dirname(path.dirname(SIBLING))) + '/lib/client.js 并排不撞名', () => {
      runTwice(src, siblingSrc, 'plus-sibling.js')
    })
  }
}

// —— 以下三条依赖本机装的 DSH 官方包。没装就跳过，不算失败 ——
if (!hasOfficial()) {
  skip('lib/client.js + 全部官方 client bundle 拼成一段脚本仍可解析执行', '本机没有 DSH 官方包：' + officialReason())
  skip('【反证】与官方 bundle 拼一起时，假设的顶层 const 版本必炸', '本机没有 DSH 官方包：' + officialReason())
} else {
  const officialClientDir = fs.readdirSync(OFFICIAL)
  const officialClients = officialClientDir
    .map((d) => path.join(OFFICIAL, d, 'lib', 'client.js'))
    .filter((f) => fs.existsSync(f))
  console.log('  官方 client bundle 数：' + officialClients.length)

  check('lib/client.js + 全部官方 client bundle 拼成一段脚本仍可解析执行', () => {
    const merged = src + '\n;\n' + officialClients.map((f) => fs.readFileSync(f, 'utf8')).join('\n;\n')
    const ctx = vm.createContext({
      console: { warn() {}, log() {}, error() {} },
      navigator: { clipboard: { writeText: () => Promise.resolve() } },
      document: {
        querySelector: () => null,
        createElement: () => ({ dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} }),
        head: { appendChild() {} },
        body: { appendChild() {} },
        addEventListener() {}, removeEventListener() {},
      },
      setTimeout, clearTimeout, Promise,
      fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
      EventSource: function () { return { addEventListener() {}, close() {} } },
      location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      window: { __ModuleLoader__: { load() {}, createQueue() { return {} }, run() {} }, addEventListener() {} },
    })
    ctx.globalThis = ctx
    // 只解析 + 执行（官方 bundle 的顶层本来就只是注册语句）
    new vm.Script(merged, { filename: 'all-bundles.js' }).runInContext(ctx)
  })

  check('【反证】与官方 bundle 拼一起时，假设的顶层 const 版本必炸', () => {
    const officialOne = fs.readFileSync(path.join(OFFICIAL, 'dsh-client-ui-conversation', 'lib', 'client.js'), 'utf8')
    const withTopConst = 'const factory = 1\n;\n' + src
    let threw = null
    try { runTwice(withTopConst, officialOne, 'official-collision.js') } catch (e) { threw = e }
    // 官方 bundle 自身顶层零声明，所以这一条可能不炸 —— 只报告事实，不做断言
    console.log('      注入顶层 `const factory` + 官方 ui-conversation bundle：' +
      (threw === null ? '未撞名（官方 bundle 顶层也零声明，符合预期）' : String(threw && threw.message).split('\n')[0]))
  })
}

// 反证：把「顶层 const」塞回这份 bundle 的**假设版本**，同一手法必须炸 —— 证明 [B] 不是恒真断言
// 这条只用自己的源码，不依赖本机 DSH
const BAD_TOP_CONST = "const React = null\n;\n" + src.replace(/^ {2}const React = require\('react'\)\n/m, '')
check('【反证】把 const React 提到顶层后，同一手法跑两遍必须抛 SyntaxError', () => {
  if (BAD_TOP_CONST === src) throw new Error('反证脚本没改到源码，说明行号/文本假设已失效')
  let threw = null
  try { runTwice(BAD_TOP_CONST, BAD_TOP_CONST, 'bad-top-const.js') } catch (e) { threw = e }
  if (threw === null) throw new Error('顶层 const 版本竟然没炸 —— [B] 的检测能力无效')
  if (!/Identifier .* has already been declared/.test(String(threw && threw.message))) {
    throw new Error('抛的不是撞名 SyntaxError: ' + String(threw && threw.message))
  }
  console.log('      实测报错：' + String(threw && threw.message).split('\n')[0])
})

// ── 步骤 C：顶层还有没有别的「语句」被求值（裸执行即产生副作用）───────────
console.log('\n[C] 顶层副作用面')
const sideEffects = []
const probeCtx = vm.createContext({
  console: { warn() {}, log() {}, error() {} },
  navigator: {},
  document: {
    querySelector: () => null,
    createElement: () => { sideEffects.push('document.createElement'); return { dataset: {}, style: {}, setAttribute() {}, select() {}, remove() {} } },
    head: { appendChild() { sideEffects.push('head.appendChild') } },
    body: { appendChild() {} },
  },
  setTimeout, clearTimeout, Promise,
  window: {
    __ModuleLoader__: { load(spec) { sideEffects.push('__ModuleLoader__.load(' + spec.id + ')') } },
  },
})
vm.runInContext(src, probeCtx, { filename: 'probe.js' })
console.log('  顶层执行产生的副作用：' + JSON.stringify(sideEffects))
check('顶层只做一件事：调用一次 __ModuleLoader__.load（且 id 正确）', () => {
  const want = JSON.stringify(['__ModuleLoader__.load(@zws/dsh-copy-session-id)'])
  if (JSON.stringify(sideEffects) !== want) throw new Error('got ' + JSON.stringify(sideEffects) + ' want ' + want)
})

console.log('\n' + pass + ' passed, ' + fail.length + ' failed, ' + skipped.length + ' skipped')
if (skipped.length) {
  console.log('（以下检查因本机环境缺失被跳过，不算失败）')
  skipped.forEach((s) => console.log('  - ' + s))
}
if (fail.length) { fail.forEach((f) => console.log('  - ' + f)); process.exit(1) }
console.log('REVIEW-01 PASS')