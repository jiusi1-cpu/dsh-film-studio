# 短视频工坊 · dsh-film-studio

给 AI 助手用的**短视频流水线**：一句话需求 → 生成画面骨架 → 阿里云配音 → 自动质检 → 渲染成片。

它解决的问题很具体：让 AI 做视频，通常卡在三件事上——画面从零手写所以糊、配音每句换一个"人"所以听起来跑调、时长写死所以画面和声音对不上。这个包把三件事都钉死了。

## 它到底做了什么

| 环节 | 谁干的 | 为什么这样做 |
|---|---|---|
| 画面 | 纯函数 `seek(t)`，Playwright 逐帧截图 + ffmpeg 合成 | 同一帧永远渲染成同一张图，可复现、可 diff |
| 配音 | 阿里云百炼 `qwen-audio-3.1-tts-flash` 的**固定音色** | 用 prompt 描述音色会逐句"重新选角"，音高能飘 5 个半音；固定音色句与句之间是同一把嗓子 |
| 时间轴 | 配音实测时长 → `timeline.js` | 场景切点、标签点亮、数字滚动全部跟着声音走，不写死 |
| 质检 | 压字检测、字号下限、版面越界、确定性复跑 | 渲染前就拦住"画面很烂"，不用等出片才发现 |

## 核心发现：为什么你的 AI 配音"音不准"

百炼的 `qwen-audio-3.1-tts-next` 是**生成式音色**模型：它没有 voice ID，音色靠 `text_prompt` 描述。每句独立请求 = 每句重新"选角"，实测同一段文案的基频能落在 **228–310 Hz**（约 5 个半音），听感就是"每句换人""跳音"。

换到 `qwen-audio-3.1-tts-flash` + 官方固定 `voice` 参数后，三句测试的基频是 **285.7 / 296.3 / 285.7 Hz**（离散 10.6 Hz）。

所以本包**默认走固定音色**，不用描述词选角。默认 `xuxiaoqiao_v3.1`（徐小俏），语速 `0.92`。

## 安装

### 作为 DSH 桌面端插件

```bash
# 在 DSH 的 profile 目录
pnpm add file:/path/to/dsh-film-studio
```

然后把 `cordis.patch.yml` 里那段 `insert` 加进 profile 的 `cordis.patch.yml`，重启桌面端。

插件会注册四个工具，并把技能铺到 `<DSH_HOME>/skills/`：

- `film_new` — 生成影片工程骨架
- `film_voice` — 配音 + 生成时间轴（默认小俏，不用选）
- `film_check` — 质检，必须 0 错误
- `film_render` — 逐帧渲染成片

### 只想要配音（不装插件）

`scripts/filmvoice.py` 是纯标准库实现，只要 Python 3.9+ 和网络：

```bash
export ALIYUN_BAILIAN_API_KEY=sk-xxxx
export ALIYUN_BAILIAN_BASE_URL=https://dashscope.aliyuncs.com

python scripts/filmvoice.py --job examples/voice.example.json
```

输出 `voice.wav`、`timings.json`、`timeline.js`，并在标准输出打印一行 `RESULT:{...}`。

### 只想要技能

把 `skills/film-studio/` 整个目录复制到你的技能目录（例如 `~/.agents/skills/film-studio`）。

## 使用

```jsonc
// examples/voice.example.json
{
  "sentences": ["第一句…", "第二句…"],
  "outDir": "out/voice",
  "voice": "xuxiaoqiao_v3.1",     // 可省略，默认就是它
  "rate": 0.92,                    // 可省略
  "sceneGroups": { "hook": [0, 0], "point": [1, 1] },
  "gap": 0.30,
  "leadingSilence": 0.45,
  "tail": 2.65
}
```

`sceneGroups` 把句子映射到场景，脚本据此算出每个场景的起止时间并写出 `timeline.js`；你的 HTML 读 `window.TL` 即可。

## 配音参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `voice` | `xuxiaoqiao_v3.1` | 固定音色。备选：`qiaoxiaojiao_v3.1`（小娇）、`yunhuanhuan_v3.1`（欢欢）、`xiaxiaochen_v3.1`（小晨） |
| `rate` | `0.92` | 语速。实测 0.9→6.22s、1.0→5.60s、0.8→7.00s（同一句 5.6s 基准），线性可控 |
| `gap` | `0.30` | 句间静音 |
| `leadingSilence` | `0.45` | 开场留白 |
| `tail` | `2.65` | 片尾余量 |
| `seed` | — | 固定后可复现 |

逐句响度会对齐到 −20 LUFS，级联拼接后整片再统一到 −14 LUFS。

## 画面规范（写 HTML 时遵守）

- 画面是 `seek(t)` 的纯函数：不许出现 `Math.random`、`Date.now`、`requestAnimationFrame`、CSS 动画、SMIL
- 主标题 ≥ 86px @1080p，正文 ≥ 32px，一屏一个焦点
- 除最后 1 秒，不要连续 1.2 秒完全静止；每 1.5–2.5 秒给一个新信息点
- 时长从 `window.TL.dur` 读，不写死

## 配合 flash-motion 使用

`film_new` 依赖 [`flash-motion`](https://github.com/) 技能提供 `fm.py`（生成骨架、联系表、逐帧渲染）。本仓库**不包含**该技能，请自行安装后放到 `<DSH_HOME>/skills/flash-motion/`。

没有它也能用：`filmvoice.py` 独立可用，HTML 你自己写，遵守上面的画面规范即可。

## 目录结构

```
dsh-film-studio/
├─ index.mjs              # DSH 插件入口（注册 4 个工具 + 铺技能）
├─ cordis.patch.yml       # 挂载片段（无密钥）
├─ scripts/filmvoice.py   # 配音 + 时间轴 CLI（纯标准库）
├─ skills/film-studio/    # 完整技能：流程、默认值、何时生图
├─ examples/              # 可直接跑的配音任务
└─ locale/                # 中英文插件名
```

## 已知限制

- **没有真人试听环节**。脚本能保证响度、逐句电平、ASR 回读一致，但好不好听得你自己听。
- 基频估计在高频女声上会八度误判，`f0` 只作粗对照，不要当验收指标。
- 配音是逐句请求，长片（50 句以上）耗时与费用线性增长。
- 只测过北京区域的百炼业务空间。

## License

MIT
