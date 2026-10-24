/* コード名の解析・組み立て・移調、コード行の判定（Lazarus 版 lyricchordeditor.pas から移植） */
(function (LC) {
  'use strict';

  const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MENU_NOTES = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab',
    'A', 'A#', 'Bb', 'B'];
  const NOTE_SYMBOLS = ['♩', '♪', '♫', '♬'];
  const BAR_LINE = '|';

  const MAIN_QUALITY_COUNT = 14;
  const QUALITIES = [
    // 主要なコード（右クリックメニュー直下）
    '', 'm', '7', 'm7', 'maj7', 'mM7', '6', 'm6', 'sus4', '7sus4', 'dim',
    'dim7', 'm7-5', 'aug',
    // その他のコード（サブメニュー）
    'add9', 'madd9', '9', 'm9', 'maj9', 'sus2', '69', 'm69', '7(9)', '7(b9)',
    '7(#9)', '7(11)', '7(#11)', '7(13)', '7(b13)', 'm7(9)', 'm7(11)', '11',
    '13', '7-5', '7+5', 'aug7'];

  const isRootLetter = (c) => c >= 'A' && c <= 'G';
  const isAcc = (c) => c === '#' || c === 'b';

  // コード名を基音・種類・ベース音に分ける。基音で始まらなければ ok = false
  function parseChord(name) {
    const r = { ok: false, root: '', quality: '', bass: '' };
    if (!name || !isRootLetter(name[0])) {
      r.quality = name || '';
      return r;
    }
    r.root = name[0];
    let p = 1;
    if (name.length >= 2 && isAcc(name[1])) {
      r.root += name[1];
      p = 2;
    }
    const rest = name.slice(p);
    const s = rest.lastIndexOf('/');
    const n = rest.length - s - 1;
    if (s >= 0 && n >= 1 && n <= 2 && isRootLetter(rest[s + 1]) && (n === 1 || isAcc(rest[s + 2]))) {
      r.bass = rest.substr(s + 1, n);
      r.quality = rest.slice(0, s);
    } else {
      r.quality = rest;
    }
    r.ok = true;
    return r;
  }

  function buildChord(root, quality, bass) {
    let s = root + quality;
    if (bass) s += '/' + bass;
    return s;
  }

  function noteIndex(note) {
    const base = { A: 9, B: 11, C: 0, D: 2, E: 4, F: 5, G: 7 };
    if (!note || !isRootLetter(note[0])) return -1;
    let n = base[note[0]];
    for (let i = 1; i < note.length; i++) {
      if (note[i] === '#') n++;
      else if (note[i] === 'b') n--;
    }
    return ((n % 12) + 12) % 12;
  }

  function transposeNote(note, steps, preferFlat) {
    let n = noteIndex(note);
    if (n < 0) return note;
    n = (((n + steps) % 12) + 12) % 12;
    return preferFlat ? FLAT_NAMES[n] : SHARP_NAMES[n];
  }

  function transposeChord(name, steps) {
    const c = parseChord(name);
    if (!c.ok) return name;
    const flat = c.root.includes('b') || (!c.root.includes('#') && steps < 0);
    const root = transposeNote(c.root, steps, flat);
    const bass = c.bass ? transposeNote(c.bass, steps, flat) : '';
    return buildChord(root, c.quality, bass);
  }

  function toggleAccidental(note, acc) {
    if (!note) return note;
    if (note.length >= 2 && note[1] === acc) return note[0];
    return note[0] + acc;
  }

  const isNoteSymbol = (t) => NOTE_SYMBOLS.includes(t);

  const QUAL_CHARS = new Set('majdiugsnMo0123456789#b+-(),.^/'.split(''));

  // コード行に置ける語か（コード名・小節線・数字・音符）
  function isChordToken(t) {
    if (t === 'N.C.' || t === 'NC' || t === '|' || t === '||') return true;
    if (/^[0-9]+$/.test(t)) return true;
    if (isNoteSymbol(t)) return true;
    const c = parseChord(t);
    if (!c.ok) return false;
    if (c.quality.length > 12) return false;
    for (const ch of c.quality) if (!QUAL_CHARS.has(ch)) return false;
    return true;
  }

  function isChordLine(s) {
    const tokens = s.split(/[ \t]+/).filter((t) => t !== '');
    return tokens.length > 0 && tokens.every(isChordToken);
  }

  // 入力されたコード名を整える（♯♭・全角英数字・空白）
  function normalizeChordName(s) {
    let r = '';
    for (let c of s) {
      const code = c.codePointAt(0);
      if (code === 0x266F) c = '#';
      else if (code === 0x266D) c = 'b';
      else if (code >= 0xFF01 && code <= 0xFF5E) c = String.fromCharCode(code - 0xFEE0);
      else if (code === 0x3000) c = ' ';
      if (c !== ' ' && c.codePointAt(0) >= 32) r += c;
    }
    return r;
  }

  LC.Chord = {
    SHARP_NAMES, FLAT_NAMES, MENU_NOTES, NOTE_SYMBOLS, BAR_LINE, QUALITIES, MAIN_QUALITY_COUNT,
    parseChord, buildChord, noteIndex, transposeNote, transposeChord, toggleAccidental,
    isNoteSymbol, isChordToken, isChordLine, normalizeChordName,
  };
})(window.LC = window.LC || {});
