'use strict'
// review-03-mutation.cjs —— 变异测试脚本（检验 selftest 的断言是否真的有效）
//
// 目的：用**变异测试**判断 tools/selftest.cjs 的每条断言到底是「有效的」还是「装饰性的」。
// 方法：把 selftest.cjs 复制到系统临时目录（**绝不改产品文件**），只改副本里的一个点，
//       跑副本看它是否真的会 FAIL。改完还报 PASS 的那条断言 = 恒真 = 装饰性。
//
// 同时核对 selftest 对产品代码的覆盖面缺口。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const PKG_DIR = path.join(__dirname, '..')
const SELFTEST = path.join(PKG_DIR, 'tools', 'selftest.cjs')
const ORIG = fs.readFileSync(SELFTEST, 'utf8')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'review-03-'))
const libDir = path.join(tmpRoot, 'lib')
fs.mkdirSync(path.join(tmpRoot, 'tools'), { recursive: true })
fs.mkdirSync(path.join(tmpRoot, 'lib'), { recursive: true })
fs.copyFileSync(path.join(PKG_DIR, 'lib', 'client.js'), path.join(libDir, 'client.js'))
console.log('变异工作区：' + tmpRoot)
console.log('（selftest.cjs 依赖 __dirname/../lib/client.js，所以整棵树复制到临时目录再改）\n')

// 一个变异 = { 名称, 改哪个文件, from, to, 期望 }
const MUTANTS = [
  {
    name: 'M1 剪贴板内容写错（断言应 FAIL）',
    target: 'selftest', from: "assert.equal(ctx.bundle.writes[0], FAKE_ID)", to: "assert.equal(ctx.bundle.writes[0], FAKE_ID + 'X')",
    expectFail: true, proves: '「剪贴板收到的是纯 sessionId 原文」这条断言是有效的',
  },
  {
    name: 'M2 剪贴板多写一次（断言应 FAIL）',
    target: 'selftest', from: "assert.equal(ctx.bundle.writes.length, 1)", to: "assert.equal(ctx.bundle.writes.length, 2)",
    expectFail: true, proves: '写入次数断言是有效的',
  },
  {
    name: 'M3 从不触发点击（断言应 FAIL）',
    target: 'selftest', from: '  first.props.onClick()\n  await tick()', to: '  await tick()',
    expectFail: true, proves: '点击分支确实被走到了（不是「没点却报 ok」）',
  },
  {
    name: 'M4 空 ID 用例里的**异步**断言恒假（检查是否被漏掉）',
    target: 'selftest', from: 'assert.equal(empty.bundle.writes.length, 0)', to: 'assert.equal(empty.bundle.writes.length, 999)',
    expectFail: true, proves: '若报 PASS，说明 check() 不 await 返回的 Promise → 这条断言是装饰性的', show: true,
  },
  {
    name: 'M5 槽位注册抛错处理被摘掉（断言应 FAIL）',
    target: 'selftest', from: 'assert.equal(threw, null)', to: 'assert.equal(threw === null, false)',
    expectFail: true, proves: '「register 抛错不拖垮 apply()」这条断言是有效的',
  },
  {
    name: 'M6 顶层零绑定：把它破坏掉（把 const 提到顶层，断言应 FAIL）',
    target: 'client', from: 'window.__ModuleLoader__.load({', to: 'const TOP_LEVEL_PROBE = 1;\nwindow.__ModuleLoader__.load({',
    expectFail: true, proves: '「顶层零绑定」这条断言真的能抓到顶层声明（不是恒真）',
  },
  {
    name: 'M7 CSS 去重失效（ensureCss 每次都插 style）—— 检查 selftest 能否发现',
    target: 'client', from: "if (document.querySelector('style[data-plugin-css=\"copy-session-id\"]')) return", to: '/* 去重被拆掉 */',
    expectFail: false, proves: '若报 PASS，说明 selftest 从未覆盖 CSS 重复注入（覆盖缺口）',
  },
  {
    name: 'M8 定时器时长改成 999999ms —— 检查 selftest 能否发现',
    target: 'client', from: 'const FEEDBACK_MS = 1500', to: 'const FEEDBACK_MS = 999999',
    expectFail: false, proves: '若报 PASS，说明 selftest 从未断言 1500ms 还原时机（覆盖缺口）', show: true,
  },
  {
    name: 'M9 卸载时不清定时器（删掉 effect cleanup）—— 检查 selftest 能否发现',
    target: 'client',
    from: '    React.useEffect(() => () => {\n      if (timerRef.current !== 0) {\n        clearTimeout(timerRef.current)\n        timerRef.current = 0\n      }\n    }, [])',
    to: '    void timerRef',
    expectFail: false, proves: '若报 PASS，说明 selftest 从未覆盖卸载时定时器残留（覆盖缺口）',
  },
  {
    name: 'M10 组件忽略 props 为 undefined（换成可选链）—— 反向看 selftest 是否会误报',
    target: 'client', from: "typeof props.sessionId === 'string'", to: "typeof (props || {}).sessionId === 'string'",
    expectFail: false, proves: 'selftest 没测 props 残缺；改成安全写法后仍 PASS，说明它对这条无约束（覆盖缺口）',
  },
  {
    name: 'M11 降级链删掉 execCommand 兜底 —— 检查 selftest 能否发现',
    target: 'client', from: '        () => legacyCopy(text),', to: '        () => false,',
    expectFail: true, proves: '「writeText 被拒 → execCommand 降级」这条断言是有效的',
  },
  {
    name: 'M12 失败时不显示「复制失败」（phase 永远 copied）—— 检查 selftest 能否发现',
    target: 'client', from: "setPhase(ok ? 'copied' : 'failed')", to: "setPhase('copied')",
    expectFail: true, proves: '「两级都失败 → 显示复制失败」这条断言是有效的',
  },
]

function runVariant(m) {
  // 每次从干净副本开始
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  fs.mkdirSync(path.join(tmpRoot, 'tools'), { recursive: true })
  fs.mkdirSync(path.join(tmpRoot, 'lib'), { recursive: true })
  fs.copyFileSync(path.join(PKG_DIR, 'lib', 'client.js'), path.join(tmpRoot, 'lib', 'client.js'))
  let st = ORIG
  if (m.target === 'selftest') {
    if (!st.includes(m.from)) throw new Error('变异锚点没找到（selftest 已被改动？）: ' + m.from)
    st = st.replace(m.from, m.to)
    fs.writeFileSync(path.join(tmpRoot, 'tools', 'selftest.cjs'), st)
  } else {
    let cl = fs.readFileSync(path.join(PKG_DIR, 'lib', 'client.js'), 'utf8')
    if (!cl.includes(m.from)) throw new Error('变异锚点没找到（client.js 已被改动？）: ' + JSON.stringify(m.from.slice(0, 40)))
    cl = cl.replace(m.from, m.to)
    fs.writeFileSync(path.join(tmpRoot, 'lib', 'client.js'), cl)
    fs.writeFileSync(path.join(tmpRoot, 'tools', 'selftest.cjs'), ORIG)
  }
  try {
    const out = execFileSync(process.execPath, [path.join(tmpRoot, 'tools', 'selftest.cjs')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') }
  }
}

console.log('基线：未变异的 selftest')
{
  const r = runVariant({ target: 'none' })
  console.log('  exit=' + r.code + '  最后一行：' + String(r.out).trim().split('\n').pop())
  console.log('')
}

const rows = []
for (const m of MUTANTS) {
  let r
  try { r = runVariant(m) } catch (e) { console.log('  [脚本错误] ' + m.name + ' —— ' + e.message); rows.push([m.name, 'ANCHOR-MISS', '', '']); continue }
  const failed = r.code !== 0
  const verdict = (m.expectFail && failed) ? '断言有效 ✓' : (!m.expectFail && !failed) ? '未被覆盖 ✗' : '与预期相反 ?'
  console.log('  ' + (verdict.startsWith('断言有效') ? '[有效]' : verdict.startsWith('未被覆盖') ? '[缺口]' : '[异常]') +
    ' ' + m.name + '  → exit=' + r.code)
  console.log('        ' + m.proves)
  if (m.show) {
    console.log('        ---- 变异体真实输出（尾部 12 行）----')
    for (const l of String(r.out).trim().split('\n').slice(-12)) console.log('        | ' + l)
    console.log('        ---------------------------------------')
  }
  rows.push([m.name, verdict, String(r.code), String(r.out).trim().split('\n').slice(-2).join(' | ')])
}

console.log('\n──────────────── 汇总 ────────────────')
for (const r of rows) console.log('  ' + r[1] + '  ' + r[0] + '  (exit=' + r[2] + ')')
fs.rmSync(tmpRoot, { recursive: true, force: true })
console.log('\n（临时目录已删除；产品文件全程只读）')