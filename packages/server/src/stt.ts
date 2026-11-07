// 本机语音转写：把客户端上传的短音频交给用户自己配置的 Whisper 可执行文件。
// 不联网、不调用云端；临时文件在请求结束（成功或失败）后立即删除。
import { execFile, spawnSync } from 'node:child_process';
import { accessSync, constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type {
  HostSettings,
  SttCapabilities,
  SttResult,
  SttTestResult,
  VoiceSettings,
} from '@tandem/protocol';
import type { Host } from './host.js';
import { decodeProcessOutput } from './util/encoding.js';
import { expandHome } from './util/path.js';

const execFileAsync = promisify(execFile);
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const RUN_TIMEOUT_MS = 120_000;

export type Engine = 'whisper-cpp' | 'faster-whisper';

interface ResolvedVoice {
  engine: Engine;
  binaryPath: string;
  modelPath: string;
  language: string;
}

interface Detection {
  engine: Engine;
  binaryPath: string;
  note?: string;
}

function fileExists(file: string): boolean {
  try {
    accessSync(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichAll(names: string[]): string[] {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const found: string[] = [];
  for (const name of names) {
    const res = spawnSync(finder, [name], { encoding: 'buffer', timeout: 4000 });
    if (res.status !== 0 || !res.stdout) continue;
    for (const line of decodeProcessOutput(res.stdout).split(/\r?\n/)) {
      const file = line.trim();
      if (file && !found.includes(file)) found.push(file);
    }
  }
  return found;
}

function pythonHasFasterWhisper(python: string): boolean {
  const res = spawnSync(python, ['-c', 'import faster_whisper'], { timeout: 6000 });
  return res.status === 0;
}

/** 探测本机可用的 Whisper 后端；只读，不下载任何模型。 */
export function detectLocalWhisper(): Detection[] {
  const out: Detection[] = [];
  for (const binary of whichAll(['whisper-cli', 'whisper-cpp', 'whisper'])) {
    out.push({ engine: 'whisper-cpp', binaryPath: binary, note: path.basename(binary) });
  }
  for (const python of whichAll(['python3', 'python'])) {
    if (pythonHasFasterWhisper(python)) {
      out.push({ engine: 'faster-whisper', binaryPath: python, note: 'faster-whisper' });
      break;
    }
  }
  return out;
}

function expand(file: string | undefined): string {
  return file?.trim() ? expandHome(file.trim()) : '';
}

function resolveVoice(settings: HostSettings, detected?: Detection[]): { ok: true; voice: ResolvedVoice } | { ok: false; error: string; engine: Engine | null } {
  const voice: VoiceSettings = settings.voice ?? {};
  const candidates = detected ?? detectLocalWhisper();
  const explicitBinary = expand(voice.binaryPath);
  const modelPath = expand(voice.modelPath);
  const language = voice.language?.trim() || 'zh';

  let engine: Engine | null = null;
  let binaryPath = explicitBinary;
  if (voice.engine === 'whisper-cpp' || voice.engine === 'faster-whisper') {
    engine = voice.engine;
    if (!binaryPath) {
      const hit = candidates.find((c) => c.engine === engine);
      binaryPath = hit?.binaryPath ?? '';
    }
  } else if (explicitBinary) {
    const base = path.basename(explicitBinary).toLowerCase();
    engine = base.includes('python') || base.includes('faster') ? 'faster-whisper' : 'whisper-cpp';
  } else {
    engine = candidates[0]?.engine ?? null;
    binaryPath = candidates[0]?.binaryPath ?? '';
  }

  if (!engine || !binaryPath) {
    return {
      ok: false,
      engine: null,
      error: '未找到本机 Whisper。请安装 whisper.cpp（提供 whisper-cli）或 pip 安装 faster-whisper，再在设置里填写可执行文件与模型路径。',
    };
  }
  if (!isExecutable(binaryPath)) {
    return { ok: false, engine, error: `可执行文件不存在或不可执行：${binaryPath}` };
  }
  if (!modelPath) {
    return {
      ok: false,
      engine,
      error:
        engine === 'whisper-cpp'
          ? '未填写模型路径。请下载 ggml-*.bin（如 ggml-small.bin）并在设置里选择。'
          : '未填写 faster-whisper 模型名或目录（如 small）。',
    };
  }
  if (engine === 'whisper-cpp' && !fileExists(modelPath)) {
    return { ok: false, engine, error: `模型文件不存在：${modelPath}` };
  }
  return { ok: true, voice: { engine, binaryPath, modelPath, language } };
}

export function sttCapabilities(settings: HostSettings): SttCapabilities {
  const detected = detectLocalWhisper();
  const resolved = resolveVoice(settings, detected);
  const configured = Boolean(
    settings.voice?.binaryPath?.trim() || settings.voice?.modelPath?.trim(),
  );
  return {
    configured,
    available: resolved.ok,
    engine: resolved.ok ? resolved.voice.engine : resolved.engine,
    binaryPath: resolved.ok ? resolved.voice.binaryPath : undefined,
    modelPath: resolved.ok ? resolved.voice.modelPath : undefined,
    language: settings.voice?.language?.trim() || 'zh',
    detected,
    ...(resolved.ok ? {} : { error: resolved.error }),
  };
}

function cleanTranscript(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[\d:.\s>-]+\]\s*/, '').trim())
    .filter((line) => line && !/^[\[(](blank_audio|silence|music|no speech)[\])]$/i.test(line))
    .join('\n')
    .trim();
}

export function makeSilenceWav(): Buffer {
  const sampleRate = 16000;
  const samples = sampleRate; // 1 秒
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples * 2, 40);
  return buf;
}

function wavInfo(buf: Buffer): { sampleRate: number; channels: number } | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  return { channels: buf.readUInt16LE(22), sampleRate: buf.readUInt32LE(24) };
}

function findFfmpeg(): string | null {
  return whichAll(['ffmpeg'])[0] ?? null;
}

async function ensureWav(input: Buffer, dir: string): Promise<string> {
  const info = wavInfo(input);
  const wavPath = path.join(dir, 'audio.wav');
  if (info && info.sampleRate === 16000 && info.channels === 1) {
    await fs.writeFile(wavPath, input);
    return wavPath;
  }
  // 浏览器端通常已转 16k 单声道 WAV；这里兜底处理旧客户端或 webm/opus。
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const source = path.join(dir, 'audio.source');
    await fs.writeFile(source, input);
    try {
      await execFileAsync(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return wavPath;
    } catch (err) {
      throw new Error(`音频转码失败（ffmpeg）：${(err as Error).message}`);
    }
  }
  throw new Error('音频不是 16kHz 单声道 WAV，且 Host 未安装 ffmpeg，无法转码。请更新客户端后重试。');
}

async function runWhisper(buffer: Buffer, voice: ResolvedVoice): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tandem-stt-'));
  try {
    const wavPath = await ensureWav(buffer, dir);
    if (voice.engine === 'whisper-cpp') {
      const outBase = path.join(dir, 'out');
      const args = [
        '-m', voice.modelPath,
        '-f', wavPath,
        '-l', voice.language,
        '-otxt',
        '-of', outBase,
        '-nt',
        '-np',
      ];
      let stdout = '';
      try {
        const res = await execFileAsync(voice.binaryPath, args, {
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: 20 * 1024 * 1024,
          encoding: 'buffer',
        });
        stdout = decodeProcessOutput(res.stdout);
      } catch (err) {
        const e = err as { stderr?: Buffer; stdout?: Buffer; message: string };
        const detail = e.stderr ? decodeProcessOutput(e.stderr).trim() : '';
        throw new Error(`Whisper 执行失败：${detail || e.message}`);
      }
      let text = '';
      try {
        text = await fs.readFile(`${outBase}.txt`, 'utf8');
      } catch {
        text = stdout;
      }
      return cleanTranscript(text);
    }

    const script = [
      'import sys',
      'from faster_whisper import WhisperModel',
      'model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8")',
      'segments, _ = model.transcribe(sys.argv[2], language=sys.argv[3] or None, vad_filter=True)',
      'print("".join(s.text for s in segments))',
    ].join('\n');
    try {
      const res = await execFileAsync(
        voice.binaryPath,
        ['-c', script, voice.modelPath, wavPath, voice.language],
        { timeout: RUN_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024, encoding: 'buffer' },
      );
      return cleanTranscript(decodeProcessOutput(res.stdout));
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      const detail = e.stderr ? decodeProcessOutput(e.stderr).trim() : '';
      throw new Error(`faster-whisper 执行失败：${detail || e.message}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 转写一段音频；调用方负责只在用户自己的 Host 上使用。 */
export async function transcribeAudio(
  settings: HostSettings,
  audio: Buffer,
): Promise<{ text: string; engine: Engine; elapsedMs: number }> {
  const started = Date.now();
  const resolved = resolveVoice(settings);
  if (!resolved.ok) throw new Error(resolved.error);
  const text = await runWhisper(audio, resolved.voice);
  return { text, engine: resolved.voice.engine, elapsedMs: Date.now() - started };
}

/** 注册 /api/stt 相关路由；由 server.ts 调用一次。 */
export function registerSttRoutes(app: FastifyInstance, host: Host): void {
  app.get('/api/stt/capabilities', async (): Promise<SttCapabilities> => {
    return sttCapabilities(host.settings());
  });

  app.post('/api/stt/test', async (): Promise<SttTestResult> => {
    const started = Date.now();
    const resolved = resolveVoice(host.settings());
    if (!resolved.ok) {
      return { ok: false, elapsedMs: Date.now() - started, error: resolved.error };
    }
    try {
      const result = await transcribeAudio(host.settings(), makeSilenceWav());
      return {
        ok: true,
        text: result.text,
        engine: result.engine,
        elapsedMs: result.elapsedMs,
      };
    } catch (err) {
      return {
        ok: false,
        engine: resolved.voice.engine,
        elapsedMs: Date.now() - started,
        error: (err as Error).message,
      };
    }
  });

  app.post<{ Body: { audioBase64?: unknown; mimeType?: unknown; language?: unknown } }>(
    '/api/stt',
    async (req, reply): Promise<SttResult | undefined> => {
      const started = Date.now();
      const body = req.body ?? {};
      const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
      if (!audioBase64) {
        reply.code(400).send({ error: '缺少音频数据' });
        return;
      }
      if (audioBase64.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 1024) {
        reply.code(413).send({ error: '录音太长（上限约 15MB），请分段录制' });
        return;
      }
      const resolved = resolveVoice(host.settings());
      if (!resolved.ok) {
        reply.code(422).send({ error: resolved.error });
        return;
      }
      const audio = Buffer.from(audioBase64, 'base64');
      if (audio.length < 32) {
        reply.code(400).send({ error: '音频数据为空或损坏' });
        return;
      }
      try {
        const result = await transcribeAudio(host.settings(), audio);
        return {
          ok: true,
          text: result.text,
          engine: result.engine,
          elapsedMs: result.elapsedMs,
        };
      } catch (err) {
        reply.code(500).send({ error: (err as Error).message });
        return;
      }
    },
  );
}
