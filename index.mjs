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
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'film-studio'
export const inject = ['tools']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_NAME = 'flash-motion'
const SKILL_VERSION = '1.1.0'

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

/* ── defineTool 兜底 ── */

function paramsToJsonSchema(spec = {}) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = value ?? {}
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false }
}

function fallbackDefineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: paramsToJsonSchema(options.parameters),
    output: {
      schema: options.output?.schema ?? {},
      render: options.output?.render ?? (() => []),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    execute: (args, exec) => options.execute(args, exec),
  }
}

const toolsModule = await import('@deepseek-ai/dsh-tools').catch(() => undefined)
const defineTool = toolsModule?.defineTool ?? fallbackDefineTool

/* ── 小工具 ── */

const clean = value => (typeof value === 'string' ? value.trim() : '')

function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
}

function run(cmd, args, { cwd, timeoutMs = 1_800_000, env } = {}) {
  return new Promise(done => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
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

function tail(text, lines = 6) {
  return String(text || '')
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join('\n')
}

/** 把随包的技能铺到 <DSH_HOME>/skills/，由宿主已有的文件系统提供器自动加载。 */
function installSkill(skillName, logger) {
  const target = join(dshHome(), 'skills', skillName)
  const marker = join(target, '.installed-version')
  try {
    const src = join(PKG_DIR, 'skills', skillName)
    if (!existsSync(src)) return { ok: false, reason: `包内缺少 skills/${skillName}` }
    const installed = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : ''
    if (installed === SKILL_VERSION) return { ok: true, path: target, changed: false }
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    cpSync(src, target, { recursive: true })
    writeFileSync(marker, SKILL_VERSION, 'utf8')
    logger?.info?.(`film-studio: 技能 ${skillName} 已安装到 ${target}`)
    return { ok: true, path: target, changed: true }
  } catch (error) {
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
  const jobDir = () => {
    const dir = join(dshHome(), 'cache', 'film-studio')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const skillStates = ['flash-motion', 'film-studio'].map(n => ({ name: n, ...installSkill(n, ctx.logger) }))

  ctx.effect(
    () =>
      ctx.tools.register(
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
            const outDir = clean(args.outDir) || workflowOf(exec)
            mkdirSync(outDir, { recursive: true })
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
            const r = await run(python, [join(PKG_DIR, 'scripts', 'filmvoice.py'), '--job', jobFile], {
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
      ),
    'film-studio: film_voice',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
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
            const target = resolve(root, name)
            const fm = join(skillPath(), 'scripts', 'fm.py')
            if (!existsSync(fm)) return { text: `找不到 ${fm}。本工具依赖 flash-motion 技能（放在 <DSH_HOME>/skills/flash-motion/ 后重启）；不装也能用 film_voice 单独配音。` }
            const argv = [fm, 'new', target, '--style', clean(args.style) || 'paper-press',
              '--ratio', clean(args.ratio) || '16:9']
            if (Number.isFinite(args.dur)) argv.push('--dur', String(args.dur))
            if (clean(args.title)) argv.push('--title', clean(args.title))
            const r = await run(python, argv, { cwd: root })
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
      ),
    'film-studio: film_new',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
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
            const cwd = clean(args.projectDir) || workflowOf(exec)
            const fm = join(skillPath(), 'scripts', 'fm.py')
            if (!existsSync(fm)) return { text: `找不到 ${fm}。本工具依赖 flash-motion 技能（放在 <DSH_HOME>/skills/flash-motion/ 后重启）；不装也能用 film_voice 单独配音。` }
            const r = await run(python, [fm, 'check', clean(args.html) || 'index.html'], { cwd })
            const summary = r.out.split(/\r?\n/).filter(x => x.includes('check 完成') || x.includes('[ERR]') || x.includes('[WARN]'))
            return {
              text: `${summary.join('\n') || tail(r.out, 4) || tail(r.err, 6)}`.trim(),
            }
          },
        }),
      ),
    'film-studio: film_check',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
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
            const cwd = clean(args.projectDir) || workflowOf(exec)
            const fm = join(skillPath(), 'scripts', 'fm.py')
            if (!existsSync(fm)) return { text: `找不到 ${fm}。本工具依赖 flash-motion 技能（放在 <DSH_HOME>/skills/flash-motion/ 后重启）；不装也能用 film_voice 单独配音。` }
            const argv = [fm, 'render', clean(args.html) || 'index.html',
              '--out', clean(args.out) || join('out', 'film.mp4'),
              '--mblur', String(Number.isFinite(args.mblur) ? args.mblur : 2),
              '--workers', String(Number.isFinite(args.workers) ? args.workers : 3)]
            if (args.audio === false) argv.push('--no-audio')
            if (args.force !== false) argv.push('--force')
            const r = await run(python, argv, { cwd })
            const keys = ['[OK]', '[ERR]', '[INFO] 渲染']
            const summary = r.out.split(/\r?\n/).filter(x => keys.some(k => x.startsWith(k)))
            const t = summary.slice(-4).join('\n') || tail(r.err, 8)
            return { text: r.code === 0 ? `${t}\n渲染完成` : `渲染失败（退出码 ${r.code}）\n${t}` }
          },
        }),
      ),
    'film-studio: film_render',
  )

  ctx.effect(() => () => {}, 'film-studio: lifecycle')
  for (const s of skillStates) {
    if (!s.ok) ctx.logger?.warn?.(`film-studio: 技能 ${s.name} 未安装（${s.reason}）`)
  }
}
