/* PDF のコード譜を取り込む（Lazarus 版 pdfimport.pas から移植）。
   Lazarus 版は Poppler の pdftotext -bbox で単語の座標を得ていたが、Web 版は PDF.js で文字の座標を得る。
   コードだけの行を、直下の歌詞行の文字位置に合わせて配置する */
(function (LC) {
  'use strict';

  const { Chord, Text, Sheet } = LC;
  const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';

  let loading = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('PDF.js を読み込めませんでした（インターネットに接続されているか確認してください）'));
      document.head.appendChild(s);
    });
  }

  // PDF.js は PDF を初めて読み込むときに読み込む
  function loadPdfJs() {
    if (!loading) {
      loading = (async () => {
        await loadScript(PDFJS_BASE + 'build/pdf.min.js');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'build/pdf.worker.min.js';
        // 解析処理もページに読み込み、別スレッド（Worker）を使わずにページの中で解析させる。
        // HTML を直接開いたとき（file://）や、別サイト（CDN）の Worker が起動しない環境でも確実に動く。
        // コード譜の PDF は数ページなので、別スレッドでなくても十分速い
        await loadScript(PDFJS_BASE + 'build/pdf.worker.min.js');
        return window.pdfjsLib;
      })().catch((e) => {
        loading = null;
        throw e;
      });
    }
    return loading;
  }

  const isSeparator = (s) => s === ' ' || s === '　' || s === ' ';

  // PDF.js の文字列 1 つを、空白で区切った単語（座標付き）に分ける
  function itemWords(item, vp) {
    const s = item.str;
    if (!s || !s.trim()) return [];
    const t = item.transform;
    if (Math.abs(t[1]) > 1e-3 || Math.abs(t[2]) > 1e-3) return []; // 回転・縦書きは対象外
    const fontH = Math.abs(t[3]) || item.height || 10;
    // 文字の上下の範囲（Poppler の -bbox と同じくらいの高さにする：上 1.0・下 0.25）
    const [, top] = vp.convertToViewportPoint(t[4], t[5] + fontH * 1.0);
    const [, bottom] = vp.convertToViewportPoint(t[4], t[5] - fontH * 0.25);
    const [x0] = vp.convertToViewportPoint(t[4], t[5]);
    const y1 = Math.min(top, bottom), y2 = Math.max(top, bottom);
    // 文字列の幅を文字の幅（全角 2・半角 1）で按分する
    const total = Math.max(1, Text.allCells(s));
    const per = (item.width || fontH * total / 2) / total;
    const words = [];
    let cur = null, x = x0;
    for (let i = 0; i < s.length; i++) {
      const cells = Text.charCells(s.charCodeAt(i));
      if (isSeparator(s[i])) {
        if (cur) { words.push(cur); cur = null; }
        x += per * cells;
        continue;
      }
      if (!cur) cur = { x1: x, x2: x, y1, y2, text: '' };
      cur.text += s[i];
      x += per * cells;
      cur.x2 = x;
    }
    if (cur) words.push(cur);
    return words;
  }

  // 単語を縦位置の重なりで行にまとめる
  function groupLines(words) {
    const center = (w) => (w.y1 + w.y2) / 2;
    words.sort((a, b) => center(a) - center(b) || a.x1 - b.x1);
    const lines = [];
    let cur = null;
    for (const w of words) {
      if (cur) {
        const overlap = Math.min(cur.y2, w.y2) - Math.max(cur.y1, w.y1);
        const smaller = Math.min(cur.y2 - cur.y1, w.y2 - w.y1);
        if (overlap > smaller * 0.5) {
          cur.words.push(w);
          cur.y1 = Math.min(cur.y1, w.y1);
          cur.y2 = Math.max(cur.y2, w.y2);
          continue;
        }
      }
      cur = { words: [w], y1: w.y1, y2: w.y2, isChord: false };
      lines.push(cur);
    }
    for (const l of lines) {
      l.words.sort((a, b) => a.x1 - b.x1);
      l.isChord = l.words.every((w) => Chord.isChordToken(w.text));
    }
    return lines;
  }

  function median(a, def) {
    if (!a.length) return def;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  // 歌詞行を文字列にし、各文字の左端 X とセル位置を記録する
  function buildLyric(line, left, cellW) {
    let text = '', cur = 0, prevX2 = left;
    const charX = [], charCell = [];
    const addChar = (c, x, cells) => {
      text += c;
      charX.push(x);
      charCell.push(cur);
      cur += cells;
    };
    for (const w of line.words) {
      const col = Math.round((w.x1 - left) / cellW);
      if (col > cur) {
        const n = col - cur;
        for (let k = 1; k <= n; k++) addChar(' ', prevX2 + (w.x1 - prevX2) * (k - 1) / n, 1);
      } else if (text && w.x1 - prevX2 > cellW * 0.3) {
        addChar(' ', prevX2, 1);
      }
      // 単語の幅を文字の幅（全角 2・半角 1）で按分する
      const total = Math.max(1, Text.allCells(w.text));
      const per = (w.x2 - w.x1) / total;
      let x = w.x1;
      for (let k = 0; k < w.text.length; k++) {
        const cells = Text.charCells(w.text.charCodeAt(k));
        if (cells === 0) { text += w.text[k]; continue; }
        addChar(w.text[k], x, cells);
        x += per * cells;
      }
      prevX2 = w.x2;
    }
    return { text, charX, charCell, endX: prevX2, endCell: cur };
  }

  function chordColumn(x, lyr, left, cellW) {
    if (!lyr || lyr.charX.length === 0) return Math.max(0, Math.round((x - left) / cellW));
    if (x >= lyr.endX - cellW * 0.3) return lyr.endCell + Math.max(0, Math.round((x - lyr.endX) / cellW));
    // コードの左端の真下にある文字を探す
    let r = lyr.charCell[0];
    for (let i = 0; i < lyr.charX.length; i++) {
      if (lyr.charX[i] <= x + cellW * 0.3) r = lyr.charCell[i]; else break;
    }
    if (x < lyr.charX[0] - cellW * 0.3) r = Math.max(0, Math.round((x - left) / cellW));
    return r;
  }

  function buildSheet(pages) {
    const heights = [], widths = [];
    for (const lines of pages) {
      for (const l of lines) {
        if (l.isChord) continue;
        heights.push(l.y2 - l.y1);
        for (const w of l.words) {
          const c = Text.allCells(w.text);
          if (c > 0) widths.push((w.x2 - w.x1) / c);
        }
      }
    }
    // 半角 1 文字分の幅と、歌詞 1 行の高さ（文書全体の中央値）
    const lyricH = median(heights, 16);
    let cellW = median(widths, lyricH / 2);
    if (cellW <= 0.5) cellW = 4;

    const result = [];
    pages.forEach((lines, pageNo) => {
      if (!lines.length) return;
      const left = Math.min(...lines.map((l) => l.words[0].x1));
      if (pageNo > 0 && result.length) result.push(new Sheet.SheetLine());
      let prevBottom = -1;
      for (let i = 0; i < lines.length;) {
        const pl = lines[i];
        let lyric = null;
        if (pl.isChord) {
          // 直下にある歌詞行と組にする
          const next = lines[i + 1];
          if (next && !next.isChord && next.y1 - pl.y2 < lyricH * 0.8) lyric = next;
        } else {
          lyric = pl;
        }
        // 行間が大きく空いていれば空行を入れる
        if (prevBottom >= 0 && pl.y1 - prevBottom > lyricH) result.push(new Sheet.SheetLine());
        const sl = new Sheet.SheetLine();
        const lyr = lyric ? buildLyric(lyric, left, cellW) : null;
        if (lyr) sl.text = lyr.text;
        if (pl.isChord) for (const w of pl.words) sl.appendChord(chordColumn(w.x1, lyr, left, cellW), w.text);
        sl.normalize();
        result.push(sl);
        prevBottom = lyric ? lyric.y2 : pl.y2;
        i += lyric && lyric !== pl ? 2 : 1;
      }
    });
    return result;
  }

  // PDF のバイト列からコード譜の行を作る。文字が見つからなければ空の配列
  async function importPdf(buffer) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl: PDFJS_BASE + 'cmaps/',
      cMapPacked: true,
    }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const words = [];
      for (const item of tc.items) if ('str' in item) words.push(...itemWords(item, vp));
      pages.push(groupLines(words));
    }
    return buildSheet(pages);
  }

  LC.PdfImport = { importPdf, loadPdfJs };
})(window.LC = window.LC || {});
