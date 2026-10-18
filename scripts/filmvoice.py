#!/usr/bin/env python
"""film_voice 的后端：阿里云 qwen-audio-3.1-tts-next 逐句配音 + 拼接 + 时间轴。

为什么逐句：画面切点要精确到句，整段生成没法可靠切句（实测有时整段不停顿）。
为什么每句都带参考音频：逐句独立生成会各自"选角"，基频在 228–310 Hz 之间飘，
听起来就是"音不准"；带同一段 references 后才锁得住同一个声音。

输入：--job <json>，字段见 load_job()。
输出：stdout 最后一行 RESULT:<json>，其余是进度日志。
"""
import argparse
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_CHARACTER = (
    "人物：{ref}二十二岁的年轻女生，声音甜美软糯、清亮有少女感，带一点笑意，"
    "不要播音腔、不要念稿感。")
DEFAULT_STYLE = (
    "表达方式：像认真跟朋友讲一件新鲜事，语速适中、比日常说话稍慢一点，吐字清楚，"
    "逗号和句号处都要有明显停顿，句尾自然落下，不要赶。只要人声，不要背景音乐和音效。")
MODEL = "qwen-audio-3.1-tts-next"
FLASH_MODEL = "qwen-audio-3.1-tts-flash"
DEFAULT_VOICE = "xuxiaoqiao_v3.1"      # 官方固定音色：徐小俏
DEFAULT_RATE = 0.92                    # 语速，1.0 为原速；0.92 更从容
TARGET_LUFS = -20.0


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def ff(*args, check=True):
    return subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
                          check=check, capture_output=True)


def probe_dur(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def lufs(path):
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path),
                        "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
    m = re.findall(r"I:\s*(-?\d+\.\d+)\s*LUFS", p.stderr)
    return float(m[-1]) if m else None


def f0(path):
    """基频中位数，只作为"音色是否漂移"的粗查，不当作验收。"""
    try:
        import numpy as np
    except ImportError:
        return None
    p = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
                        "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                       capture_output=True, check=True)
    x = np.frombuffer(p.stdout, dtype=np.int16).astype(np.float32) / 32768
    win, hop = int(0.04 * 16000), int(0.02 * 16000)
    lo, hi = int(16000 / 400), int(16000 / 70)
    vals = []
    for i in range(0, len(x) - win, hop):
        fr = x[i:i + win]
        if np.sqrt((fr ** 2).mean()) < 0.02:
            continue
        fr = fr - fr.mean()
        ac = np.correlate(fr, fr, mode="full")[win - 1:]
        if hi >= len(ac):
            continue
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] < 0.3 * ac[0]:
            continue
        vals.append(16000 / lag)
    return round(float(np.median(vals)), 1) if vals else None


def post(url, body, key, timeout=600):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + key,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


class Voice:
    """三种配音方式，优先级：固定音色(voice) > 参考音频(refAudio) > 纯文字描述。

    固定音色走 qwen-audio-3.1-tts-flash，voice 是官方音色 ID，天然不会逐句换人；
    references 走 qwen-audio-3.1-tts-next，用一段录音把音色锁住；
    都没有时才用提示词描述选角——这种最不稳，只作兜底。
    """

    def __init__(self, job, key, base):
        self.job = job
        self.key = key
        self.tts_url = base.rstrip("/") + "/api/v1/services/audio/tts/SpeechSynthesizer"
        self.asr_url = base.rstrip("/") + "/api/v1/services/aigc/multimodal-generation/generation"
        self.voice = (job.get("voice") or "").strip() or None
        self.rate = job.get("rate")
        self.ref = job.get("refAudio")
        self.ref_b64 = None
        if self.ref:
            p = pathlib.Path(self.ref)
            if not p.exists():
                raise FileNotFoundError(f"参考音频不存在：{p}")
            self.ref_b64 = base64.b64encode(p.read_bytes()).decode()

    def _prompt(self, text):
        character = self.job.get("character") or DEFAULT_CHARACTER.format(
            ref="参考@voice1 的音色，保持同样的声线、年龄感和音高，" if self.ref else "")
        style = self.job.get("style") or DEFAULT_STYLE
        return f"创作任务：给一条科技短视频配旁白。{character}{style}台词（小鱼）：「{text}」"

    def synth(self, text):
        if self.voice:
            inp = {"text": text, "voice": self.voice, "format": "wav",
                   "sample_rate": int(self.job.get("sampleRate", 48000)), "channels": 2}
            body = {"model": self.job.get("model") or FLASH_MODEL, "input": inp}
            params = {}
            if self.rate is not None:
                params["rate"] = float(self.rate)
            if self.job.get("seed") is not None:
                params["seed"] = int(self.job["seed"])
            if params:
                body["parameters"] = params
        else:
            inp = {"text_prompt": self._prompt(text), "format": "wav",
                   "sample_rate": int(self.job.get("sampleRate", 48000)),
                   "channels": 2}
            if self.ref_b64:
                inp["references"] = [{"audio_data": self.ref_b64}]
            body = {"model": self.job.get("model") or MODEL, "input": inp}
            if self.job.get("seed") is not None:
                body["parameters"] = {"seed": int(self.job["seed"])}
        last = None
        for attempt in range(3):
            try:
                d = post(self.tts_url, body, self.key)
                audio = (d.get("output") or {}).get("audio") or {}
                if audio.get("url"):
                    return audio["url"], audio.get("duration")
                last = f"没有返回音频：{json.dumps(d, ensure_ascii=False)[:200]}"
            except urllib.error.HTTPError as e:
                try:
                    j = json.loads(e.read().decode())
                    last = f"{e.code} {j.get('code')}: {str(j.get('message'))[:160]}"
                except Exception:  # noqa: BLE001
                    last = f"{e.code}"
            except Exception as e:  # noqa: BLE001
                last = f"{type(e).__name__}: {e}"
            time.sleep(2 + attempt * 3)
        raise RuntimeError(f"合成失败：{last}")

    def asr(self, url):
        d = post(self.asr_url, {"model": "qwen3-asr-flash", "input": {"messages": [
            {"role": "user", "content": [{"audio": url}]}]}}, self.key)
        txt = ""
        for ch in ((d.get("output") or {}).get("choices") or []):
            c = (ch.get("message") or {}).get("content")
            if isinstance(c, list):
                txt += "".join([x.get("text", "") for x in c if isinstance(x, dict)])
            elif isinstance(c, str):
                txt += c
        return txt.strip()


def timeline_js(cuts, dur, groups):
    """按场景分组写 timeline.js：每个场景从它第一句的开始时间起。"""
    scenes = []
    for name in sorted(groups, key=lambda k: groups[k][0]):
        idx = groups[name][0]
        if idx < len(cuts):
            scenes.append((name, round(cuts[idx], 3)))
    lines = ["// 由 film_voice 自动生成：场景切点来自配音实际时长", "window.TL = {"]
    lines.append(f"  dur: {round(dur, 3)},")
    lines.append("  C: {")
    for i, (name, t) in enumerate(scenes):
        key = f"s{i + 1}"
        lines.append(f"    {key}: {t},   // {name}")
    lines.append("  }")
    lines.append("};")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    args = ap.parse_args()
    job = json.loads(pathlib.Path(args.job).read_text(encoding="utf-8"))

    key = (job.get("apiKey") or os.environ.get("ALIYUN_BAILIAN_API_KEY")
           or os.environ.get("DASHSCOPE_API_KEY") or "").strip()
    if not key:
        print("RESULT:" + json.dumps({"ok": False, "error": "缺少 API Key（ALIYUN_BAILIAN_API_KEY）"},
                                     ensure_ascii=False))
        return 1
    base = (job.get("baseUrl") or os.environ.get("ALIYUN_BAILIAN_BASE_URL")
            or "https://dashscope.aliyuncs.com").strip()

    sentences = [s.strip() for s in job.get("sentences") or [] if s and s.strip()]
    if not sentences:
        print("RESULT:" + json.dumps({"ok": False, "error": "sentences 为空"}, ensure_ascii=False))
        return 1

    out_dir = pathlib.Path(job.get("outDir") or ".").resolve()
    seg_dir = out_dir / "voice_seg"
    seg_dir.mkdir(parents=True, exist_ok=True)
    sr = int(job.get("sampleRate", 48000))
    gap = float(job.get("gap", 0.30))
    lead = float(job.get("leadingSilence", 0.45))
    tail = float(job.get("tail", 2.65))
    fps = int(job.get("fps", 30))
    asr_check = bool(job.get("asrCheck"))

    # 默认用官方固定音色（小俏）：不指定任何音色来源时不必靠提示词选角
    if not (job.get("voice") or "").strip() and not job.get("refAudio"):
        job["voice"] = job.get("defaultVoice") or DEFAULT_VOICE
    if job.get("rate") is None:
        job["rate"] = job.get("defaultRate") or DEFAULT_RATE
    engine = ("固定音色 " + job["voice"]) if job.get("voice") else (
        "参考音频 " + str(job.get("refAudio")) if job.get("refAudio") else "提示词描述")
    log(f"[配音] 引擎：{engine}，语速 {job.get('rate')}")

    voice = Voice(job, key, base)
    marks, pieces, asr_rows = [], [], []
    t = lead

    for i, text in enumerate(sentences):
        url, dur = voice.synth(text)
        raw = seg_dir / f"raw_{i:02d}.wav"
        urllib.request.urlretrieve(url, raw)
        seg = seg_dir / f"seg_{i:02d}.wav"
        ff("-i", str(raw), "-ar", str(sr), "-ac", "2", "-c:a", "pcm_s16le", str(seg))
        l = lufs(seg)
        if l is not None:
            gain = max(-12.0, min(12.0, TARGET_LUFS - l))
            if abs(gain) > 0.4:
                norm = seg_dir / f"norm_{i:02d}.wav"
                ff("-i", str(seg), "-af", f"volume={gain:.2f}dB", "-ar", str(sr), "-ac", "2",
                   "-c:a", "pcm_s16le", str(norm))
                seg = norm
        d = probe_dur(seg)
        marks.append({"i": i, "text": text, "start": round(t, 3),
                      "end": round(t + d, 3), "dur": round(d, 3), "f0": f0(seg)})
        pieces.append(seg)
        t += d + gap
        if asr_check:
            try:
                got = voice.asr(url)
            except Exception as e:  # noqa: BLE001
                got = f"<ASR失败 {type(e).__name__}>"
            asr_rows.append({"i": i, "text": text, "asr": got})
        log(f"[{i:02d}] {d:5.2f}s {text[:24]}")

    speech_end = marks[-1]["end"]
    dur_total = round((speech_end + tail) * fps) / fps

    sil = seg_dir / "sil.wav"
    ff("-f", "lavfi", "-i", f"anullsrc=r={sr}:cl=stereo", "-t", f"{gap:.3f}",
       "-c:a", "pcm_s16le", str(sil))
    head = seg_dir / "head.wav"
    ff("-f", "lavfi", "-i", f"anullsrc=r={sr}:cl=stereo", "-t", f"{lead:.3f}",
       "-c:a", "pcm_s16le", str(head))
    lst = seg_dir / "list.txt"
    parts = [head]
    for i, p in enumerate(pieces):
        parts.append(p)
        if i < len(pieces) - 1:
            parts.append(sil)
    with open(lst, "w", encoding="utf-8") as f:
        for p in parts:
            f.write("file '" + str(p).replace("'", "'\\''") + "'\n")
    voice_wav = out_dir / "voice.wav"
    ff("-f", "concat", "-safe", "0", "-i", str(lst), "-t", f"{dur_total:.3f}",
       "-ar", str(sr), "-ac", "2", "-c:a", "pcm_s16le", str(voice_wav))

    (out_dir / "timings.json").write_text(json.dumps(
        {"dur": dur_total, "speechEnd": round(speech_end, 3), "items": marks,
         "asr": asr_rows}, ensure_ascii=False, indent=1), encoding="utf-8")

    groups = job.get("sceneGroups") or {f"句{i}": [i, i] for i in range(len(sentences))}
    cuts = [m["start"] for m in marks]
    (out_dir / "timeline.js").write_text(timeline_js(cuts, dur_total, groups), encoding="utf-8")

    result = {
        "ok": True,
        "dur": round(dur_total, 2),
        "speechEnd": round(speech_end, 2),
        "voiceWav": str(voice_wav),
        "timeline": str(out_dir / "timeline.js"),
        "items": [{"i": m["i"], "dur": m["dur"], "f0": m["f0"]} for m in marks],
        "asr": asr_rows,
    }
    print("RESULT:" + json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
