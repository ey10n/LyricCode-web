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

    // 桁位置順に並べ（同じ桁は元の順のまま）、重なったコードは後ろへずらす。
    // 前のコードとの間には空白を 1 つ空ける（.lct に書いたときと同じ位置。iPad のアプリ版と同じ）
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
        if (i > 0) {
          const min = a[i - 1].col + a[i - 1].name.length + 1;
          if (a[i].col < min) a[i].col = min;
        }
      }
    }

    /**
     * コード index と、同じ行でそれより右のコードをまとめて d 桁動かす（「右側も一緒に」。歌詞は動かさない）。
     * 左端より左へ出る・前のコードとの間に空白 1 つが取れないときは動かさず false
     */
    shiftChords(index, d) {
      if (!this.canShift(index, d)) return false;
      for (let i = index; i < this.chords.length; i++) this.chords[i].col += d;
      return true;
    }

    canShift(index, d) {
      const a = this.chords;
      if (index < 0 || index >= a.length || d === 0) return false;
      if (a[index].col + d < 0) return false;
      return !(index > 0 && a[index].col + d < a[index - 1].col + a[index - 1].name.length + 1);
    }
  }

  // ---- 範囲（範囲コピー・点滅・色。iPad のアプリ版の「自由に選ぶ / 行で選ぶ」） ----
  // a, b は { line, col }。読む順に並べ、1 行目は a の桁から、間の行はまるごと、最後の行は b の桁まで（両端を含む）

  function orderRange(a, b) {
    return (a.line < b.line || (a.line === b.line && a.col <= b.col)) ? [a, b] : [b, a];
  }

  /** 範囲に入るコード [{ line, index }]。byLine なら行をまるごと */
  function chordsInRange(lines, a, b, byLine) {
    const [s, e] = orderRange(a, b);
    const r = [];
    for (let l = Math.max(0, s.line); l <= e.line && l < lines.length; l++) {
      lines[l].chords.forEach((c, i) => {
        if (!byLine && l === s.line && c.col < s.col) return;
        if (!byLine && l === e.line && c.col > e.col) return;
        r.push({ line: l, index: i });
      });
    }
    return r;
  }

  /** 範囲のコードを写す（貼り付けで使う）。{ wholeLines, rows: [{ chords, length }] } */
  function copyChords(lines, a, b, byLine) {
    const [s, e] = orderRange(a, b);
    const rows = [];
    for (let l = s.line; l <= e.line; l++) {
      const from = !byLine && l === s.line ? s.col : 0;
      const to = !byLine && l === e.line ? e.col : Infinity;
      const src = l < lines.length ? lines[l].chords : [];
      rows.push({
        chords: src.filter((c) => c.col >= from && c.col <= to).map((c) => ({ ...copyChord(c), col: c.col - from })),
        length: to === Infinity ? null : to - from + 1,
      });
    }
    return { wholeLines: !!byLine, rows };
  }

  /**
   * 写したコードを (line, col) に貼り付ける。1 行目は col から（行で選んだときは 0 から）、2 行目以降は行の先頭から。
   * 貼る範囲にあったコードは消す。歌詞は変えない。足りない行は足す
   */
  function pasteChords(lines, clip, line, col) {
    clip.rows.forEach((row, k) => {
      const l = line + k;
      while (lines.length <= l) lines.push(new SheetLine());
      const start = k === 0 && !clip.wholeLines ? col : 0;
      const end = row.length == null ? Infinity : start + row.length;
      const target = lines[l];
      target.chords = target.chords.filter((c) => c.col < start || c.col >= end);
      for (const c of row.chords) target.chords.push({ ...copyChord(c), col: c.col + start });
      target.normalize();
    });
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
  // 桁は 1 文字 = 1 桁で数える（Windows 版・iPad のアプリ版と同じ .lct の数え方。
  // 自由文字の日本語も 1 文字 = 1 桁。数え方を変えると他の版との間でコードの位置がずれる）
  function parseChordLine(s, line) {
    let col = 0, i = 0;
    while (i < s.length) {
      if (s[i] === ' ' || s[i] === '\t') { i++; col++; continue; }
      const start = col;
      let tok = '';
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t') { tok += s[i]; i++; col++; }
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
      curLen = p + name.length;
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
    copyChord, getStyle, applyStyle, hasStyle, chordsInRange, copyChords, pasteChords,
  };
})(window.LC = window.LC || {});
