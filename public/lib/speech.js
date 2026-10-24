// =============================================================
//  読み上げ（ブラウザの音声合成・日本語の声）の共通部品
//  - 完全にブラウザ側だけの機能（サーバーは関係ない）。今後のゲームでも使える
//  使い方:  import { speak, isAvailable, isEnabled, setEnabled } from '/lib/speech.js';
//    speak(text, { pitch })  … 読み上げる（前の読み上げは止める）
//    isAvailable()           … 日本語の声が使えるか（使えないならトグルを出さない）
//    isEnabled()             … オンかどうか（既定オン・localStorage に保存）
//    setEnabled(on)          … オン/オフ（オフにしたら今の読み上げも止める）
// =============================================================
const KEY = 'gamehub-tts'; // 'on' / 'off'（キーが無ければオン）
const hasSynth = typeof window !== 'undefined' && 'speechSynthesis' in window;
let jaVoice = null;

function findJaVoice() {
  if (!hasSynth) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  // lang が ja で始まる声（日本語）の最初のもの
  return voices.find(v => /^ja/i.test(v.lang || '')) || null;
}
if (hasSynth) {
  jaVoice = findJaVoice();
  // 声の一覧は非同期で届くことがあるので、届いたら取り直す
  try { window.speechSynthesis.addEventListener('voiceschanged', () => { jaVoice = findJaVoice(); }); } catch {}
  // 自動再生制限対策：最初のユーザー操作（効果音のロック解除と同じタイミング）で1回だけ空発話
  const wake = () => { warmUp(); window.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake); };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
}
function voice() { if (!jaVoice) jaVoice = findJaVoice(); return jaVoice; }

export function isAvailable() { return hasSynth && !!voice(); }
export function isEnabled() { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } } // 既定オン
export function setEnabled(on) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} if (!on) cancel(); }
export function cancel() { if (hasSynth) { try { window.speechSynthesis.cancel(); } catch {} } }

// フレーズを読み上げる。pitch は 0.9〜1.3 くらいで渡すと面白い。速さは 1.0 固定
export function speak(text, { pitch } = {}) {
  if (!isEnabled() || !isAvailable()) return;
  const t = String(text == null ? '' : text).trim();
  if (!t) return;
  try {
    window.speechSynthesis.cancel(); // 前の読み上げを止めてから
    const u = new SpeechSynthesisUtterance(t);
    const v = voice();
    if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'ja-JP'; }
    u.pitch = typeof pitch === 'number' ? Math.max(0, Math.min(2, pitch)) : 1;
    u.rate = 1.0;
    window.speechSynthesis.speak(u);
  } catch {}
}

// 自動再生制限に備えて、最初のユーザー操作で空の発話を1回流してロックを解除する
export function warmUp() {
  if (!hasSynth) return;
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u); } catch {}
}
