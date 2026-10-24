/* 文字の幅・文字列の後始末・文字コードの判定と変換・文字化けの修復
   （Lazarus 版 lyricchordeditor.pas / textrepair.pas から移植） */
(function (LC) {
  'use strict';

  // ---- 文字の幅（半角 1・全角 2 セル。UTF-16 の 1 単位ごと） ----

  function charCells(code) {
    if (code >= 0xDC00 && code <= 0xDFFF) return 0; // サロゲートの後半
    if (code >= 0xD800 && code <= 0xDBFF) return 2; // サロゲートの前半（絵文字など）
    if (code <= 0x10FF) return 1;
    if ((code >= 0xFF61 && code <= 0xFFDC) || (code >= 0xFFE8 && code <= 0xFFEE)) return 1;
    return 2;
  }

  function textCells(s, count) {
    if (count === undefined || count > s.length) count = s.length;
    let r = 0;
    for (let i = 0; i < count; i++) r += charCells(s.charCodeAt(i));
    return r;
  }

  const isHighSur = (c) => c >= 0xD800 && c <= 0xDBFF;
  const isLowSur = (c) => c >= 0xDC00 && c <= 0xDFFF;

  // ---- 文字列の後始末 ----

  // Web ページなどからのコピーに混じる、表示されない文字
  function isInvisible(c) {
    return c === 0x00AD || (c >= 0x200B && c <= 0x200F) || (c >= 0x202A && c <= 0x202E) ||
      (c >= 0x2060 && c <= 0x2064) || (c >= 0xFE00 && c <= 0xFE0F) || c === 0xFEFF;
  }

  // かな + 結合用の濁点・半濁点を 1 文字にする。できなければ 0
  const DAKUTEN_BASES = new Set([
    0x304B, 0x304D, 0x304F, 0x3051, 0x3053, 0x3055, 0x3057, 0x3059, 0x305B, 0x305D,
    0x305F, 0x3061, 0x3064, 0x3066, 0x3068, 0x306F, 0x3072, 0x3075, 0x3078, 0x307B,
    0x30AB, 0x30AD, 0x30AF, 0x30B1, 0x30B3, 0x30B5, 0x30B7, 0x30B9, 0x30BB, 0x30BD,
    0x30BF, 0x30C1, 0x30C4, 0x30C6, 0x30C8, 0x30CF, 0x30D2, 0x30D5, 0x30D8, 0x30DB,
    0x309D, 0x30FD]);
  const HANDAKUTEN_BASES = new Set([0x306F, 0x3072, 0x3075, 0x3078, 0x307B,
    0x30CF, 0x30D2, 0x30D5, 0x30D8, 0x30DB]);

  function composeKana(base, mark) {
    if (mark === 0x3099) {
      if (DAKUTEN_BASES.has(base)) return base + 1;
      if (base === 0x3046) return 0x3094;
      if (base === 0x30A6) return 0x30F4;
      if (base >= 0x30EF && base <= 0x30F2) return base + 8;
    } else if (mark === 0x309A) {
      if (HANDAKUTEN_BASES.has(base)) return base + 2;
    }
    return 0;
  }

  // 改行を \n に統一し、タブは空白、制御文字と表示されない文字は除く。
  // 改行しない空白は通常の空白に、分かれた濁点・半濁点は前の文字とまとめる
  function cleanText(s, keepLineBreaks) {
    let r = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (isInvisible(c)) continue;
      if (c === 0x3099 || c === 0x309A) {
        const k = r ? composeKana(r.charCodeAt(r.length - 1), c) : 0;
        if (k) r = r.slice(0, -1) + String.fromCharCode(k);
        else r += c === 0x3099 ? '゛' : '゜';
      } else if (c === 0x00A0 || (c >= 0x2002 && c <= 0x200A) || c === 0x202F || c === 0x205F) {
        r += ' ';
      } else if (c === 13) {
        if (keepLineBreaks) r += '\n';
        if (s.charCodeAt(i + 1) === 10) i++;
      } else if (c === 10) {
        if (keepLineBreaks) r += '\n';
      } else if (c === 9) {
        r += ' ';
      } else if (c >= 32) {
        r += s[i];
      }
    }
    return r;
  }

  // 対になっていないサロゲートを U+FFFD に置き換える（保存時に不正な UTF-8 を書かない）
  function fixSurrogates(s) {
    let r = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (isHighSur(c)) {
        if (isLowSur(s.charCodeAt(i + 1))) { r += s[i] + s[i + 1]; i++; } else r += '�';
      } else if (isLowSur(c)) {
        r += '�';
      } else {
        r += s[i];
      }
    }
    return r;
  }

  // ---- UTF-8 の検査 ----

  // bytes[i] から始まる UTF-8 の 1 文字のバイト数（不正なら 0）
  function utf8SeqLen(b, i) {
    const x = b[i];
    if (x < 0x80) return 1;
    const cont = (k) => i + k < b.length && (b[i + k] & 0xC0) === 0x80;
    if (i + 1 >= b.length) return 0;
    const y = b[i + 1];
    if (x >= 0xC2 && x <= 0xDF) return cont(1) ? 2 : 0;
    if (x === 0xE0) return y >= 0xA0 && y <= 0xBF && cont(2) ? 3 : 0;
    if ((x >= 0xE1 && x <= 0xEC) || x === 0xEE || x === 0xEF) return cont(1) && cont(2) ? 3 : 0;
    if (x === 0xED) return y >= 0x80 && y <= 0x9F && cont(2) ? 3 : 0;
    if (x === 0xF0) return y >= 0x90 && y <= 0xBF && cont(2) && cont(3) ? 4 : 0;
    if (x >= 0xF1 && x <= 0xF3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
    if (x === 0xF4) return y >= 0x80 && y <= 0x8F && cont(2) && cont(3) ? 4 : 0;
    return 0;
  }

  // valid: 正しい 2 バイト以上の文字の数、invalid: 不正なバイトの数
  function countUTF8(b) {
    let valid = 0, invalid = 0, i = 0;
    while (i < b.length) {
      const n = utf8SeqLen(b, i);
      if (n === 0) { invalid++; i++; } else { if (n > 1) valid++; i += n; }
    }
    return { valid, invalid };
  }

  // 大部分が正しい UTF-8 か（正しい文字が不正なバイトの 2 倍より多い）
  function isMostlyUTF8(b) {
    const c = countUTF8(b);
    return c.valid > 0 && c.invalid * 2 < c.valid;
  }

  // Shift-JIS の並びとしてほぼ正しいか
  function isLikelyShiftJIS(b) {
    let valid = 0, invalid = 0, i = 0;
    while (i < b.length) {
      const x = b[i];
      if (x < 0x80) i++;
      else if (x >= 0xA1 && x <= 0xDF) { valid++; i++; } else if ((x >= 0x81 && x <= 0x9F) || (x >= 0xE0 && x <= 0xFC)) {
        const y = i + 1 < b.length ? b[i + 1] : 0;
        if ((y >= 0x40 && y <= 0x7E) || (y >= 0x80 && y <= 0xFC)) { valid++; i += 2; } else { invalid++; i++; }
      } else { invalid++; i++; }
    }
    return valid > 0 && invalid * 2 < valid;
  }

  function decode(label, bytes) {
    return new TextDecoder(label).decode(bytes);
  }

  // ファイルのバイト列を文字列にする（UTF-8 / UTF-8 BOM / UTF-16 / Shift-JIS / Windows-1252）
  function decodeFile(buffer) {
    const b = new Uint8Array(buffer);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return decode('utf-8', b.subarray(3));
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return decode('utf-16le', b.subarray(2));
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return decode('utf-16be', b.subarray(2));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b);
    } catch (e) {
      // 一部だけ壊れた UTF-8 は、壊れた所だけ置き換えて読む（全体の文字化けを防ぐ）
      if (isMostlyUTF8(b)) return decode('utf-8', b);
      if (isLikelyShiftJIS(b)) return decode('shift_jis', b);
      return decode('windows-1252', b);
    }
  }

  // 保存用：UTF-8（BOM なし）・改行 CRLF
  function encodeFile(text) {
    return new TextEncoder().encode(fixSurrogates(text));
  }

  // ---- 文字化けの修復 ----

  // 文字 → バイト列 の逆変換表（ブラウザの TextDecoder から作る）
  let reverseTables = null;

  function buildReverseTables() {
    const tables = [];
    const single = (label) => {
      const map = new Map();
      try {
        const d = new TextDecoder(label);
        for (let x = 0x80; x <= 0xFF; x++) {
          const ch = d.decode(new Uint8Array([x]));
          if (ch.length >= 1 && ch !== '�' && !map.has(ch)) map.set(ch, [x]);
        }
      } catch (e) {
        return null;
      }
      return map;
    };
    // Shift-JIS（Windows で UTF-8 を Shift-JIS として読んだ文字化け）
    const sj = new Map();
    try {
      const d = new TextDecoder('shift_jis');
      for (let x = 0xA1; x <= 0xDF; x++) sj.set(d.decode(new Uint8Array([x])), [x]);
      for (let lead = 0x81; lead <= 0xFC; lead++) {
        if (lead > 0x9F && lead < 0xE0) continue;
        for (let trail = 0x40; trail <= 0xFC; trail++) {
          if (trail === 0x7F) continue;
          const ch = d.decode(new Uint8Array([lead, trail]));
          if (ch.length >= 1 && !ch.includes('�') && !sj.has(ch)) sj.set(ch, [lead, trail]);
        }
      }
      tables.push(sj);
    } catch (e) { /* shift_jis 非対応のブラウザ */ }
    // Windows-1252（Web ページの文字化け）
    const w1252 = single('windows-1252');
    if (w1252) tables.push(w1252);
    // ISO-8859-1（iOS / macOS 版で起きる文字化け）：文字コードがそのままバイト値
    const latin1 = new Map();
    for (let x = 0x80; x <= 0xFF; x++) latin1.set(String.fromCharCode(x), [x]);
    tables.push(latin1);
    // MacRoman（Mac・iPad のアプリ）
    const mac = single('macintosh');
    if (mac) tables.push(mac);
    return tables;
  }

  function toBytes(s, table) {
    const out = [];
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c === 0xFFFD) {
        // 読んだ時に失われたバイト。元の値は分からないので飛ばす（前後の文字は読める）
      } else {
        const b = table.get(ch);
        if (b) out.push(...b); else out.push(0x3F);
      }
    }
    return new Uint8Array(out);
  }

  // 文字化けした文字列 s を元に戻せれば、戻した文字列を返す（戻せなければ null）
  function repairMojibake(s) {
    if (!reverseTables) reverseTables = buildReverseTables();
    let best = null, bestInvalid = Infinity;
    for (const table of reverseTables) {
      const b = toBytes(s, table);
      const c = countUTF8(b);
      // 大部分が UTF-8 として読めれば元の文字列とみなす（読んだ時に失われたバイトは戻せない）
      if (c.valid > c.invalid && c.invalid < bestInvalid) {
        best = decode('utf-8', b);
        bestInvalid = c.invalid;
      }
    }
    return best !== null && best !== s ? best : null;
  }

  LC.Text = {
    charCells, textCells, isHighSur, isLowSur, cleanText, fixSurrogates,
    countUTF8, isMostlyUTF8, isLikelyShiftJIS, decodeFile, encodeFile, repairMojibake,
    allCells: (s) => textCells(s, s.length),
  };
})(window.LC = window.LC || {});
