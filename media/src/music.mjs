// The promo's soundtrack, synthesized here so it is ours: a 120 BPM synthwave loop in A minor
// (Am, F, C, G, one chord a bar) with cues on the promo's beats (promo.html).
//
//   node music.mjs out.wav     writes the 35.5 s track; render.mjs mixes it into the promo
//
// Cues: the jar lands at 4.6 s, flood coins fall in from 5.4 s, nine agents pop in from 7.9 s,
// a card lands in each agent from 15 s, the week learns at 24.85 s, coins pour from 27.7 s,
// the jar becomes the logo at 31.2 s.
import { writeFileSync } from 'node:fs'

export const DURATION = 35.5
const SR = 44100
const BEAT = 0.5 // 120 BPM
const BAR = 2

const midi = m => 440 * 2 ** ((m - 69) / 12)
// [bass root, pad notes] per bar: Am, F, C, G
const CHORDS = [[45, [57, 60, 64]], [41, [53, 57, 60]], [48, [55, 60, 64]], [43, [55, 59, 62]]]
const chordAt = t => CHORDS[Math.floor(t / BAR) % 4]

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }
const rand = rng(7)

export function promoMusic() {
  const n = Math.ceil(DURATION * SR)
  const L = new Float32Array(n), R = new Float32Array(n)
  const sendL = new Float32Array(n), sendR = new Float32Array(n) // reverb send
  const duck = new Float32Array(n).fill(1) // sidechain from the kick

  const add = (i, v, pan = 0, send = 0) => {
    if (i < 0 || i >= n) return
    const l = v * Math.cos((pan + 1) * Math.PI / 4), r = v * Math.sin((pan + 1) * Math.PI / 4)
    L[i] += l; R[i] += r
    if (send) { sendL[i] += l * send; sendR[i] += r * send }
  }
  const at = t => Math.round(t * SR)

  // Section levels over time.
  const env = (t, pts) => { // piecewise linear [[t, v], ...]
    if (t <= pts[0][0]) return pts[0][1]
    for (let k = 1; k < pts.length; k++) if (t <= pts[k][0]) { const [t0, v0] = pts[k - 1], [t1, v1] = pts[k]; return v0 + (v1 - v0) * (t - t0) / (t1 - t0) }
    return pts.at(-1)[1]
  }
  const padCut = t => env(t, [[0, 500], [4.4, 900], [4.7, 2400], [7.6, 1800], [14, 3200], [23.4, 1500], [27.6, 2200], [31.1, 5200], [31.3, 2600], [35.5, 1200]])
  const padLvl = t => env(t, [[0, 0], [1.2, .09], [4.5, .1], [7.6, .08], [14, .07], [23.4, .1], [31.2, .12], [34, .08], [35.5, 0]])

  // ---- Kick (sidechain source) ----
  const kick = t0 => {
    const s = at(t0), len = at(.38)
    let ph = 0
    for (let k = 0; k < len; k++) {
      const t = k / SR, f = 45 + 95 * Math.exp(-t * 28)
      ph += 2 * Math.PI * f / SR
      const v = Math.sin(ph) * Math.exp(-t * 9) * .9 + (k < 90 ? (rand() * 2 - 1) * .15 * (1 - k / 90) : 0)
      add(s + k, v)
    }
    for (let k = 0; k < at(.3); k++) { const i = s + k; if (i < n) duck[i] = Math.min(duck[i], 1 - .55 * Math.exp(-k / SR * 9)) }
  }
  // ---- Clap / snare ----
  const clap = (t0, lvl = .32) => {
    const s = at(t0); let lp = 0, prev = 0
    for (let k = 0; k < at(.22); k++) {
      const t = k / SR, x = rand() * 2 - 1
      lp += .35 * (x - lp); const hp = x - lp // crude high-pass
      const burst = t < .03 ? (Math.floor(t / .01) % 2 ? .6 : 1) : 1
      const v = (hp * .8 + (x - prev) * .2) * Math.exp(-t * 18) * lvl * burst
      prev = x
      add(s + k, v, 0, .35)
    }
  }
  // ---- Hat ----
  const hat = (t0, lvl, open = false) => {
    const s = at(t0); let a = 0
    for (let k = 0; k < at(open ? .18 : .05); k++) {
      const x = rand() * 2 - 1; const hp = x - a; a += .6 * (x - a)
      add(s + k, hp * Math.exp(-k / SR * (open ? 22 : 70)) * lvl, .25)
    }
  }
  // ---- Bass: 8th-note pulse on the root ----
  const bass = (t0, m, dur, lvl) => {
    const s = at(t0), f = midi(m); let ph = 0, lp = 0
    for (let k = 0; k < at(dur); k++) {
      const t = k / SR; ph += f / SR
      const saw = 2 * (ph % 1) - 1, sine = Math.sin(2 * Math.PI * ph)
      lp += .08 * (saw - lp)
      const e = Math.min(1, t / .005) * Math.exp(-t * 5)
      add(s + k, (sine * .7 + lp * .5) * e * lvl)
    }
  }
  // ---- Pluck (arp) ----
  const pluck = (t0, m, lvl, pan, bright = 1) => {
    const s = at(t0), f = midi(m); let ph = 0, lp = 0
    const a = 1 - Math.exp(-2 * Math.PI * (900 + 2600 * bright) / SR)
    for (let k = 0; k < at(.32); k++) {
      const t = k / SR; ph += f / SR
      const sq = (ph % 1) < .5 ? 1 : -1, tri = 4 * Math.abs((ph % 1) - .5) - 1
      lp += a * Math.exp(-t * 6) * ((sq * .5 + tri * .5) - lp) + .02 * ((sq * .5 + tri * .5) - lp)
      add(s + k, lp * Math.min(1, t / .003) * Math.exp(-t * 9) * lvl, pan, .45)
    }
  }
  // ---- Coin: two bright partials ----
  const coin = (t0, lvl, pan = 0, base = 2093) => {
    const s = at(t0)
    for (let k = 0; k < at(.45); k++) {
      const t = k / SR
      const v = (Math.sin(2 * Math.PI * base * t) + .6 * Math.sin(2 * Math.PI * base * 1.5 * t) * (t < .06 ? 0 : 1) + .25 * Math.sin(2 * Math.PI * base * 2.76 * t)) * Math.exp(-t * 9) * Math.min(1, t / .002)
      add(s + k, v * lvl, pan, .5)
    }
  }
  // ---- Pop: a short upward blip ----
  const pop = (t0, lvl, pan) => {
    const s = at(t0); let ph = 0
    for (let k = 0; k < at(.09); k++) { const t = k / SR, f = 520 + 1400 * (t / .09); ph += f / SR; add(s + k, Math.sin(2 * Math.PI * ph) * Math.exp(-t * 30) * lvl, pan, .3) }
  }
  // ---- Impact: sub drop plus a long noise wash ----
  const impact = (t0, lvl) => {
    const s = at(t0); let ph = 0, lp = 0
    for (let k = 0; k < at(2.2); k++) {
      const t = k / SR, f = 38 + 60 * Math.exp(-t * 10); ph += f / SR
      const x = rand() * 2 - 1; lp += .05 * (x - lp)
      add(s + k, (Math.sin(2 * Math.PI * ph) * Math.exp(-t * 3.2) * .9 + (x - lp) * Math.exp(-t * 2.4) * .25) * lvl, 0, .6)
    }
  }
  // ---- Riser: noise through an opening filter ----
  const riser = (t0, t1, lvl) => {
    const s = at(t0), len = at(t1 - t0); let lp = 0
    for (let k = 0; k < len; k++) {
      const p = k / len, a = 1 - Math.exp(-2 * Math.PI * (200 + 7000 * p * p) / SR)
      const x = rand() * 2 - 1; lp += a * (x - lp)
      add(s + k, lp * p * p * lvl, Math.sin(p * 9) * .4, .4)
    }
  }

  // ---- Pad: three detuned saws per note, low-passed by section ----
  {
    const voices = []
    for (const [, notes] of CHORDS) for (const m of notes) for (const d of [-.07, 0, .07]) voices.push({ m, d })
    const ph = new Float64Array(64), lp = [0, 0]
    for (let i = 0; i < n; i++) {
      const t = i / SR, notes = chordAt(t)[1], end = t > 31.2 ? [48, [55, 60, 64, 71]] : null
      const play = end ? end[1] : notes
      let l = 0, r = 0, v = 0
      for (const m of play) for (const d of [-.08, 0, .08]) {
        const f = midi(m + d); ph[v] = (ph[v] + f / SR) % 1
        const saw = 2 * ph[v] - 1
        if (d < 0) l += saw; else if (d > 0) r += saw; else { l += saw * .5; r += saw * .5 }
        v++
      }
      const a = 1 - Math.exp(-2 * Math.PI * padCut(t) / SR)
      lp[0] += a * (l - lp[0]); lp[1] += a * (r - lp[1])
      const g = padLvl(t) / play.length
      L[i] += lp[0] * g; R[i] += lp[1] * g
      sendL[i] += lp[0] * g * .5; sendR[i] += lp[1] * g * .5
    }
  }

  // ---- Arrangement ----
  // Hats: quiet ticking from the start, fuller in the groove.
  for (let t = 0; t < 31.2; t += BEAT / 2) {
    const off = Math.round(t / (BEAT / 2)) % 2 === 1
    const lvl = t < 4 ? (off ? .05 : .025) * Math.min(1, t / 2) : t < 7.6 ? .05 : t < 14 ? (off ? .09 : .04) : t < 23.4 ? (off ? .11 : .05) : t < 27.6 ? (off ? .06 : 0) : .1
    if (lvl) hat(t, lvl, off && t >= 14 && t < 23.4 && Math.round(t / BEAT) % 4 === 3)
  }
  // Kick: half time 7.6-14, four on the floor 14-23.4, sparse in the week, driving in the pour.
  for (let t = 8; t < 31; t += BEAT) {
    const beat = Math.round(t / BEAT)
    if (t < 14 && beat % 2) continue
    if (t >= 23.4 && t < 27.6 && beat % 4) continue
    kick(t)
  }
  // Claps on 2 and 4 in the groove and the pour.
  for (let t = 14.5; t < 31; t += BEAT * 2) if (t < 23.4 || t >= 27.6) clap(t)
  // Snare roll into the logo.
  for (let t = 29.6, step = .25; t < 31.15; t += step, step = Math.max(.0625, step * .82)) clap(t, .12 + .25 * (t - 29.6) / 1.55)
  // Bass from the ring on.
  for (let t = 7.6; t < 31.2; t += BEAT / 2) {
    if (t >= 23.4 && t < 27.6 && Math.round(t / (BEAT / 2)) % 2) continue
    const root = chordAt(t)[0], oct = Math.round(t / (BEAT / 2)) % 2 ? 12 : 0
    bass(t, root - 12 + oct, .24, t < 14 ? .22 : .3)
  }
  // Arp: 16ths over the chord, from the ring on, brighter with the cards.
  const ARP = [0, 1, 2, 3, 2, 1, 3, 4]
  for (let t = 7.6, k = 0; t < 31.2; t += BEAT / 4, k++) {
    if (t >= 23.4 && t < 27.6 && k % 2) continue
    const notes = chordAt(t)[1], pool = [...notes, notes[0] + 12, notes[1] + 12]
    const m = pool[ARP[k % ARP.length]] + 12
    pluck(t, m, t < 14 ? .07 : .09, k % 2 ? .35 : -.35, t < 14 ? .4 : t < 23.4 ? 1 : .7)
  }
  // Ending: a slow arp over C major add9, fading.
  for (let t = 31.2, k = 0; t < 35; t += BEAT / 2, k++) pluck(t, [72, 76, 79, 83, 86, 83, 79, 76][k % 8], .08 * (1 - (t - 31.2) / 4), k % 2 ? .4 : -.4, .6)

  // Cues.
  riser(2.2, 4.55, .22)
  impact(4.6, .8)
  for (let i = 0; i < 26; i++) coin(4.7 + i * .085 + .75, .045, (rand() * 2 - 1) * .7, [2093, 2349, 2637, 3136][i % 4])
  for (let i = 0; i < 9; i++) { pop(7.9 + i * .52, .16, (i / 8) * 1.2 - .6); coin(7.9 + i * .52 + .45, .06, (i / 8) * 1.2 - .6, 2637) }
  { let t = 14.4; for (let i = 0; i < 9; i++) { const d = i < 3 ? 1.9 : .55; coin(t + (i < 3 ? .75 : .05), .12, i % 2 ? .3 : -.3, i < 3 ? 2093 : 2637); t += d } }
  for (let k = 0; k < 8; k++) coin(24.85 + k * .045, .07, k / 8 - .5, [2093, 2349, 2637, 3136, 3520, 4186, 4699, 5274][k])
  for (let i = 0; i < 9; i++) for (let k = 0; k < 6; k++) coin(27.7 + k * .42 + i * .045 + .3, .05, (i / 8) * 1.4 - .7, [2093, 2349, 2637, 3136, 3520][(i + k) % 5])
  riser(28.8, 31.15, .26)
  impact(31.2, .9)
  for (let k = 0; k < 5; k++) coin(31.2 + k * .07, .09, k / 4 - .5, [2093, 2637, 3136, 4186, 5274][k])

  // ---- Reverb: four combs and two all-passes per side ----
  const reverb = (input, delays) => {
    const out = new Float32Array(n)
    for (const d of delays.combs) {
      const buf = new Float32Array(d); let idx = 0, lp = 0
      for (let i = 0; i < n; i++) { const y = buf[idx]; lp += .3 * (y - lp); buf[idx] = input[i] + lp * .8; out[i] += y * .25; idx = (idx + 1) % d }
    }
    for (const d of delays.ap) {
      const buf = new Float32Array(d); let idx = 0
      for (let i = 0; i < n; i++) { const b = buf[idx], x = out[i]; const y = -x + b; buf[idx] = x + b * .5; out[i] = y; idx = (idx + 1) % d }
    }
    return out
  }
  const wl = reverb(sendL, { combs: [1557, 1617, 1491, 1422], ap: [225, 556] })
  const wr = reverb(sendR, { combs: [1580, 1640, 1514, 1445], ap: [248, 579] })

  // ---- Master: duck everything but the kick lightly, add the wet, soft-clip, fade, normalize ----
  const out = new Int16Array(n * 2)
  let peak = 0
  const mixed = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const t = i / SR, fade = Math.min(1, t / .05) * (t > 33.3 ? Math.max(0, (DURATION - t) / (DURATION - 33.3)) : 1)
    const d = .6 + .4 * duck[i]
    const l = Math.tanh((L[i] * d + wl[i] * .35) * 1.3) * fade, r = Math.tanh((R[i] * d + wr[i] * .35) * 1.3) * fade
    mixed[2 * i] = l; mixed[2 * i + 1] = r
    peak = Math.max(peak, Math.abs(l), Math.abs(r))
  }
  const g = .89 / (peak || 1)
  for (let i = 0; i < mixed.length; i++) out[i] = Math.max(-32767, Math.min(32767, Math.round(mixed[i] * g * 32767)))
  return out
}

export function wav(samples, sampleRate = SR) {
  const data = Buffer.from(samples.buffer)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22)
  head.writeUInt32LE(sampleRate, 24); head.writeUInt32LE(sampleRate * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? 'promo.wav'
  writeFileSync(file, wav(promoMusic()))
  console.log('wrote', file)
}
