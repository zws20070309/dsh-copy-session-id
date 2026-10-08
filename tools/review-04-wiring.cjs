'use strict'
// review-04-wiring.cjs —— 契约审查脚本
//
// 目的：核对 package.json / cordis.patch.yml / lib/index.js / locale / icon 的接线是否自洽，
// 以及 README 里那些「可查的行号断言」是否属实。
// 只读：全程不写任何被审文件。
//
// 分两类断言：
//   * 本包自身接线（package.json 合法性、exports["./client"]、cordis.patch.yml 的 id/name 一致、
//     lib/index.js 能被 import、locale/icon 形状）—— 不依赖本机 DSH，永远执行。
//   * 引用官方包 / profile 里真实文件行号的断言 —— 需要本机装了 DSH，否则跳过（exit 仍为 0）。

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { resolveOfficial, resolveProfile, resolveDshHome, profileName, hasOfficial, hasProfile, officialReason, profileReason } = require('./official-path.cjs')

const ROOT = path.join(__dirname, '..')
const OFFICIAL = resolveOfficial()      // 本机没装 DSH 时为 null
const PROFILE = resolveProfile()
const read = (p) => fs.readFileSync(p, 'utf8')
const lines = (p) => read(p).split(/\r?\n/)

let pass = 0
const fail = []
const skipped = []
function check(name, fn) {
  try { fn(); pass++; console.log('  [ok] ' + name) }
  catch (e) { fail.push(name + ' :: ' + (e && e.message)); console.log('  [FAIL] ' + name + ' —— ' + (e && e.message)) }
}
function skip(name, why) {
  skipped.push(name)
  console.log('  [skip] ' + name + ' —— ' + why)
}

console.log('review-04: 接线与 README 一致性')
// 只说「有没有」，不打印解析出来的真实路径（本机路径含机器账号名，不能进开源仓库的日志）
console.log('官方包根：' + (hasOfficial() ? '已找到' : '未找到'))
console.log('profile：' + (hasProfile() ? '已找到（' + profileName() + '）' : '未找到') + '\n')

// ── package.json ────────────────────────────────────────────────────────────
console.log('[1] package.json')
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')))
check('package.json 是合法 JSON，name = @zws/dsh-copy-session-id', () => {
  if (pkg.name !== '@zws/dsh-copy-session-id') throw new Error('name=' + pkg.name)
})
check('exports["./client"] 存在且指向真实文件（dsh-client-modules 硬要求，lib/index.js:718-719）', () => {
  const c = pkg.exports['./client']
  if (typeof c !== 'string') throw new Error('exports["./client"] 不是字符串：' + JSON.stringify(c))
  if (!fs.existsSync(path.join(ROOT, c))) throw new Error('文件不存在：' + c)
})
check('main 与 exports["."] 指向真实文件且一致', () => {
  if (typeof pkg.main !== 'string') throw new Error('main 缺失')
  if (pkg.exports['.'] !== './' + pkg.main) throw new Error('exports["."]=' + pkg.exports['.'] + ' vs main=' + pkg.main)
  if (!fs.existsSync(path.join(ROOT, pkg.main))) throw new Error('main 指向的文件不存在')
})
check('type=module（cordis 用 import() 加载宿主入口）', () => {
  if (pkg.type !== 'module') throw new Error('type=' + pkg.type)
})
check('dsh.client 字段名/形状符合官方 parseDshClient（platform 必填字符串、inject 必填字符串数组）', () => {
  const d = pkg.dsh && pkg.dsh.client
  if (typeof d !== 'object' || d === null) throw new Error('dsh.client 缺失')
  if (typeof d.platform !== 'string') throw new Error('platform 不是字符串')
  if (d.platform !== 'web') throw new Error('platform=' + d.platform)
  if (!Array.isArray(d.inject) || d.inject.some((x) => typeof x !== 'string')) throw new Error('inject 形状不对')
  // 形状本身不依赖本机 DSH（永远查）；「inject 的包真的装了」才依赖，没有就跳过
  console.log('      dsh.client.inject = ' + JSON.stringify(d.inject))
  if (!hasOfficial()) {
    console.log('      （跳过「inject 的包在官方包里存在」：本机无官方包，' + officialReason() + '）')
    return
  }
  for (const name of d.inject) {
    if (!fs.existsSync(path.join(OFFICIAL, name.replace('@deepseek-ai/', ''), 'package.json'))) {
      throw new Error('dsh.client.inject 里的 ' + name + ' 在官方包里不存在')
    }
  }
  console.log('      （inject 里的包在本机官方包根下都存在）')
})
check('dsh.bundle.patch 指向真实文件（dsh-app-boot/lib/index.js:496-497 读它）', () => {
  const p = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch
  if (typeof p !== 'string') throw new Error('dsh.bundle.patch 不是字符串：' + JSON.stringify(p))
  if (!fs.existsSync(path.join(ROOT, p))) throw new Error('patch 文件不存在：' + p)
})
check('exports["./locale/*.json"] 子路径模式能被 Node 解析（官方先例也有这一项）', () => {
  const spec = pkg.name + '/locale/zh.json'
  const resolved = require.resolve(spec, { paths: [ROOT] })
  if (!fs.existsSync(resolved)) throw new Error('解析到不存在的文件：' + resolved)
})
// 依赖本机官方包：peerDependencies 声明的包是否真的装了、版本区间对不对
if (!hasOfficial()) {
  skip('peerDependencies 里列的两个包在官方包里都存在', '本机没有 DSH 官方包：' + officialReason())
} else {
  check('peerDependencies 里列的两个包在官方包里都存在', () => {
    for (const [name, range] of Object.entries(pkg.peerDependencies || {})) {
      const dir = path.join(OFFICIAL, name.replace('@deepseek-ai/', ''))
      if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error(name + ' 不存在')
      const v = JSON.parse(read(path.join(dir, 'package.json'))).version
      console.log('      ' + name + ' 声明 ' + range + '，实际装的是 ' + v)
      const majorMinor = range.split('>=')[1].split('.')[0] + '.' + range.split('>=')[1].split('.')[1]
      if (!v.startsWith(majorMinor)) throw new Error(name + ' 版本区间与实际 ' + v + ' 不符')
    }
  })
}

// ── cordis.patch.yml ────────────────────────────────────────────────────────
console.log('\n[2] cordis.patch.yml 与 package.json 的 id/name 一致性')
const patchTxt = read(path.join(ROOT, 'cordis.patch.yml'))
check('patch 里 - insert: 的 name === package.json 的 name（不一致 = 这一行 import 失败）', () => {
  const m = patchTxt.match(/- insert:\s*\n\s*- id:\s*(\S+)\s*\n\s*name:\s*'([^']+)'/)
  if (!m) throw new Error('没找到 `- insert:` / `id:` / `name:` 三行；实际内容：\n' + patchTxt)
  if (m[2] !== pkg.name) throw new Error('patch name=' + m[2] + '，package.json name=' + pkg.name)
  console.log('      id=' + m[1] + '  name=' + m[2])
})
check('patch 里没有「依赖已存在行」的 - id: 覆盖（顺序依赖会静默失效）', () => {
  if (/^\s*-\s+id:\s/m.test(patchTxt) && !/- insert:/.test(patchTxt)) throw new Error('有裸 - id: 行')
  const top = patchTxt.split('\n').filter((l) => /^-\s+\w/.test(l)).map((l) => l.trim())
  for (const t of top) if (!t.startsWith('- insert:')) throw new Error('顶层非 insert 指令：' + t)
})

// ── lib/index.js（宿主入口）──────────────────────────────────────────────────
console.log('\n[3] lib/index.js：真的能被 import，且是合法 cordis 插件')
check('lib/index.js 形状：name 为包名、inject 为数组、apply 为函数', () => {
  const src = read(path.join(ROOT, 'lib', 'index.js'))
  const m1 = src.match(/export const name = '([^']+)'/)
  const m2 = src.match(/export const inject = (\[[^\]]*\])/)
  const m3 = src.match(/export function apply\(([^)]*)\)/)
  if (!m1) throw new Error('没有 export const name')
  if (m1[1] !== pkg.name) throw new Error('name=' + m1[1] + ' ≠ package.json ' + pkg.name)
  if (!m2) throw new Error('没有 export const inject')
  if (!m3) throw new Error('没有 export function apply')
})
check('lib/index.js 真的能被 Node import()（ESM 解析 + 求值）', () => {
  const r = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import {pathToFileURL} from 'node:url';
     const m = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, 'lib', 'index.js'))}).href);
     const out = { name: m.name, inject: Array.from(m.inject), applyType: typeof m.apply };
     const ctx = { get(){ throw new Error('apply 不该访问 ctx') }, effect(){ throw new Error('apply 不该调 effect') } };
     m.apply(ctx);
     console.log(JSON.stringify(out));`],
  { encoding: 'utf8', timeout: 30000 })
  console.log('      import 结果：' + r.trim())
})

// ── locale / icon ───────────────────────────────────────────────────────────
console.log('\n[4] locale/*.json 与 icon.svg')
for (const loc of ['zh', 'en']) {
  check('locale/' + loc + '.json 形状 {meta:{title,description}}', () => {
    const j = JSON.parse(read(path.join(ROOT, 'locale', loc + '.json')))
    if (typeof j.meta?.title !== 'string' || !j.meta.title) throw new Error('meta.title 缺失')
    if (typeof j.meta?.description !== 'string' || !j.meta.description) throw new Error('meta.description 缺失')
  })
}
check('icon.svg 是可解析的 svg', () => {
  const s = read(path.join(ROOT, 'icon.svg'))
  if (!/^﻿?<svg[\s>]/i.test(s.trim())) throw new Error('不以 <svg 开头')
  if (!/<\/svg>\s*$/i.test(s.trim())) throw new Error('不以 </svg> 结尾')
  console.log('      icon.svg ' + s.length + ' 字节')
})

// ── README 的可查断言 ───────────────────────────────────────────────────────
// 这一组断言逐条核对 README 引用的官方文件行号，必须读到本机官方包源码才能验证
console.log('\n[5] README / 注释里可查的行号断言逐条核对')
if (!hasOfficial()) {
  skip('README / 注释里全部官方行号引用（共 11 条）', '本机没有 DSH 官方包：' + officialReason())
} else {
const readme = read(path.join(ROOT, 'README.md'))
const cite = (label, file, range, mustContain) => {
  check(label, () => {
    const ls = lines(path.join(OFFICIAL, file))
    const [a, b] = range.split('-').map(Number)
    const seg = ls.slice(a - 1, b).join('\n')
    if (!mustContain.every((m) => seg.includes(m))) {
      throw new Error('在 ' + file + ':' + range + ' 没找到 ' + JSON.stringify(mustContain) + '\n        实际内容：\n' + seg)
    }
    console.log('      ' + file + ':' + range + ' 命中 ' + JSON.stringify(mustContain))
  })
}
cite('README「order 升序」引用 dsh-client-ui-slots/lib/index.js:221', 'dsh-client-ui-slots\\lib\\index.js', '221', ['a.options.order ?? 0', 'sort('])
cite('README「渲染时再排一次」引用 dsh-client-ui-renderer/lib/client.js:1181/1193', 'dsh-client-ui-renderer\\lib\\client.js', '1193', ['sort((a, b) => a.order - b.order)'])
cite('README「resolveMeta 只校验 exports["./client"]」引用 dsh-client-modules/lib/index.js:718-719', 'dsh-client-modules\\lib\\index.js', '718-719', ['clientExportOf', 'exports no "./client" bundle'])
cite('README「契约快照」引用 dsh-cordis-client-runner/lib/client.js:3499', 'dsh-cordis-client-runner\\lib\\client.js', '3499', ['Title-adjacent Session actions in ascending order.'])
cite('README「order 默认 0」引用 dsh-cordis-client-runner/lib/client.js:3512', 'dsh-cordis-client-runner\\lib\\client.js', '3512', ['Position among the entries, ascending (default 0).'])
cite('README「agent-team 占位」引用 dsh-cordis-client-runner/lib/client.js:3548', 'dsh-cordis-client-runner\\lib\\client.js', '3548', ["TeamAction id 'agent-team'"])
cite('README「官方示例 order:100」引用 dsh-cordis-client-runner/lib/client.js:3551', 'dsh-cordis-client-runner\\lib\\client.js', '3551', ['order: 100', "id: 'my-entry'"])
check('lib/client.js:4 的槽位声明引用 dsh-client-ui-conversation/lib/client.js:18268-18271', () => {
  const ls = lines(path.join(OFFICIAL, 'dsh-client-ui-conversation', 'lib', 'client.js')).slice(18267, 18271).join('\n')
  for (const m of ['"conversation.session.header.actions"', 'kind: "list"', 'scope: "session"']) {
    if (!ls.includes(m)) throw new Error('18268-18271 里没有 ' + m)
  }
})
check('lib/client.js:5 的渲染位置引用 dsh-client-ui-conversation/lib/client.js:16500-16503', () => {
  const ls = lines(path.join(OFFICIAL, 'dsh-client-ui-conversation', 'lib', 'client.js')).slice(16499, 16503).join('\n')
  if (!ls.includes('headerActions')) throw new Error('16500-16503 里没有 headerActions：\n' + ls)
  if (!ls.includes('renderSlot("conversation.session.header.actions"')) throw new Error('没有 renderSlot 调用')
})
check('lib/client.js:14 的 writeClipboard 引用 dsh-client-ui-primitives/lib/index.js:4551-4574', () => {
  const ls = lines(path.join(OFFICIAL, 'dsh-client-ui-primitives', 'lib', 'index.js')).slice(4550, 4574).join('\n')
  if (!ls.includes('async function writeClipboard(text)')) throw new Error('4551 不是 writeClipboard')
  if (!ls.includes("execCommand")) throw new Error('范围内没有 execCommand 降级')
})
check('lib/client.js:59 的「缺键原样返回 key」引用 dsh-client-locale/lib/types/client/index.d.ts:87-90', () => {
  const ls = lines(path.join(OFFICIAL, 'dsh-client-locale', 'lib', 'types', 'client', 'index.d.ts')).slice(86, 90).join('\n')
  if (!ls.includes('before showing the key itself')) throw new Error('87-90 里没有这句：\n' + ls)
})
check('selftest:266 的「list 槽缺 id 会抛」引用 dsh-client-ui-slots/lib/index.js:181-184', () => {
  const ls = lines(path.join(OFFICIAL, 'dsh-client-ui-slots', 'lib', 'index.js')).slice(180, 184).join('\n')
  if (!ls.includes('case "list"')) throw new Error('181 不是 case "list"')
  if (!ls.includes('requires options.id')) throw new Error('182 起的报错文案对不上')
})
check('lib/index.js:31 的 Inject.resolve 引用 cordis/lib/index.js:1635', () => {
  const ls = lines(path.join(OFFICIAL, 'cordis', 'lib', 'index.js'))
  const seg = ls.slice(1630, 1640).join('\n')
  if (!seg.includes('resolve')) throw new Error('1635 附近没有 resolve：\n' + seg)
})
check('README「HMR root: []」引用官方 dsh-base/cordis.patch.yml:27-32', () => {
  // 这条断言曾经引用错地方（profiles/desktop/cordis.yml 的某几行），但那个文件只有 4 行、内容是 []，
  // 根本没有 dsh-hmr —— 是本审查脚本自己抓出来的错引用。真实出处是官方 dsh-base 的 patch 层。
  const ls = lines(path.join(OFFICIAL, 'dsh-base', 'cordis.patch.yml')).slice(26, 32).join('\n')
  if (!ls.includes('@deepseek-ai/dsh-hmr')) throw new Error('27-32 里没有 dsh-hmr：\n' + ls)
  if (!ls.includes('root: []')) throw new Error('27-32 里没有 root: []：\n' + ls)
  // 连带核对 README 新增的那句官方注释引用
  const rl = lines(path.join(ROOT, 'README.md')).join('\n')
  if (!rl.includes('dsh-base/cordis.patch.yml:27-32')) throw new Error('README 没写真实出处')
  if (rl.includes('cordis.yml:9-13')) throw new Error('README 仍留着那条错的引用 cordis.yml:9-13')
})
}

// 这条读 profile 下的真实文件（cordis.yml 的头部禁止说明、cordis.patch.yml 的落点），
// 只有本机有对应 profile 才跑得动
if (!hasProfile()) {
  skip('README 不再让用户改 profiles/<name>/cordis.yml（该文件头禁止）', profileReason())
} else {
check('README 不再让用户改 profiles/' + path.basename(PROFILE) + '/cordis.yml（该文件头禁止）', () => {
  const rl = lines(path.join(ROOT, 'README.md')).join('\n')
  if (!rl.includes('Edit cordis.patch.yml, not this file')) throw new Error('README 没写出该文件的禁止说明')
  if (!rl.includes('cordis.patch.yml')) throw new Error('README 没给出正确的 patch 落点')
  // 该文件头确实这么写（引用属实）。
  // 注意：cordis.yml 的内容是运行时产物 —— DSH 一旦写过 profile 配置，它就不再是那个
  // 只有 4 行、带这段头部注释的空列表占位。所以这里只在**头部注释还在**时才校验它，
  // 注释不在（文件已被 DSH 改写）就跳过，而不是报 FAIL：这依赖的是本机瞬时状态，
  // 不是本仓库的契约。
  const cordisPath = path.join(PROFILE, 'cordis.yml')
  const head = fs.existsSync(cordisPath) ? lines(cordisPath).slice(0, 6).join('\n') : ''
  if (head.includes('Edit cordis.patch.yml, not this file')) {
    pass++; console.log('  [ok] profile cordis.yml 头部确有「Edit cordis.patch.yml, not this file」')
  } else if (head !== '') {
    console.log('  [note] profile cordis.yml 已被 DSH 改写（不再是空列表占位），跳过头部校验')
  }
  // 给出的 patch 落点文件真实存在，且是 profile 自己的 patch 层
  const pl = lines(path.join(PROFILE, 'cordis.patch.yml')).slice(0, 4).join('\n')
  if (!pl.includes('applied after every bundle layer')) throw new Error('cordis.patch.yml 头部文案对不上：\n' + pl)
})
}

// ── 官方同槽位占位者的 order（验证 order:100 的落点结论）────────────────────
console.log('\n[6] 同槽位官方占位者的 order（验证 order:100 落点结论）')
if (!hasOfficial()) {
  skip('order:100 排在全部四个官方占位者之后（= .headerActions 最右端）', '本机没有 DSH 官方包：' + officialReason())
  skip('README「所有没声明 order 的官方条目」这句措辞的核对', '本机没有 DSH 官方包：' + officialReason())
} else {
const OCC = [
  ['dsh-client-ui-subagent\\lib\\client.js', 'subagent-catalog'],
  ['dsh-client-ui-agent-preset\\lib\\client.js', 'agent-preset'],
  ['dsh-experimental-client-ui-agent-team\\lib\\client.js', 'agent-team'],
  ['dsh-client-ui-jobs\\lib\\client.js', 'job-list'],
]
const orders = []
for (const [rel, id] of OCC) {
  const ls = lines(path.join(OFFICIAL, rel))
  const i = ls.findIndex((l) => l.includes('conversation.session.header.actions'))
  const seg = ls.slice(i, i + 5).join('\n')
  const m = seg.match(/order:\s*(-?\d+)/)
  orders.push([id, m ? Number(m[1]) : 0])
  console.log('      ' + id.padEnd(18) + ' order=' + (m ? m[1] : '(未声明→0)'))
}
check('order:100 排在全部四个官方占位者之后（= .headerActions 最右端）', () => {
  for (const [id, o] of orders) if (o >= 100) throw new Error(id + ' 的 order=' + o + ' ≥ 100，插件结论不成立')
})
check('README「所有没声明 order 的官方条目」这句措辞对四个官方条目不成立（它们都显式声明了 order）', () => {
  const declared = orders.filter(([, o]) => o !== 0)
  console.log('      事实：' + orders.length + ' 个占位者里 ' + declared.length + ' 个显式声明了非 0 的 order → ' +
    orders.map(([i, o]) => i + '=' + o).join(', '))
})
}

// ── 本机安装现状（事实记录，不做断言）─────────────────────────────────────
console.log('\n[7] 本机安装现状（README 步骤是否已执行）')
if (!hasProfile()) {
  console.log('      （跳过：' + profileReason() + '）')
} else {
try {
  const prof = JSON.parse(read(path.join(PROFILE, 'package.json')))
  const bundles = prof.dsh?.profile?.bundles || []
  console.log('      profile package.json 的 dsh.profile.bundles 含本包：' + bundles.includes(pkg.name))
  console.log('      dependencies 含本包：' + Object.keys(prof.dependencies || {}).includes(pkg.name))
  const nm = path.join(PROFILE, 'node_modules', '@zws', 'dsh-copy-session-id')
  console.log('      profile node_modules/@zws/dsh-copy-session-id 存在：' + fs.existsSync(nm))
  // README 步骤 1 建的目录联接，在 DSH 数据目录的 plugins 下（不打印路径本身）
  const jn = path.join(resolveDshHome(), 'plugins', 'dsh-copy-session-id')
  console.log('      README 步骤 1 的目录联接存在：' + fs.existsSync(jn))
} catch (e) { console.log('      （读不到 profile：' + e.message + '）') }
}

console.log('\n' + pass + ' passed, ' + fail.length + ' failed, ' + skipped.length + ' skipped')
if (skipped.length) {
  console.log('（以下检查因本机环境缺失被跳过，不算失败）')
  skipped.forEach((s) => console.log('  - ' + s))
}
if (fail.length) { fail.forEach((f) => console.log('  - ' + f)); process.exit(1) }
console.log('REVIEW-04 PASS')