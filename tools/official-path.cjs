'use strict'
// official-path.cjs —— 契约审查脚本共用的路径解析模块（不属于产品代码）
//
// 这些脚本要读本机安装的 DSH 官方包源码来校验我们依赖的槽位契约。安装位置因人、因机器而异，
// 所以这里不写死任何绝对路径，而是按优先级推导官方包根目录（`@deepseek-ai` 那一层）：
//   1. DSH_OFFICIAL_ROOT  显式指定。设了就以它为准（存在性与内容按同一规则校验）。
//   2. DSH_HOME           在它下面找 node_modules/@deepseek-ai、profiles/<name>/node_modules/@deepseek-ai
//                         这类结构。找不到就走第 3 条，不穷尽搜索。
//   3. npm prefix -g      拼 <prefix>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
//   4. 都失败 → null
// profile（profiles/desktop）同理：DSH_HOME（或 %USERPROFILE%\.dsh）/ profiles / <DSH_PROFILE_NAME 或 desktop>。
//
// 拿不到官方包根或 profile 是常态（别人 clone 下来可能根本没装 DSH），调用方应当
// **跳过**依赖本机的断言并以 0 退出，而不是报失败。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// 候选目录必须至少含一个我们真正会读的官方包，才算「官方包根」。
// （profile 的 node_modules 下也可能有 @deepseek-ai 目录，但只有 cosmokit 这类依赖，不是官方包根。）
const SENTINEL = ['dsh-client-ui-slots', 'dsh-base', 'cordis']

function looksLikeOfficial(dir) {
  try {
    if (!fs.statSync(dir).isDirectory()) return false
  } catch (e) {
    return false
  }
  return SENTINEL.some((s) => fs.existsSync(path.join(dir, s)))
}

// DSH 数据目录：显式 DSH_HOME 优先，否则 %USERPROFILE%\.dsh（非 Windows 用 ~）
function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const home = process.platform === 'win32' ? (process.env.USERPROFILE || os.homedir()) : os.homedir()
  return path.join(home, '.dsh')
}

// profile 名可覆盖，默认 desktop
function profileName() {
  return process.env.DSH_PROFILE_NAME || 'desktop'
}

// 官方包根目录（@deepseek-ai 那一层），拿不到返回 null
function resolveOfficial() {
  // 1. 显式指定是权威的：设了就用它，不合格也不偷偷回退到别的路径
  //    （否则在本机装了 DSH 的人想模拟「没装」的环境时会失效）
  if (process.env.DSH_OFFICIAL_ROOT) {
    return looksLikeOfficial(process.env.DSH_OFFICIAL_ROOT) ? process.env.DSH_OFFICIAL_ROOT : null
  }
  const candidates = []
  if (process.env.DSH_HOME) {
    candidates.push(path.join(process.env.DSH_HOME, 'node_modules', '@deepseek-ai'))
    candidates.push(path.join(process.env.DSH_HOME, 'profiles', profileName(), 'node_modules', '@deepseek-ai'))
  }
  const prefix = npmGlobalPrefix()
  if (prefix) {
    candidates.push(path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  }
  for (const c of candidates) {
    if (looksLikeOfficial(c)) return c
  }
  return null
}

// profile 目录（profiles/desktop），不管它存不存在
function resolveProfile() {
  return path.join(resolveDshHome(), 'profiles', profileName())
}

function hasOfficial() {
  return resolveOfficial() !== null
}

function hasProfile() {
  const p = resolveProfile()
  try {
    return fs.statSync(p).isDirectory()
  } catch (e) {
    return false
  }
}

// npm 全局目录。Windows 上 npm 是 .cmd 垫片，不能直接 CreateProcess，所以走 comspec 转一层。
// 结果带缓存：一次进程里会问好几次，而 spawn 不便宜。
let _prefix = undefined
function npmGlobalPrefix() {
  if (_prefix !== undefined) return _prefix
  _prefix = npmGlobalPrefixOnce()
  return _prefix
}
function npmGlobalPrefixOnce() {
  try {
    const out = process.platform === 'win32'
      ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm prefix -g'],
        { encoding: 'utf8', timeout: 30000, windowsHide: true })
      : execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8', timeout: 30000 })
    const p = String(out).trim()
    return p || null
  } catch (e) {
    return null
  }
}

// 拿不到时的说明文案（给调用方打印跳过原因用）
//
// 这些文案会进 stdout，而 stdout 会进开源仓库的 CI 日志 —— 所以**绝不打印解析出来的真实路径**
// （本机路径含机器账号名）。只说「环境变量设了但没命中 / 没设」这类不含路径的事实。
// 需要给例子时用占位符（例如 <DSH_HOME>\profiles\desktop），不写真实值。
function officialReason() {
  const tried = []
  if (process.env.DSH_OFFICIAL_ROOT) {
    tried.push('DSH_OFFICIAL_ROOT 已设置但下面找不到官方包（缺 dsh-client-ui-slots / dsh-base / cordis 之一）')
  } else {
    tried.push('DSH_OFFICIAL_ROOT 未设置')
  }
  if (process.env.DSH_HOME) {
    tried.push('DSH_HOME 已设置但其 node_modules/@deepseek-ai 下找不到官方包')
  } else {
    tried.push('DSH_HOME 未设置')
  }
  tried.push('npm 全局目录推导' + (npmGlobalPrefix() === null ? '不可用（npm 不在 PATH 或执行失败）' : '未命中'))
  return tried.join('；')
}

function profileReason() {
  return 'profile 目录不存在（当前 profile 名「' + profileName() + '」）。' +
    '可设置 DSH_HOME 指向 DSH 数据目录（如 <DSH_HOME>\\profiles\\<profileName>），' +
    '或设置 DSH_PROFILE_NAME 指定 profile 名'
}

// 必须要官方包才能做的断言用这个：抛的是说明性错误，指明该设哪个环境变量
function requireOfficial() {
  const r = resolveOfficial()
  if (r === null) {
    throw new Error('找不到 DSH 官方包根目录（@deepseek-ai 那一层）。' +
      '请设置环境变量 DSH_OFFICIAL_ROOT 指向它，或设置 DSH_HOME 指向 DSH 数据目录（默认 %USERPROFILE%\\.dsh）。' +
      '已尝试：' + officialReason())
  }
  return r
}

module.exports = {
  resolveOfficial,
  resolveProfile,
  resolveDshHome,
  profileName,
  hasOfficial,
  hasProfile,
  requireOfficial,
  officialReason,
  profileReason,
}
