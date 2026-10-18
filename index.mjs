/**
 * dsh-film-studio — 短视频工坊：配音 + 逐帧渲染
 *
 * 把两件事装成插件工具：
 *  1. film_voice   阿里云 qwen-audio-3.1-tts-next 逐句配音，带参考音色锁、逐句响度对齐、
 *                  可选 ASR 回读，产出 voice.wav / timings.json / timeline.js；
 *  2. film_render 调用 flash-motion 的 fm.py 把 seek(t) 页面逐帧渲染成片；
 *  3. film_check  渲染前跑确定性与排版检查。
 *
 * flash-motion 技能随包发布，安装时复制到 <DSH_HOME>/skills/，由桌面端已有的
 * 文件系统技能提供器自动加载（不依赖 @deepseek-ai/* 能否在本包内解析）。
 */
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'film-studio'
export const inject = ['tools']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_NAME = 'flash-motion'
const SKILL_NAMES = ['flash-motion', 'film-studio']
const SKILL_VERSION = '1.3.0'

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

/* ── defineTool 兜底 ── */

/** 把「属性规格」写法（属性里写 required: true）转成真正的 JSON Schema。入参是裸属性表。 */
function propsToJsonSchema(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = value ?? {}
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** output.schema 已经是 {type:'object',properties:{...}} 形状，只把 required:true 提到数组里。 */
function normalizeOutputSchema(schema = {}) {
  if (!schema || schema.type !== 'object' || !schema.properties) return schema
  return propsToJsonSchema(schema.properties)
}

function fallbackDefineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: propsToJsonSchema(options.parameters),
    output: {
      // 关键：output.schema 必须是合法 JSON Schema，否则 tools.register 会拒绝整个工具
      // （JSON Schema 里 required 是字符串数组，不是属性上的布尔值）。
      schema: normalizeOutputSchema(options.output?.schema ?? {}),
      render: options.output?.render ?? (() => []),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    execute: (args, exec) => options.execute(args, exec),
  }
}

/**
 * 优先用宿主的真实 defineTool：
 * 本插件装在插件目录里，Node 从它所在位置向上找不到 @deepseek-ai/dsh-tools，
 * 所以再按宿主安装目录的绝对路径试一次，最后才退回兜底实现。
 */
async function loadDefineTool() {
  const tries = ['@deepseek-ai/dsh-tools']
  const resources = process.resourcesPath
  if (resources) {
    tries.push(
      pathToFileURL(join(resources, 'app', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href,
    )
  }
  for (const spec of tries) {
    try {
      const mod = await import(spec)
      if (typeof mod?.defineTool === 'function') return mod.defineTool
    } catch {}
  }
  return fallbackDefineTool
}

const defineTool = await loadDefineTool()

/* ── 小工具 ── */

const clean = value => (typeof value === 'string' ? value.trim() : '')

function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

function run(cmd, args, { cwd, timeoutMs = 1_800_000, env } = {}) {
  return new Promise(done => {
    const child = spawn(cmd, args, {
      cwd,
      // 强制 UTF-8：Windows 下 python 默认可能用 GBK 输出，中文日志和 RESULT 行会乱码/解析失败。
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...process.env, ...(env ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      done({ code: -1, out, err: err + `\n超时（${Math.round(timeoutMs / 1000)}s）` })
    }, timeoutMs)
    child.stdout.on('data', d => {
      out += d.toString()
    })
    child.stderr.on('data', d => {
      err += d.toString()
    })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code: -2, out, err: err + String(error.message || error) })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done({ code: code ?? -1, out, err })
    })
  })
}

/**
 * 有些宿主进程的 PATH 里没有 python（桌面端常这样）。
 * 按候选逐个试：配置值 → 环境变量 → PATH 上的常见名 → Windows 用户级安装目录。
 * 不写死任何个人路径，换机器也能用。
 */
function pythonCandidates(preferred) {
  const list = []
  const push = item => {
    if (item && !list.includes(item)) list.push(item)
  }
  push(preferred)
  push(process.env.DSH_PYTHON)
  push(process.env.PYTHON)
  push('python')
  push('python3')
  push('py')
  if (process.platform === 'win32') {
    const base = join(homedir(), 'AppData', 'Local', 'Programs', 'Python')
    try {
      for (const dir of readdirSync(base)) {
        const exe = join(base, dir, 'python.exe')
        if (existsSync(exe)) push(exe)
      }
    } catch {}
  }
  return list
}

async function runPython(preferred, argv, opts) {
  const tried = pythonCandidates(preferred)
  let last = { code: -2, out: '', err: 'python 未找到' }
  for (const cmd of tried) {
    const result = await run(cmd, argv, opts)
    if (result.code !== -2 || !/ENOENT/.test(result.err)) return result
    last = result
  }
  return {
    ...last,
    err: `${last.err}\n已尝试：${tried.join(', ')}。可把插件配置的 pythonPath 设成 python.exe 的绝对路径（环境变量 DSH_PYTHON 也可以）。`,
  }
}

/** 探针：确认到底哪个 python 能用，给自检工具用。 */
async function probePython(preferred) {
  const tried = pythonCandidates(preferred)
  for (const cmd of tried) {
    const r = await run(cmd, ['-c', 'import sys;print(sys.version.split()[0])'], { timeoutMs: 20_000 })
    if (r.code === 0) return { ok: true, cmd, version: r.out.trim() || '?', tried }
  }
  return { ok: false, tried }
}

function tail(text, lines = 6) {
  return String(text || '')
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n')
}

/**
 * 把随包的技能铺到 <DSH_HOME>/skills/。
 * 注意：绝不能"先删后拷"——拷贝中途失败会让技能凭空消失（出过一次）。
 * 这里先完整拷到 staging，校验通过后再用 rename 换上去，失败就保留原样。
 */
function installSkill(skillName, logger) {
  const target = join(dshHome(), 'skills', skillName)
  const marker = join(target, '.installed-version')
  const staging = `${target}.staging-${process.pid}`
  const backup = `${target}.old-${process.pid}`
  try {
    const src = join(PKG_DIR, 'skills', skillName)
    if (!existsSync(src)) return { ok: false, reason: `包内缺少 skills/${skillName}` }

    const installed = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
    const intact = existsSync(join(target, 'SKILL.md'))
    if (installed === SKILL_VERSION && intact) return { ok: true, path: target, changed: false }

    mkdirSync(dirname(target), { recursive: true })
    rmSync(staging, { recursive: true, force: true })
    cpSync(src, staging, { recursive: true })
    if (!existsSync(join(staging, 'SKILL.md'))) throw new Error('复制结果不完整（缺 SKILL.md）')
    writeFileSync(join(staging, '.installed-version'), SKILL_VERSION, 'utf8')

    rmSync(backup, { recursive: true, force: true })
    if (existsSync(target)) renameSync(target, backup)
    try {
      renameSync(staging, target)
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, target)
      throw error
    }
    rmSync(backup, { recursive: true, force: true })

    logger?.info?.(`film-studio: 技能 ${skillName} 已更新到 ${target}`)
    return { ok: true, path: target, changed: true }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (!existsSync(target) && existsSync(backup)) {
      try {
        renameSync(backup, target)
      } catch {}
    }
    logger?.warn?.(`film-studio: 安装技能 ${skillName} 失败 ${error.message}`)
    return { ok: false, reason: error.message }
  }
}

/* ── 插件主体 ── */

export function apply(ctx, config = {}) {
  const python = clean(config.pythonPath) || 'python'
  const skillPath = () => join(dshHome(), 'skills', SKILL_NAME)
  const workflowOf = exec =>
    clean(config.workspace) || clean(exec?.agent?.session?.header?.cwd) || process.cwd()
  const apiKeyOf = () => clean(config.apiKey)
  const baseUrlOf = () => clean(config.baseUrl) || 'https://dashscope.aliyuncs.com'
  /**
   * 所有传入路径一律按工作区解析：相对路径以工作区为根，绝对路径原样返回。
   * 之前直接把参数当 cwd 用，相对路径会让 spawn 报 "python ENOENT"（其实是目录不存在）。
   */
  const inWorkspace = (p, exec) => {
    const raw = clean(p)
    const root = workflowOf(exec)
    return raw ? resolve(root, raw) : root
  }
  const jobDir = () => {
    const dir = join(dshHome(), 'cache', 'film-studio')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  // 启动标记：apply 到底有没有跑起来，重启后看这个文件就知道，不用猜。
  let loadState = 'ok'
  try {
    const dir = jobDir()
    writeFileSync(
      join(dir, 'loaded.json'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, config: { voice: config.defaultVoice ?? null, rate: config.defaultRate ?? null }, hasKey: Boolean(apiKeyOf()) }, null, 2),
      'utf8',
    )
  } catch (error) {
    loadState = error.message
  }

  const registered = []
  const skillStates = SKILL_NAMES.map(n => ({ name: n, ...installSkill(n, ctx.logger) }))
  if (loadState !== 'ok') ctx.logger?.warn?.(`film-studio: 启动标记写入失败（${loadState}）`)

  ctx.effect(
    () => {
      const d = ctx.tools.register(
        defineTool({
          name: 'film_voice',
          description:
            '给短视频配旁白：调用阿里云 qwen-audio-3.1-tts-next 逐句合成，自动做参考音色锁（避免逐句换人导致"音不准"）、逐句响度对齐、拼接，并生成 voice.wav/timings.json/timeline.js。传 refAudio 可锁住同一把声音，sceneGroups 可把句子映射成场景切点。',
          parameters: {
            sentences: {
              type: 'array',
              items: { type: 'string' },
              required: true,
              description: '逐句台词，一句一个元素；画面切点按句计算。',
            },
            voice: {
              type: 'string',
              description:
                '官方固定音色 ID，默认 xuxiaoqiao_v3.1（徐小俏）。其他可选：qiaoxiaojiao_v3.1（乔小娇）、yunhuanhuan_v3.1（云欢欢）、xiaxiaochen_v3.1（夏小晨）。固定音色不会逐句换人。',
            },
            rate: {
              type: 'number',
              description: '语速，1.0 原速；0.92 更从容，0.85 明显放慢。默认 0.92。',
            },
            refAudio: {
              type: 'string',
              description: '参考音色音频路径（wav/mp3，建议 5–20 秒干净人声）。传了就锁同一把声音。',
            },
            outDir: { type: 'string', description: '输出目录，默认当前工作区。' },
            seed: { type: 'number', description: '随机种子，便于复现同一版声音。' },
            sceneGroups: {
              type: 'object',
              additionalProperties: true,
              description: '场景分组：{"hook":[0,1],"p1":[2,3]}，值为该场景第一句的下标范围；用于生成 timeline.js。',
            },
            asrCheck: {
              type: 'boolean',
              description: '是否逐句 ASR 回读校验发音（会让合成时间翻倍）。',
            },
            gap: { type: 'number', description: '句间静音秒数，默认 0.30。' },
            leadingSilence: { type: 'number', description: '开头留白秒数，默认 0.45。' },
            tail: { type: 'number', description: '结尾留白秒数，默认 2.65。' },
            character: { type: 'string', description: '角色设定（音色/年龄/气质），会前置到提示词。' },
            style: { type: 'string', description: '表达方式（语速/停顿/情绪）。' },
          },
          output: TEXT_OUTPUT,
          timeoutMs: 2_400_000,
          async execute(args, exec) {
            const outDir = inWorkspace(args.outDir, exec)
            try {
              mkdirSync(outDir, { recursive: true })
            } catch (error) {
              return { text: `输出目录不可用：${outDir}\n${error.message}` }
            }
            const job = {
              sentences: args.sentences,
              outDir,
              voice: clean(args.voice) || clean(config.defaultVoice) || 'xuxiaoqiao_v3.1',
              rate: Number.isFinite(args.rate) ? args.rate
                : (Number.isFinite(config.defaultRate) ? config.defaultRate : 0.92),
              refAudio: clean(args.refAudio) || undefined,
              seed: args.seed,
              sceneGroups: args.sceneGroups,
              asrCheck: args.asrCheck === true,
              gap: args.gap,
              leadingSilence: args.leadingSilence,
              tail: args.tail,
              character: clean(args.character) || undefined,
              style: clean(args.style) || undefined,
              apiKey: apiKeyOf() || undefined,
              baseUrl: baseUrlOf(),
            }
            const jobFile = join(jobDir(), `voice-job-${Date.now()}.json`)
            writeFileSync(jobFile, JSON.stringify(job, null, 1), 'utf8')
            const r = await runPython(python, [join(PKG_DIR, 'scripts', 'filmvoice.py'), '--job', jobFile], {
              cwd: outDir,
              env: { ALIYUN_BAILIAN_API_KEY: apiKeyOf() || '', ALIYUN_BAILIAN_BASE_URL: baseUrlOf() },
            })
            const line = r.out.split(/\r?\n/).reverse().find(x => x.startsWith('RESULT:'))
            if (!line) {
              return { text: `配音失败（退出码 ${r.code}）\n${tail(r.err, 8)}` }
            }
            let data
            try {
              data = JSON.parse(line.slice('RESULT:'.length))
            } catch {
              return { text: `配音返回无法解析：${line.slice(0, 200)}` }
            }
            if (!data.ok) return { text: `配音失败：${data.error}` }
            const bad = (data.asr || []).filter(
              row => row.asr && row.asr.replace(/[\s，。、]/g, '') !== String(row.text).replace(/[\s，。、]/g, ''),
            )
            const lines = [
              `配音完成：${data.dur}s（人声到 ${data.speechEnd}s）`,
              `音色 ${job.voice}，语速 ${job.rate}`,
              `人声轨 ${data.voiceWav}`,
              `时间轴 ${data.timeline}`,
              `逐句：${data.items.map(x => `${x.dur}s`).join(' / ')}`,
            ]
            if (data.asr?.length) {
              lines.push(bad.length ? `回读有 ${bad.length} 句不一致：` : '回读 13 句全部一致')
              for (const row of bad.slice(0, 5)) lines.push(`  ${row.i}: 原「${row.text}」→ 回「${row.asr}」`)
            }
            return { text: lines.join('\n') }
          },
        }),
      )
      registered.push('film_voice')
      return d
    },
    'film-studio: film_voice',
  )

  ctx.effect(
    () => {
      const d = ctx.tools.register(
        defineTool({
          name: 'film_new',
          description:
            '在当前工作区生成一个能直接渲染的影片工程骨架（4 个场景 + 相机缓推 + 颗粒暗角）。做新片子先调它，再改文案和加场景，不要从空 HTML 手写——手写出来的画面通常压字、字号偏小、没有节奏。',
          parameters: {
            name: { type: 'string', required: true, description: '工程目录名，如 github-weekly。' },
            style: {
              type: 'string',
              description: '风格预设，默认 paper-press（米白纸感）。其他常用：swiss、neubrutalism、glassmorphism，见 fm.py styles。',
            },
            ratio: { type: 'string', description: '画幅，默认 16:9。' },
            dur: { type: 'number', description: '初始时长秒数，默认 12；接上配音后由 timeline.js 决定。' },
            title: { type: 'string', description: '标题，写进页面 title 和开场文案。' },
          },
          output: TEXT_OUTPUT,
          timeoutMs: 300_000,
          async execute(args, exec) {
            const name = clean(args.name)
            if (!name) return { text: '缺少 name（工程目录名）' }
            const root = workflowOf(exec)
            const target = inWorkspace(name, exec)
            const fm = join(skillPath(), 'scripts', 'fm.py')
            if (!existsSync(fm)) return { text: `找不到 ${fm}，技能可能没装好` }
            const argv = [fm, 'new', target, '--style', clean(args.style) || 'paper-press',
              '--ratio', clean(args.ratio) || '16:9']
            if (Number.isFinite(args.dur)) argv.push('--dur', String(args.dur))
            if (clean(args.title)) argv.push('--title', clean(args.title))
            const r = await runPython(python, argv, { cwd: root })
            if (r.code !== 0) return { text: `生成骨架失败（退出码 ${r.code}）\n${tail(r.err, 8)}` }
            return {
              text: [
                `工程已生成：${target}`,
                '下一步：改 index.html 里的文案 → film_voice 配音（默认小俏、语速 0.92）→ film_check → film_render。',
                '要角色或插画时再调 generate_image 生图，数字/流程/对比这类内容用排版解决，不要生图。',
              ].join('\n'),
            }
          },
        }),
      )
      registered.push('film_new')
      return d
    },
    'film-studio: film_new',
  )

  ctx.effect(
    () => {
      const d = ctx.tools.register(
        defineTool({
          name: 'film_check',
          description:
            '渲染前检查 flash-motion 工程：确定性、文字压叠、留白、字号等。返回错误/警告数量，0 错误才建议渲染。',
          parameters: {
            projectDir: { type: 'string', description: '工程目录（含 index.html），默认当前工作区。' },
            html: { type: 'string', description: '入口文件，默认 index.html。' },
          },
          output: TEXT_OUTPUT,
          timeoutMs: 600_000,
          async execute(args, exec) {
            const cwd = inWorkspace(args.projectDir, exec)
            if (!existsSync(cwd)) {
              return { text: `工程目录不存在：${cwd}\n相对路径按工作区解析；也可以直接传绝对路径。` }
            }
            const fm = join(skillPath(), 'scripts', 'fm.py')
            if (!existsSync(fm)) return { text: `找不到 ${fm}，技能可能没装好` }
            const r = await runPython(python, [fm, 'check', clean(args.html) || 'index.html'], { cwd })
            const summary = r.out.split(/\r?\n/).filter(x => x.includes('check 完成') || x.includes('[ERR]') || x.includes('[WARN]'))
            return {
              text: `${summary.join('\n') || tail(r.out, 4) || tail(r.err, 6)}`.trim(),
            }
          },
        }),
      )
      registered.push('film_check')
      return d
    },
    'film-studio: film_check',
  )

  ctx.effect(
    () => {
      const d = ctx.tools.register(
        defineTool({
          name: 'film_render',
          description:
            '把 flash-motion 工程渲染成 MP4（Playwright 逐帧 + ffmpeg 合成）。1080p 大约每 100 帧 30 秒，整片通常 5–12 分钟，调用会一直等到渲染结束。',
          parameters: {
            projectDir: { type: 'string', description: '工程目录（含 index.html），默认当前工作区。' },
            html: { type: 'string', description: '入口文件，默认 index.html。' },
            out: { type: 'string', description: '输出文件，默认 out/film.mp4。' },
            mblur: { type: 'number', description: '运动模糊子帧数，0 关闭，2 为常用值。' },
            workers: { type: 'number', description: '并行渲染进程数，默认 3。' },
            audio: { type: 'boolean', description: '是否一并生成音轨，默认 true。' },
            force: { type: 'boolean', description: '覆盖已存在的输出文件。' },
          },
          output: TEXT_OUTPUT,
          timeoutMs: 2_400_000,
          async execute(args, exec) {
            const cwd = inWorkspace(args.projectDir, exec)
            if (!existsSync(cwd)) {
              return { text: `工程目录不存在：${cwd}\n相对路径按工作区解析；也可以直接传绝对路径。` }
            }
            const fm = join(skillPath(), 'scripts', 'fm.py')
            if (!existsSync(fm)) return { text: `找不到 ${fm}，技能可能没装好` }

            // 同一个工程同时跑两次渲染会互相覆盖帧文件，这里用锁文件挡住。
            const lock = join(cwd, '.film-render.lock')
            try {
              const holder = Number(readFileSync(lock, 'utf8').trim())
              if (holder && holder !== process.pid) {
                process.kill(holder, 0)
                return { text: `这个工程正在渲染（PID ${holder}），等它跑完再来。\n如果确认已经中断，删掉 ${lock} 再试。` }
              }
            } catch {}
            writeFileSync(lock, String(process.pid), 'utf8')

            try {
              const argv = [fm, 'render', clean(args.html) || 'index.html',
                '--out', clean(args.out) || join('out', 'film.mp4'),
                '--mblur', String(Number.isFinite(args.mblur) ? args.mblur : 2),
                '--workers', String(Number.isFinite(args.workers) ? args.workers : 3)]
              if (args.audio === false) argv.push('--no-audio')
              if (args.force !== false) argv.push('--force')
              const r = await runPython(python, argv, { cwd })
              const keys = ['[OK]', '[ERR]', '[INFO] 渲染']
              const summary = r.out.split(/\r?\n/).filter(x => keys.some(k => x.startsWith(k)))
              const t = summary.slice(-4).join('\n') || tail(r.err, 8)
              return { text: r.code === 0 ? `${t}\n渲染完成` : `渲染失败（退出码 ${r.code}）\n${t}` }
            } finally {
              rmSync(lock, { force: true })
            }
          },
        }),
      )
      registered.push('film_render')
      return d
    },
    'film-studio: film_render',
  )

  ctx.effect(
    () => {
      const d = ctx.tools.register(
        defineTool({
          name: 'film_doctor',
          description:
            '自检短片工坊的运行环境：代码从哪加载、版本是否一致、两个技能是否装好、python 能不能用、密钥是否配置、工作区是否可写。工具"看不到"或"一调用就报错"时先跑它，一条命令看清是哪一层坏了。',
          parameters: {},
          output: TEXT_OUTPUT,
          timeoutMs: 120_000,
          async execute(args, exec) {
            const rows = []
            rows.push(`代码：${fileURLToPath(import.meta.url)}`)
            try {
              const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
              rows.push(`插件版本：${pkg.version}｜技能应装版本：${SKILL_VERSION}`)
            } catch (error) {
              rows.push(`插件版本：读不到 package.json（${error.message}）`)
            }

            for (const skillName of SKILL_NAMES) {
              const dir = join(dshHome(), 'skills', skillName)
              const hasFile = existsSync(join(dir, 'SKILL.md'))
              const marker = join(dir, '.installed-version')
              const v = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '无'
              const stale = v !== SKILL_VERSION ? '（需更新）' : ''
              rows.push(`技能 ${skillName}：${hasFile ? '已装' : '缺失'}，版本 ${v}${stale}`)
            }

            const probe = await probePython(python)
            rows.push(
              probe.ok
                ? `python：可用（${probe.cmd}，${probe.version}）`
                : `python：不可用，试过 ${probe.tried.join('、')}；把 pythonPath 设成 python.exe 绝对路径`,
            )

            rows.push(`密钥：${apiKeyOf() ? '已配置' : '未配置（配音会失败，其余功能可用）'}`)

            const root = workflowOf(exec)
            let writable = false
            try {
              const probeFile = join(root, `.film-doctor-${process.pid}`)
              writeFileSync(probeFile, 'ok', 'utf8')
              rmSync(probeFile, { force: true })
              writable = true
            } catch {}
            rows.push(`工作区：${root}（${writable ? '可写' : '不可写'}）`)

            const bad = rows.filter(x => /缺失|不可用|未配置|不可写|需更新|读不到/.test(x))
            rows.push(bad.length ? `结论：${bad.length} 项需要处理（见上）` : '结论：一切正常')
            return { text: rows.join('\n') }
          },
        }),
      )
      registered.push('film_doctor')
      return d
    },
    'film-studio: film_doctor',
  )

  try {
    writeFileSync(join(jobDir(), 'tools.json'), JSON.stringify({ at: new Date().toISOString(), registered }, null, 2), 'utf8')
  } catch {}

  ctx.effect(() => () => {}, 'film-studio: lifecycle')
  for (const s of skillStates) {
    if (!s.ok) ctx.logger?.warn?.(`film-studio: 技能 ${s.name} 未安装（${s.reason}）`)
  }
}
