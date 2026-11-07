import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { HostSettings } from '@tandem/protocol';
import { makeSilenceWav, sttCapabilities, transcribeAudio } from '../src/stt.js';

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tandem-stt-test-'));
  const bin = path.join(dir, 'whisper-fake');
  const model = path.join(dir, 'ggml-fake.bin');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      'out=""',
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -of) out="$2"; shift 2 ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      'printf "语音输入测试" > "$out.txt"',
      '',
    ].join('\n'),
    'utf8',
  );
  chmodSync(bin, 0o755);
  writeFileSync(model, 'fake model', 'utf8');
  const settings: HostSettings = {
    resumeOnRestart: 'auto',
    voice: { engine: 'whisper-cpp', binaryPath: bin, modelPath: model, language: 'zh' },
  };
  return { dir, settings, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('本机 Whisper 配置可用时转写音频并返回文本', async () => {
  const { settings, cleanup } = setup();
  try {
    const caps = sttCapabilities(settings);
    assert.equal(caps.available, true);
    assert.equal(caps.engine, 'whisper-cpp');
    assert.equal(caps.configured, true);
    const result = await transcribeAudio(settings, makeSilenceWav());
    assert.equal(result.text, '语音输入测试');
    assert.equal(result.engine, 'whisper-cpp');
  } finally {
    cleanup();
  }
});

test('模型路径缺失时给出可操作的提示，不执行子进程', async () => {
  const { dir, settings, cleanup } = setup();
  try {
    const broken: HostSettings = {
      resumeOnRestart: 'auto',
      voice: { engine: 'whisper-cpp', binaryPath: path.join(dir, 'whisper-fake'), modelPath: '', language: 'zh' },
    };
    const caps = sttCapabilities(broken);
    assert.equal(caps.available, false);
    assert.match(caps.error ?? '', /模型/);
    await assert.rejects(() => transcribeAudio(broken, makeSilenceWav()), /模型/);
  } finally {
    cleanup();
  }
});
