// =============================================================
//  効果音（Web Audio API で合成）
//  - 音声ファイルは使わず、その場で波形を作る（著作権の心配なし・追加ファイル不要）
//  - ミュート状態は localStorage 'gamehub-sound' に保存（'off' / 'on'）
//  使い方:  import { play, setMuted, isMuted } from '/lib/sound.js';
// =============================================================
const KEY = 'gamehub-sound';
let ctx = null;
let master = null;

export function isMuted() {
  try { return localStorage.getItem(KEY) === 'off'; } catch { return false; }
}
export function setMuted(bool) {
  try { localStorage.setItem(KEY, bool ? 'off' : 'on'); } catch {}
}

// AudioContext を用意して resume する（ブラウザの自動再生制限対策）
function ensure() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35; // 全体のマスターゲイン
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// 最初の pointerdown / keydown で AudioContext を作成・resume する
function wake() { ensure(); }
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', wake, { once: false });
  window.addEventListener('keydown', wake, { once: false });
}

// 1音（オシレーター）。from→to はピッチスライド（同じなら一定）
function tone(type, from, to, t0, dur, peak = 0.8) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

// ホワイトノイズ（card 用の「パサッ」、flip 用の「シュッ」）
function noise(t0, dur, freq, peak = 0.9, filterType = 'bandpass') {
  const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = filterType;
  bp.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bp).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.03);
}

// 効果音を鳴らす。ミュート中は何もしない
export function play(name) {
  if (isMuted()) return;
  if (!ensure()) return;
  const t = ctx.currentTime + 0.001;
  switch (name) {
    case 'card': // カードを出した：ホワイトノイズ 70ms
      noise(t, 0.07, 1800, 0.9);
      break;
    case 'trick': // トリック決定：triangle 660→880 の2音
      tone('triangle', 660, 660, t, 0.11, 0.8);
      tone('triangle', 880, 880, t + 0.11, 0.11, 0.8);
      break;
    case 'turn': // 自分の番：sine 523→659→784、余韻200ms
      tone('sine', 523, 523, t, 0.09, 0.7);
      tone('sine', 659, 659, t + 0.09, 0.09, 0.7);
      tone('sine', 784, 784, t + 0.18, 0.09 + 0.2, 0.7);
      break;
    case 'ready': // 準備OK：sine 1046Hz 60ms（「ポン」）
      tone('sine', 1046, 1046, t, 0.06, 0.7);
      break;
    case 'flip': // カードをめくる：ホワイトノイズ(highpass) ＋ sine 880（「シュッ・ピン」）
      noise(t, 0.04, 2500, 0.6, 'highpass');
      tone('sine', 880, 880, t + 0.03, 0.05, 0.6);
      break;
    case 'penalty': // 失点：triangle 392→262 の2音
      tone('triangle', 392, 392, t, 0.16, 0.8);
      tone('triangle', 262, 262, t + 0.16, 0.16, 0.8);
      break;
    case 'cucumber': // きゅうり：square 400→140 のピッチスライド（控えめ）
      tone('square', 400, 140, t, 0.35, 0.25);
      break;
    case 'win': { // 勝敗決定：sine のアルペジオ
      const arp = [523, 659, 784, 1046];
      arp.forEach((f, i) => tone('sine', f, f, t + i * 0.1, i === arp.length - 1 ? 0.25 : 0.1, 0.7));
      break;
    }
  }
}
