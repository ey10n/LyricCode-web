/* 文書のデータ構造と .lct 形式の読み書き（Lazarus 版 lyricchordeditor.pas から移植）
   1 行 = 歌詞の文字列 + コードの並び。コードの位置 col は半角 1・全角 2 のセル単位。
   コードの点滅（blink）・色（color）と歌詞の太字（bold）は .lct に書かない（Windows 版で読めなくなるため）。
   曲の一覧の中に「飾り」として別に持つ（iPad のアプリ版と同じ考え方） */
(function (LC) {
  'use strict';

  const { Chord, Text } = LC;
  const HEADER = '#LyricCode 1';

  class SheetLine {
    constructor(text = '', chords = [], bold = null) {
      this.text = text;
      this.chords = chords; // [{ col, name, blink?, color? }]
      this.bold = bold || new Set(); // 太字にした歌詞の文字の位置（UTF-16 の位置）
    }

    clone() {
      return new SheetLine(this.text, this.chords.map(copyChord), new Set(this.bold));
    }

    findChordCol(col) {
      return this.chords.findIndex((c) => c.col === col);
    }

    // attrs: 元のコードの点滅・色を引き継ぐとき、そのコード
    appendChord(col, name, attrs) {
      const c = { col, name };
      if (attrs && attrs.blink) c.blink = true;
      if (attrs && attrs.color) c.color = attrs.color;
      this.chords.push(c);
    }

    addChord(col, name, attrs) {
      this.appendChord(col, name, attrs);
      this.normalize();
      return this.findChordCol(col);
    }

    deleteChord(index) {
      if (index >= 0 && index < this.chords.length) this.chords.splice(index, 1);
    }

    // 桁位置順に並べ（同じ桁は元の順のまま）、重なったコードは後ろへずらす
    normalize() {
      const a = this.chords;
      for (let i = 1; i < a.length; i++) {
        const t = a[i];
        let j = i - 1;
        while (j >= 0 && a[j].col > t.col) { a[j + 1] = a[j]; j--; }
        a[j + 1] = t;
      }
      for (let i = 0; i < a.length; i++) {
        if (a[i].col < 0) a[i].col = 0;
        if (i > 0 && a[i].col <= a[i - 1].col) a[i].col = a[i - 1].col + 1;
      }
    }
  }

  function copyChord(c) {
    const r = { col: c.col, name: c.name };
    if (c.blink) r.blink = true;
    if (c.color) r.color = c.color;
    return r;
  }

  // ---- 飾り（点滅・コードの色・歌詞の太字） ----
  // 曲の一覧に持つ形は iPad のアプリ版の書き出しと同じ：
  //   { blinking: [{line, col}], chordColors: [{line, col, color}], boldLyrics: [{line, from, to}] }
  // line は行の番号、col はコードの桁、from・to は歌詞の UTF-16 の位置（from を含み to を含まない）

  function getStyle(lines) {
    const blinking = [], chordColors = [], boldLyrics = [];
    lines.forEach((l, i) => {
      for (const c of l.chords) {
        if (c.blink) blinking.push({ line: i, col: c.col });
        if (c.color) chordColors.push({ line: i, col: c.col, color: c.color });
      }
      const idx = [...l.bold].filter((k) => k < l.text.length).sort((a, b) => a - b);
      for (const k of idx) {
        const last = boldLyrics[boldLyrics.length - 1];
        if (last && last.line === i && last.to === k) last.to = k + 1;
        else boldLyrics.push({ line: i, from: k, to: k + 1 });
      }
    });
    const r = {};
    if (blinking.length) r.blinking = blinking;
    if (chordColors.length) r.chordColors = chordColors;
    if (boldLyrics.length) r.boldLyrics = boldLyrics;
    return r;
  }

  function applyStyle(lines, style) {
    if (!style) return;
    const chordAt = (r) => {
      const l = lines[r.line];
      if (!l) return null;
      const i = l.findChordCol(r.col);
      return i >= 0 ? l.chords[i] : null;
    };
    for (const r of style.blinking || []) { const c = chordAt(r); if (c) c.blink = true; }
    for (const r of style.chordColors || []) { const c = chordAt(r); if (c && r.color) c.color = r.color; }
    for (const r of style.boldLyrics || []) {
      const l = lines[r.line];
      if (!l) continue;
      for (let k = Math.max(0, r.from); k < Math.min(r.to, l.text.length); k++) l.bold.add(k);
    }
  }

  function hasStyle(style) {
    return !!style && ['blinking', 'chordColors', 'boldLyrics'].some((k) => (style[k] || []).length);
  }

  // コード行の文字列を読む（空白で区切った語の先頭の桁がコードの位置）。
  // 自由文字の日本語などは全角 2 桁として数える（テキストエディタで開いても位置がそろう）
  function parseChordLine(s, line) {
    let col = 0, i = 0;
    while (i < s.length) {
      if (s[i] === ' ' || s[i] === '\t') { i++; col++; continue; }
      const start = col;
      let tok = '';
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t') {
        tok += s[i];
        col += Text.charCells(s.charCodeAt(i));
        i++;
      }
      line.appendChord(start, tok);
    }
    line.normalize();
  }

  function buildChordLine(line) {
    let r = '', curLen = 0;
    line.chords.forEach((c, i) => {
      let p = c.col;
      if (i > 0 && p < curLen + 1) p = curLen + 1;
      const name = Text.fixSurrogates(c.name);
      r += ' '.repeat(p - curLen) + name;
      curLen = p + Text.allCells(name);
    });
    return r;
  }

  // 改行で分ける（末尾の改行の後ろは行にしない）
  function splitLines(text) {
    if (text === '') return [];
    const a = text.split(/\r\n|\n|\r/);
    if (a.length > 0 && a[a.length - 1] === '' && /[\r\n]$/.test(text)) a.pop();
    return a;
  }

  // 文書 → テキスト。withHeader なら保存形式（コード行・歌詞行の 2 行 1 組）
  function getSheetText(lines, withHeader, eol = '\r\n') {
    const out = [];
    if (withHeader) out.push(HEADER);
    for (const line of lines) {
      const c = buildChordLine(line);
      if (withHeader || c !== '') out.push(c);
      out.push(Text.fixSurrogates(line.text));
    }
    return out.map((s) => s + eol).join('');
  }

  // テキスト → 文書。保存形式でなければ、コードだけの行を次の歌詞行の上に付ける
  function parseSheetText(text) {
    const src = splitLines(text);
    const lines = [];
    if (src.length > 0 && src[0].startsWith('#LyricCode')) {
      for (let i = 1; i < src.length; i += 2) {
        const line = new SheetLine();
        parseChordLine(src[i], line);
        if (i + 1 < src.length) line.text = Text.cleanText(src[i + 1], false);
        lines.push(line);
      }
    } else {
      let i = 0;
      while (i < src.length) {
        const line = new SheetLine();
        if (Chord.isChordLine(src[i])) {
          parseChordLine(src[i], line);
          if (i + 1 < src.length && !Chord.isChordLine(src[i + 1])) {
            line.text = Text.cleanText(src[i + 1], false);
            i++;
          }
        } else {
          line.text = Text.cleanText(src[i], false);
        }
        lines.push(line);
        i++;
      }
    }
    if (lines.length === 0) lines.push(new SheetLine());
    return lines;
  }

  LC.Sheet = {
    SheetLine, HEADER, parseChordLine, buildChordLine, getSheetText, parseSheetText, splitLines,
    copyChord, getStyle, applyStyle, hasStyle,
  };
})(window.LC = window.LC || {});
