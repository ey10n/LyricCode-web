/* 文書のデータ構造と .lct 形式の読み書き（Lazarus 版 lyricchordeditor.pas から移植）
   1 行 = 歌詞の文字列 + コードの並び。コードの位置 col は半角 1・全角 2 のセル単位 */
(function (LC) {
  'use strict';

  const { Chord, Text } = LC;
  const HEADER = '#LyricCode 1';

  class SheetLine {
    constructor(text = '', chords = []) {
      this.text = text;
      this.chords = chords; // [{ col, name }]
    }

    clone() {
      return new SheetLine(this.text, this.chords.map((c) => ({ col: c.col, name: c.name })));
    }

    findChordCol(col) {
      return this.chords.findIndex((c) => c.col === col);
    }

    appendChord(col, name) {
      this.chords.push({ col, name });
    }

    addChord(col, name) {
      this.appendChord(col, name);
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

  LC.Sheet = { SheetLine, HEADER, parseChordLine, buildChordLine, getSheetText, parseSheetText, splitLines };
})(window.LC = window.LC || {});
