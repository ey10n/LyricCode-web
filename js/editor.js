/* 歌詞の行の上にコードを併記するエディタ（Lazarus 版 TLyricChordEditor から移植）
   各行は「コード行」と「歌詞行」の 2 段。コードの位置は半角 1・全角 2 のセル単位で持つ。
   描画は Canvas、文字入力（日本語入力を含む）は見えない入力欄で受ける */
(function (LC) {
  'use strict';

  const { Chord, Text, Sheet, UI } = LC;
  const { SheetLine } = Sheet;

  const TOP_MARGIN = 6;
  const LEFT_PAD = 8;
  // 最終行より下にコードを置ける行数の上限と、その分としてスクロールで見せる行数
  const MAX_VIRTUAL_LINES = 200;
  const EXTRA_LINES_BELOW = 3;
  /** 文字の大きさ（px）。iPad のアプリ版と同じく標準 18、10～44 */
  const DEFAULT_FONT_SIZE = 18;
  const MIN_FONT_SIZE = 10;
  const MAX_FONT_SIZE = 44;
  const LONG_PRESS_MS = 600;
  /** 左右 2 列の閲覧の、列の間の幅 */
  const COLUMN_GAP = 28;
  /** 元に戻せる回数（iPad のアプリ版と同じ） */
  const UNDO_LIMIT = 300;

  const UK_NONE = 0, UK_TYPING = 1, UK_OTHER = 2, UK_DELETE = 3, UK_MOVE = 4;

  /** 画面の色（iPad のアプリ版と同じ。ライトとダーク） */
  const THEMES = {
    light: {
      paper: '#FFFFFF',
      lyric: '#000000',
      chord: '#B88A00',
      chordBand: '#ECF6FF',
      curLine: '#FFFCE6',
      targetFill: '#FFE4B8',
      targetFrame: '#FF7C00',
      freeTargetFill: '#C8F0C8',
      freeTargetFrame: '#309030',
      gutter: '#F2F2F2',
      gutterLine: '#D8D8D8',
      gutterText: '#8A8A8E',
      caret: '#000000',
      accent: '#1040B0',
      accentFill: 'rgba(16, 64, 176, 0.22)',
      accentFrame: 'rgba(16, 64, 176, 0.8)',
      splitMarkFill: 'rgba(16, 64, 176, 0.12)',
    },
    dark: {
      paper: '#000000',
      lyric: '#FFFFFF',
      chord: '#FFD60A',
      chordBand: '#1F3A5C',
      curLine: '#2A2818',
      targetFill: '#5A4220',
      targetFrame: '#FF9A33',
      freeTargetFill: '#1F4A26',
      freeTargetFrame: '#5CC46A',
      gutter: '#1C1C1E',
      gutterLine: '#3A3A3C',
      gutterText: '#8E8E93',
      caret: '#FFFFFF',
      accent: '#7FA8FF',
      accentFill: 'rgba(127, 168, 255, 0.22)',
      accentFrame: 'rgba(127, 168, 255, 0.8)',
      splitMarkFill: 'rgba(127, 168, 255, 0.12)',
    },
  };
  let COLOR = THEMES.light;

  /**
   * コードの色（iPad のアプリ版と同じ名前と色）。標準（色なし）は黄色。
   * 前の版の Web 版で付けた 'yellow' と、知らない名前の色は標準として描く
   */
  const CHORD_COLORS = [
    { key: 'red', label: '赤', light: '#D70015', dark: '#FF6961' },
    { key: 'blue', label: '青', light: '#0040DD', dark: '#5AC8FA' },
    { key: 'green', label: '緑', light: '#1E8A3A', dark: '#4CD964' },
    { key: 'purple', label: '紫', light: '#8E24AA', dark: '#DA8FFF' },
    { key: 'orange', label: '橙', light: '#D45500', dark: '#FF9F0A' },
  ];

  function chordColorCss(key) {
    const c = key && CHORD_COLORS.find((o) => o.key === key);
    return c ? (COLOR === THEMES.dark ? c.dark : c.light) : COLOR.chord;
  }

  /** メニュー・パレットに並べる色（先頭が標準の黄色） */
  function colorChoices() {
    const dark = COLOR === THEMES.dark;
    return [{ key: '', label: '黄（標準）', css: COLOR.chord }]
      .concat(CHORD_COLORS.map((o) => ({ key: o.key, label: o.label, css: dark ? o.dark : o.light })));
  }

  /** 標準の色か（色なし・前の版の 'yellow'・知らない名前） */
  function isStandardColor(key) {
    return !key || !CHORD_COLORS.some((o) => o.key === key);
  }

  /** コードの点滅の速さ（iPad のアプリ版と同じ。1 秒のうち 0.7 秒点いて 0.3 秒消える） */
  const BLINK_PERIOD_MS = 1000;
  const BLINK_ON_RATIO = 0.7;

  // 歌詞はヒラギノ角ゴ（W3、太字は W6）、コードはシステムの文字の semibold（iPad のアプリ版と同じ）
  const LYRIC_FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic UI","Meiryo",sans-serif';
  const CHORD_FONT = '-apple-system,BlinkMacSystemFont,"Helvetica Neue","Segoe UI",Arial,"Hiragino Sans",sans-serif';
  const GUTTER_FONT = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

  // 日本語入力がオンのままコード入力したときに、押されたキーから文字を求める
  function charFromCode(code, shift) {
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return shift ? m[1] : m[1].toLowerCase();
    m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
    if (m) return shift && code.startsWith('Digit') ? (m[1] === '3' ? '#' : '') : m[1];
    switch (code) {
      case 'Slash': case 'NumpadDivide': return shift ? '' : '/';
      case 'IntlYen': case 'Backslash': return shift ? '|' : '';
      case 'Minus': case 'NumpadSubtract': return shift ? '' : '-';
      case 'Space': return ' ';
      default: return '';
    }
  }

  // 位置 at 以降の番号を n だけ後ろへずらす（歌詞に文字を入れたときの太字の位置）
  function shiftSet(set, at, n) {
    const r = new Set();
    for (const k of set) r.add(k >= at ? k + n : k);
    return r;
  }

  // 全角英数字を半角に
  function toHalfWidth(s) {
    let r = '';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0xFF01 && c <= 0xFF5E) r += String.fromCharCode(c - 0xFEE0);
      else if (c === 0x3000) r += ' ';
      else r += ch;
    }
    return r;
  }

  // 角の丸い四角の道筋（塗る・線を引くのは呼んだ側）
  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  class Editor {
    constructor(host) {
      this.host = host;
      host.classList.add('lc-editor');
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'lc-canvas';
      this.ctx = this.canvas.getContext('2d');
      this.scroller = document.createElement('div');
      this.scroller.className = 'lc-scroller';
      this.spacer = document.createElement('div');
      this.spacer.className = 'lc-spacer';
      this.scroller.appendChild(this.spacer);
      // 歌詞・自由文字の入力欄（日本語入力を使う）
      this.ta = document.createElement('textarea');
      this.ta.className = 'lc-input lc-ta';
      this.ta.setAttribute('aria-label', '歌詞の入力');
      // コード入力欄（キーを 1 つずつ受け取る）
      this.ck = document.createElement('input');
      this.ck.type = 'text';
      this.ck.className = 'lc-input lc-ck';
      this.ck.setAttribute('aria-label', 'コードの入力');
      for (const el of [this.ta, this.ck]) {
        el.setAttribute('autocapitalize', 'off');
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('autocorrect', 'off');
        el.spellcheck = false;
      }
      this.ta.setAttribute('wrap', 'off');
      this.ta.rows = 1;
      host.append(this.canvas, this.ta, this.ck, this.scroller);

      this.lines = [new SheetLine()];
      this._mode = 'both';
      this._freeText = false;
      this._fontSize = DEFAULT_FONT_SIZE;
      this.cellW = 10; this.chordH = 18; this.lyricH = 24; this.lineH = 46; this._gutterW = 40;
      this.ys = [0];            // 各行の上端（行の高さの累計。閲覧では歌詞のない行を詰める）
      this.contentW = 0; this.contentH = 0;
      this.caretLine = 0; this.caretIdx = 0; this.caretOn = true;
      this.targetLine = 0; this.targetCol = 0;
      this.mouseInside = false; this.mouseOnChordRow = false;
      this.pendingBass = false; this.lastPart = 'none';
      this.dragging = false; this.dragMoved = false;
      this.dragLine = 0; this.dragIdx = 0; this.dragOffset = 0; this.dragStartX = 0; this.dragStartY = 0;
      this.pressX = 0; this.pressY = 0; this.longPressTimer = 0; this.longPressAt = 0;
      this.panCandidate = false; this.panning = false; this.panTop = 0; this.panLeft = 0;
      this.lastMouse = null;
      this.undoStack = []; this.redoStack = []; this.lastUndoKind = UK_NONE;
      this.modified = false;
      this.menuLine = 0; this.menuCol = 0;
      this.focused = false; this.composing = false; this.cancelComposition = false;
      this.suppressScrollHover = false;
      this.onChange = null; this.onStatus = null; this.onPaste = null;
      // 左右 2 列の閲覧（横長の画面の閲覧で、左の列から右の列へ続ける。iPad のアプリ版と同じ）
      this._splitEnabled = true;
      this._splitLine = null;     // 右の列の先頭の行（null は自動）
      this._choosingSplit = false; // 分割位置をタップで選んでいるところ
      this.onSplitChange = null;
      // 「右側も一緒に」：コードを動かすとき、同じ行でそれより右のコードもまとめて動かす（曲を開くたび・モードを変えるたびにオフ）
      this.shiftRight = false;
      // コードパレットの「入力後に右へ」と、右へ進めた直後の直前のコード（{ line, col, atLine, atCol }）
      this.autoAdvance = true;
      this.lastEntry = null;
      // コードパレットを閉じた（コード行をタップし直すまで出さない）
      this.paletteDismissed = false;
      // 範囲選択（範囲コピー・点滅・色）：{ purpose, byLine, start: {line, col}, end: {line, col} | null }
      this.range = null;
      this.clip = null;         // 範囲コピーで写したコード（曲を開き直すまで）
      this.onRangeChange = null;
      this.onZoom = null;       // ピンチで文字の大きさを変えたとき
      this.pinch = null;

      this.updateMetrics();
      this.attachEvents();
      new ResizeObserver(() => this.resize()).observe(host);
      setInterval(() => {
        if (this.focused && this.lyricCaretActive()) { this.caretOn = !this.caretOn; this.invalidate(); }
      }, 530);
      // 点滅させるコードがあるときだけ、点く・消えるの変わり目で描き直す
      this.blinkOn = true;
      setInterval(() => {
        const on = (Date.now() % BLINK_PERIOD_MS) < BLINK_PERIOD_MS * BLINK_ON_RATIO;
        if (on !== this.blinkOn) {
          this.blinkOn = on;
          if (this.lines.some((l) => l.chords.some((c) => c.blink))) this.invalidate();
        }
      }, 50);
      this.resize();
    }

    // ---- プロパティ ----

    get mode() { return this._mode; }
    set mode(v) {
      if (this._mode === v) return;
      this._mode = v;
      this.dragging = false; this.pendingBass = false; this.lastPart = 'none';
      this.lastUndoKind = UK_NONE;
      this.shiftRight = false; this.lastEntry = null;
      this.cancelRange();
      if (v !== 'both') this.mouseOnChordRow = false;
      this.scroller.classList.toggle('view', v === 'view');
      if (v !== 'view') this._choosingSplit = false;
      this.updateContentSize();
      this.applyFocus(false);
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    get splitEnabled() { return this._splitEnabled; }
    set splitEnabled(v) { this._splitEnabled = !!v; this.relayout(); }

    get splitStart() { return this._splitLine; }
    set splitStart(v) {
      this._splitLine = v == null ? null : Math.max(1, Math.round(v));
      this.relayout();
    }

    get choosingSplit() { return this._choosingSplit; }
    set choosingSplit(v) { this._choosingSplit = !!v && this.twoColumn; this.invalidate(); }

    /** 今、左右 2 列で見せているか（閲覧で、画面が横長で、2 行以上あるとき） */
    get twoColumn() {
      return this._splitEnabled && this._mode === 'view' && this.lines.length >= 2 &&
        this.host.clientWidth > this.host.clientHeight;
    }

    /** 自動の分割位置：真ん中の近くの空行の次（なければ真ん中）。アプリ版の autoSplitLine と同じ */
    autoSplitLine() {
      const n = this.lines.length;
      if (n < 2) return n;
      const half = Math.floor((n + 1) / 2);
      const blank = (i) => this.lines[i].text.trim() === '' && this.lines[i].chords.length === 0;
      for (let d = 0; d <= Math.max(1, Math.floor(n / 6)); d++) {
        for (const i of [half - 1 - d, half - 1 + d]) {
          if (i > 0 && i < n - 1 && blank(i)) return i + 1;
        }
      }
      return half;
    }

    /** 右の列の先頭の行（1～行数-1） */
    splitAt() {
      const n = this.lines.length;
      if (n < 2) return n;
      return Math.min(Math.max(1, this._splitLine ?? this.autoSplitLine()), n - 1);
    }

    /** 分割位置を変える（選んでいる間のボタン・タップから）。null で自動 */
    setSplit(v) {
      const k = v == null ? null : Math.min(Math.max(1, v), Math.max(1, this.lines.length - 1));
      if (k === this._splitLine) return;
      this.splitStart = k;
      if (this.onSplitChange) this.onSplitChange(k);
    }

    relayout() {
      if (!this._choosingSplit || this.twoColumn) { /* そのまま */ } else this._choosingSplit = false;
      this.updateContentSize();
      this.invalidate();
    }

    get freeText() { return this._freeText; }
    set freeText(v) {
      if (this._freeText === v) return;
      this._freeText = v;
      this.pendingBass = false; this.lastPart = 'none'; this.lastUndoKind = UK_NONE;
      this.applyFocus(false);
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    /** 画面の明るさ（'light' / 'dark'） */
    get theme() { return COLOR === THEMES.dark ? 'dark' : 'light'; }
    set theme(v) {
      COLOR = v === 'dark' ? THEMES.dark : THEMES.light;
      this.host.style.background = COLOR.paper;
      this.invalidate();
    }

    /** 行番号の欄の幅（編集中だけ出す。閲覧では出さない。iPad のアプリ版と同じ） */
    get gutterW() { return this._mode === 'view' ? 0 : this._gutterW; }

    get fontSize() { return this._fontSize; }
    set fontSize(v) {
      v = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(v)));
      if (v === this._fontSize) return;
      this._fontSize = v;
      this.updateMetrics();
      this.updateContentSize();
      this.updateImeAnchor();
      this.invalidate();
    }

    /** コード入力で画面のキーボードを出すか（コードパレットを使うときは出さない。ハードウェアのキーボードはそのまま使える） */
    set chordKeyboard(v) { this.ck.inputMode = v ? 'text' : 'none'; }

    get topY() { return this.scroller.scrollTop; }
    get leftX() { return this.scroller.scrollLeft; }
    get viewW() { return this.scroller.clientWidth; }
    get viewH() { return this.scroller.clientHeight; }

    // ---- メトリクス・スクロール ----

    // 寸法は iPad のアプリ版（SheetMetrics）と同じ考え方：コードは歌詞と同じ大きさ、1 セルは全角文字の半分
    updateMetrics() {
      const px = this._fontSize;
      const gutterPx = Math.max(8, Math.round(px * 0.6));
      this.lyricPx = px;
      this.chordPx = px;
      this.lyricFont = `${px}px ${LYRIC_FONT}`;
      this.lyricBoldFont = `bold ${px}px ${LYRIC_FONT}`;
      this.chordFont = `600 ${px}px ${CHORD_FONT}`;
      this.gutterFont = `${gutterPx}px ${GUTTER_FONT}`;
      const ctx = this.ctx;
      ctx.font = this.lyricFont;
      this.cellW = Math.max(2, Math.ceil(ctx.measureText('漢').width / 2));
      this.lyricH = Math.ceil(px * 1.5 + 6);
      this.chordH = Math.ceil(px * 1.2 + 2);
      this.lineH = this.chordH + this.lyricH + 4;
      ctx.font = this.gutterFont;
      this._gutterW = Math.ceil(ctx.measureText('0000').width) + 14;
      this.charW = new Map();   // 歌詞の文字・コード名の幅（描くたびに測らないよう覚えておく）
      this.chordW = new Map();
    }

    // 歌詞の文字 1 つの幅
    lyricCharWidth(s, bold) {
      const k = (bold ? 'b' : 'n') + s;
      let w = this.charW.get(k);
      if (w === undefined) {
        this.ctx.font = bold ? this.lyricBoldFont : this.lyricFont;
        w = this.ctx.measureText(s).width;
        this.charW.set(k, w);
      }
      return w;
    }

    /** 行 i の高さ。閲覧では歌詞が空白だけの行をコード行の高さに詰める（iPad のアプリ版と同じ） */
    rowH(i) {
      if (this._mode === 'view' && i < this.lines.length && this.lines[i].text.trim() === '') return this.chordH;
      return this.lineH;
    }

    // 各行の上端を求め直す
    computeRows() {
      const n = this.lines.length;
      const ys = new Array(n + 1);
      ys[0] = 0;
      for (let i = 0; i < n; i++) ys[i + 1] = ys[i] + this.rowH(i);
      this.ys = ys;
    }

    /** 行 l の上端（文書の先頭から。最終行より下はふつうの行の高さで続ける） */
    rowY(l) {
      const n = this.lines.length;
      if (this.ys.length !== n + 1) this.computeRows();
      return l <= n ? this.ys[l] : this.ys[n] + (l - n) * this.lineH;
    }

    /** 文書の先頭からの高さ yy にある行 */
    rowAt(yy) {
      const n = this.lines.length;
      if (this.ys.length !== n + 1) this.computeRows();
      if (yy < 0) return 0;
      if (yy >= this.ys[n]) return n + Math.floor((yy - this.ys[n]) / this.lineH);
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.ys[mid] <= yy) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    resize() {
      const w = this.host.clientWidth, h = this.host.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.dpr = dpr;
      this.updateContentSize();
      this.updateImeAnchor();
      this.draw();
    }

    updateContentSize() {
      this.computeRows();
      const n = this.lines.length;
      if (this.twoColumn) {
        // 2 列のときは横にはスクロールしない。高さは長い方の列に合わせる
        const k = this.splitAt();
        this.contentW = this.viewW;
        this.contentH = TOP_MARGIN * 2 + Math.max(this.ys[k], this.ys[n] - this.ys[k]) + 24;
        this.spacer.style.width = '1px';
        this.spacer.style.height = Math.ceil(this.contentH) + 'px';
        return;
      }
      let maxC = 0;
      for (const sl of this.lines) {
        let c = Text.allCells(sl.text);
        for (const ch of sl.chords) c = Math.max(c, ch.col + this.chordCells(ch.name));
        maxC = Math.max(maxC, c);
      }
      // 内容が画面より広いときだけ横にスクロールする。編集中は最終行の下に入力用の行を 3 行見せる
      this.contentW = Math.max(this.viewW, this.gutterW + LEFT_PAD + (maxC + 8) * this.cellW);
      this.contentH = TOP_MARGIN * 2 + this.ys[n] + (this._mode === 'view' ? 0 : EXTRA_LINES_BELOW * this.lineH);
      this.spacer.style.width = Math.ceil(this.contentW) + 'px';
      this.spacer.style.height = Math.ceil(this.contentH) + 'px';
    }

    // プログラムからのスクロール（マウス位置で入力位置を変えない）
    scrollTo(top, left) {
      const maxTop = Math.max(0, this.contentH - this.viewH);
      const maxLeft = Math.max(0, this.contentW - this.viewW);
      top = Math.max(0, Math.min(maxTop, top));
      left = Math.max(0, Math.min(maxLeft, left));
      if (Math.round(top) === Math.round(this.topY) && Math.round(left) === Math.round(this.leftX)) return;
      this.suppressScrollHover = true;
      this.scroller.scrollTop = top;
      this.scroller.scrollLeft = left;
    }

    ensureVisible(l, cell) {
      this.updateContentSize();
      const t = TOP_MARGIN + this.rowY(l);
      let top = this.topY;
      if (t < top) top = t - TOP_MARGIN;
      else if (t + this.lineH > top + this.viewH) top = t + this.lineH - this.viewH + TOP_MARGIN;
      const x = cell * this.cellW;
      const viewW = this.viewW - this.gutterW - LEFT_PAD;
      let left = this.leftX;
      if (x < left) left = Math.max(0, x - viewW / 4);
      else if (x > left + viewW - this.cellW * 3) left = x - viewW + this.cellW * 6;
      this.scrollTo(top, left);
    }

    // ---- 座標 ----

    xOrigin() { return this.gutterW + LEFT_PAD - this.leftX; }
    lineTop(l) { return TOP_MARGIN + this.rowY(l) - this.topY; }

    // beyond = true のときは最終行より下の何もない所も行として返す（コード入力用）
    yToLine(y, beyond) {
      const yy = y + this.topY - TOP_MARGIN;
      let r = this.rowAt(yy);
      const max = this.lines.length - 1 + (beyond ? MAX_VIRTUAL_LINES : 0);
      if (r > max) r = max;
      const rel = yy - this.rowY(r);
      // まだ行のない所は、行全体をコード行として扱う
      return { line: r, onChord: rel < this.chordH + 1 || r >= this.lines.length };
    }

    xToCol(x) {
      const c = x - this.xOrigin();
      return c < 0 ? 0 : Math.floor(c / this.cellW);
    }

    idxFromCellF(l, cellF) {
      const t = this.lines[l].text;
      let best = 0, bestD = Math.abs(cellF), acc = 0;
      for (let i = 1; i <= t.length; i++) {
        acc += Text.charCells(t.charCodeAt(i - 1));
        if (i < t.length && Text.isLowSur(t.charCodeAt(i))) continue;
        const d = Math.abs(acc - cellF);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    chordTextWidth(s) {
      let w = this.chordW.get(s);
      if (w === undefined) {
        this.ctx.font = this.chordFont;
        w = this.ctx.measureText(s).width;
        this.chordW.set(s, w);
      }
      return w;
    }

    // コード名が占めるセル数（文字数か、描いた幅の多い方）
    chordCells(s) {
      return Math.max(1, s.length, Math.ceil(this.chordTextWidth(s) / this.cellW - 1e-6));
    }

    // 細い記号を桁の中で寄せる量：「||:」は右（後ろのコードの側）、「:||」は左、小節線などは中央。
    // コードや文字は寄せない（iPad のアプリ版と同じ）
    chordInset(s) {
      if (!/^[|:]+$/.test(s)) return 0;
      const slack = s.length * this.cellW - this.chordTextWidth(s);
      if (slack <= 0) return 0;
      if (s.endsWith(':')) return slack;
      if (s.startsWith(':')) return 0;
      return slack / 2;
    }

    // 指定桁にあるコードの番号（コード名の表示範囲内も含む）
    chordHit(l, c) {
      if (l < 0 || l >= this.lines.length) return -1;
      const sl = this.lines[l];
      const exact = sl.findChordCol(c);
      if (exact >= 0) return exact;
      // 描いたコード名の上（前のコードと重ならないよう右へずらして描いたものは、その位置）
      const xs = this.chordOffsets(sl);
      const x = (c + 0.5) * this.cellW;
      for (let i = sl.chords.length - 1; i >= 0; i--) {
        if (x >= xs[i] && x < xs[i] + Math.max(this.cellW, this.chordTextWidth(sl.chords[i].name))) return i;
      }
      return -1;
    }

    // ---- 状態 ----

    chordKeyActive() {
      return this._mode === 'chord' || (this._mode === 'both' && this.mouseInside && this.mouseOnChordRow);
    }

    lyricCaretActive() {
      return (this._mode === 'lyric' || this._mode === 'both') && !this.chordKeyActive();
    }

    chordTargetShown() {
      return this.chordKeyActive() && (this.focused || this.mouseInside);
    }

    // キー入力を受ける要素（閲覧中はスクロール領域、歌詞・自由文字は日本語入力を使う入力欄）
    sinkElement() {
      if (this._mode === 'view') return this.scroller;
      // コードパレットを使うとき（画面のキーボードを出さないとき）の自由文字は、パレットの入力欄で入れる
      if (this.lyricCaretActive() || (this._freeText && this.chordKeyActive() && this.ck.inputMode !== 'none')) return this.ta;
      return this.ck;
    }

    applyFocus(force) {
      if (this.composing) return;
      const want = this.sinkElement();
      this.scroller.tabIndex = this._mode === 'view' ? 0 : -1;
      if ((force || this.focused) && document.activeElement !== want) want.focus({ preventScroll: true });
    }

    focusEditor() { this.applyFocus(true); }

    clampPositions() {
      if (this.lines.length === 0) this.lines.push(new SheetLine());
      this.caretLine = Math.max(0, Math.min(this.lines.length - 1, this.caretLine));
      this.caretIdx = Math.max(0, Math.min(this.lines[this.caretLine].text.length, this.caretIdx));
      this.targetLine = Math.max(0, Math.min(this.lines.length - 1 + MAX_VIRTUAL_LINES, this.targetLine));
      if (this.targetCol < 0) this.targetCol = 0;
    }

    // 最終行より下にコードを置くとき、そこまで空行を追加する
    ensureLines(l) {
      while (this.lines.length <= l) this.lines.push(new SheetLine());
    }

    doStatus() { if (this.onStatus) this.onStatus(this); }

    changed() {
      this.modified = true;
      this.clampPositions();
      this.updateContentSize();
      this.updateImeAnchor();
      this.invalidate();
      if (this.onChange) this.onChange(this);
      this.doStatus();
    }

    setModified(v) {
      this.modified = v;
      if (this.onChange) this.onChange(this);
    }

    statusText() {
      if (this._mode === 'view') return '閲覧中（編集できません）';
      if (this.range) return '範囲を選んでいます（終わりの位置のコード行をタップ）';
      if (this.chordKeyActive()) {
        let r = `行 ${this.targetLine + 1}  位置 ${this.targetCol + 1}`;
        const idx = this.chordHit(this.targetLine, this.targetCol);
        if (idx >= 0) r += '  コード: ' + this.lines[this.targetLine].chords[idx].name;
        if (this._freeText) {
          r += '  [自由文字]   ｜ 打った文字をそのまま入力  空白:次の位置へ  BackSpace:1文字削除  ' +
            'Enter:直接入力  Del:削除  Ctrl+Shift+F:自由文字オフ';
        } else {
          if (this.pendingBass) r += '  [ベース音を入力]';
          r += '   ｜ C～B:基音  #/b:♯♭  /:オンコード  数字:入力  m:追記  |:小節線  ' +
            '右クリック・長押し:基音／種類  Enter:直接入力  Del:削除  Shift+矢印:移動  Ctrl+Shift+F:自由文字';
        }
        return r;
      }
      let r = `行 ${this.caretLine + 1}  文字 ${this.caretIdx + 1}`;
      if (this._mode === 'both') r += '   ｜ コード行（色付きの帯）を指すとコード入力になります';
      return r;
    }

    // ---- 元に戻す ----

    getState() {
      return JSON.stringify({
        cl: this.caretLine, ci: this.caretIdx,
        lines: this.lines.map((l) => [l.text, l.chords.map((c) => [c.col, c.name, c.blink ? 1 : 0, c.color || '']),
          [...l.bold]]),
      });
    }

    setState(s) {
      const st = JSON.parse(s);
      this.lines = st.lines.map(([t, cs, bold]) => new SheetLine(t,
        cs.map(([col, name, blink, color]) => Sheet.copyChord({ col, name, blink: !!blink, color: color || '' })),
        new Set(bold || [])));
      this.caretLine = st.cl;
      this.caretIdx = st.ci;
      this.clampPositions();
    }

    beginChange(kind) {
      if ((kind === UK_TYPING || kind === UK_DELETE || kind === UK_MOVE) && this.lastUndoKind === kind) return;
      this.undoStack.push(this.getState());
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.lastUndoKind = kind;
    }

    undo() {
      if (!this.undoStack.length) return;
      this.redoStack.push(this.getState());
      this.setState(this.undoStack.pop());
      this.lastUndoKind = UK_NONE;
      this.changed();
      this.ensureVisible(this.caretLine, Text.textCells(this.lines[this.caretLine].text, this.caretIdx));
    }

    redo() {
      if (!this.redoStack.length) return;
      this.undoStack.push(this.getState());
      this.setState(this.redoStack.pop());
      this.lastUndoKind = UK_NONE;
      this.changed();
      this.ensureVisible(this.caretLine, Text.textCells(this.lines[this.caretLine].text, this.caretIdx));
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    // ---- 描画 ----

    invalidate() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
    }

    draw() {
      const ctx = this.ctx;
      const w = this.host.clientWidth, h = this.host.clientHeight;
      ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
      ctx.textBaseline = 'top';
      ctx.fillStyle = COLOR.paper;
      ctx.fillRect(0, 0, w, h);
      const xo = this.xOrigin();
      const chordModes = this._mode === 'chord' || this._mode === 'both';
      const lyricModes = this._mode === 'lyric' || this._mode === 'both';
      const showTarget = this.chordTargetShown();
      const showCaret = this.focused && this.lyricCaretActive() && this.caretOn && !this.composing;
      if (this.twoColumn) { this.drawTwoColumns(w, h); return; }
      const first = this.yToLine(0, false).line;
      const lastVirt = Math.min(this.lines.length - 1 + MAX_VIRTUAL_LINES, this.yToLine(this.viewH, true).line + 1);
      const last = Math.min(this.lines.length - 1, lastVirt);

      for (let i = first; i <= lastVirt; i++) {
        // 最終行より下は、コード入力用の帯と入力位置だけを描く
        let sl = null;
        if (i < this.lines.length) sl = this.lines[i];
        else if (!chordModes) break;
        const y = this.lineTop(i);
        if (chordModes) {
          ctx.fillStyle = COLOR.chordBand;
          ctx.fillRect(this.gutterW, y, w, this.chordH);
        }
        if (lyricModes && i === this.caretLine && this.focused) {
          ctx.fillStyle = COLOR.curLine;
          ctx.fillRect(this.gutterW, y + this.chordH, w, this.lyricH);
        }
        if (this.range) this.drawRange(i, xo, y, w);
        else if (showTarget && i === this.targetLine) {
          const hit = this.chordHit(i, this.targetCol);
          let x, tw;
          if (hit >= 0) {
            x = xo + this.chordOffsets(sl)[hit];
            tw = this.chordTextWidth(sl.chords[hit].name);
          } else {
            x = xo + this.targetCol * this.cellW;
            tw = this.cellW;
          }
          ctx.fillStyle = this._freeText ? COLOR.freeTargetFill : COLOR.targetFill;
          ctx.strokeStyle = this._freeText ? COLOR.freeTargetFrame : COLOR.targetFrame;
          ctx.lineWidth = 1;
          roundRect(ctx, x - 3, y + 0.5, tw + 6, this.chordH - 1, 3);
          ctx.fill();
          ctx.stroke();
        }
        if (!sl) continue;

        this.drawLineContent(sl, xo, y, this.gutterW, w);

        if (showCaret && i === this.caretLine) {
          ctx.fillStyle = COLOR.caret;
          const cx = xo + Text.textCells(sl.text, this.caretIdx) * this.cellW;
          ctx.fillRect(cx - 1, y + this.chordH + 2, 2, this.lyricH - 3);
        }
      }
      if (this.gutterW > 0) this.drawGutter(first, last, h);
    }

    // 範囲選択（範囲コピー・点滅・色）で選んでいるところを、コード行に色を付けて見せる
    drawRange(i, xo, y, w) {
      const r = this.range;
      const s = r.start, e = r.end || r.start;
      const [a, b] = s.line < e.line || (s.line === e.line && s.col <= e.col) ? [s, e] : [e, s];
      if (i < a.line || i > b.line) return;
      let x1 = this.gutterW, x2 = w;
      if (!r.byLine) {
        if (i === a.line) x1 = xo + a.col * this.cellW - 2;
        if (i === b.line) {
          // 終わりの位置にコードがあれば、そのコード名の幅まで含める
          const hit = i < this.lines.length ? this.lines[i].findChordCol(b.col) : -1;
          const tw = hit >= 0 ? Math.max(this.cellW, this.chordTextWidth(this.lines[i].chords[hit].name)) : this.cellW;
          x2 = xo + b.col * this.cellW + tw + 2;
        }
      }
      if (x2 <= x1) return;
      const ctx = this.ctx;
      ctx.fillStyle = COLOR.accentFill;
      ctx.fillRect(x1, y + 0.5, x2 - x1, this.chordH - 1);
      ctx.strokeStyle = COLOR.accentFrame;
      ctx.lineWidth = 1;
      ctx.strokeRect(x1 + 0.5, y + 0.5, x2 - x1 - 1, this.chordH - 1);
    }

    /**
     * 行のコードを描く x（xo からの距離）。コード名は歌詞と同じ大きさなので、桁の幅より広く描けることがある。
     * 前のコード名と重なるときは、描く位置だけを右へずらす（桁の位置そのものは変えない）
     */
    chordOffsets(sl) {
      const r = [];
      let minX = -Infinity;
      for (const c of sl.chords) {
        const x = Math.max(c.col * this.cellW + this.chordInset(c.name), minX);
        r.push(x);
        minX = x + this.chordTextWidth(c.name) + this.cellW * 0.6;
      }
      return r;
    }

    // 1 行分のコードと歌詞を描く（xo: 歌詞の左端、y: 行の上端、left・right: 描く範囲）
    drawLineContent(sl, xo, y, left, right) {
      const ctx = this.ctx;
      const xs = this.chordOffsets(sl);
      ctx.font = this.chordFont;
      sl.chords.forEach((c, i) => {
        // 点滅させるコードは消えている間、閲覧では見えなくし、編集中は薄く残す（どこにあるか分かるように）
        if (c.blink && !this.blinkOn) {
          if (this._mode === 'view') return;
          ctx.globalAlpha = 0.25;
        }
        ctx.fillStyle = chordColorCss(c.color);
        ctx.fillText(c.name, xo + xs[i], y + 1);
        ctx.globalAlpha = 1;
      });
      if (this._mode === 'view' && sl.text.trim() === '') return;

      ctx.fillStyle = COLOR.lyric;
      const t = sl.text;
      const ty = y + this.chordH + 3;
      let x = xo;
      for (let j = 0; j < t.length;) {
        const cells = Text.charCells(t.charCodeAt(j));
        const bold = sl.bold.has(j);
        let s;
        if (j + 1 < t.length && Text.isLowSur(t.charCodeAt(j + 1))) { s = t.substr(j, 2); j += 2; } else { s = t[j]; j++; }
        const cw = cells * this.cellW;
        if (s !== ' ' && x + cw > left && x < right) {
          ctx.font = bold ? this.lyricBoldFont : this.lyricFont;
          // 文字は 1 つずつセルの位置に置き、セルに収まらない文字は横だけ縮める
          const sw = this.lyricCharWidth(s, bold);
          if (sw > cw + 0.5) {
            ctx.save();
            ctx.translate(x, ty);
            ctx.scale(cw / sw, 1);
            ctx.fillText(s, 0, 0);
            ctx.restore();
          } else {
            ctx.fillText(s, x, ty);
          }
        }
        x += cw;
      }
    }

    // 左右 2 列の閲覧：左の列に先頭から、右の列に分割位置から描く（行番号は出さない）
    drawTwoColumns(w, h) {
      const ctx = this.ctx;
      const k = this.splitAt();
      const colW = (w - COLUMN_GAP) / 2;
      const cols = [{ from: 0, to: k, x: 0 }, { from: k, to: this.lines.length, x: colW + COLUMN_GAP }];
      for (const col of cols) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(col.x, 0, colW, h);
        ctx.clip();
        for (let i = col.from; i < col.to; i++) {
          const y = TOP_MARGIN + this.rowY(i) - this.rowY(col.from) - this.topY;
          const rh = this.rowH(i);
          if (y + rh < 0 || y > h) continue;
          if (this._choosingSplit && i === k) {
            ctx.fillStyle = COLOR.splitMarkFill;
            ctx.fillRect(col.x, y, colW, rh);
            ctx.fillStyle = COLOR.accent;
            ctx.fillRect(col.x, y, colW, 3);
          }
          this.drawLineContent(this.lines[i], col.x + LEFT_PAD, y, col.x, col.x + colW);
          if (this._choosingSplit && i === k) {
            // 右上に「ここから右の列」のラベル
            ctx.font = `600 ${Math.max(11, Math.round(this._fontSize * 0.6))}px ${CHORD_FONT}`;
            const label = 'ここから右の列';
            const lw = ctx.measureText(label).width + 16;
            const lh = Math.max(18, Math.round(this._fontSize * 0.6) + 8);
            ctx.fillStyle = COLOR.accent;
            roundRect(ctx, col.x + colW - lw - 6, y + 6, lw, lh, lh / 2);
            ctx.fill();
            ctx.fillStyle = COLOR.paper;
            ctx.textBaseline = 'middle';
            ctx.fillText(label, col.x + colW - lw + 2, y + 6 + lh / 2);
            ctx.textBaseline = 'top';
          }
        }
        ctx.restore();
      }
      ctx.fillStyle = COLOR.gutterLine;
      ctx.fillRect(Math.round(colW + COLUMN_GAP / 2), 0, 1, h);
    }

    /** 2 列のとき、画面の位置 (x, y) にある行（なければ -1） */
    twoColumnLineAt(x, y) {
      const k = this.splitAt();
      const colW = (this.host.clientWidth - COLUMN_GAP) / 2;
      const right = x > colW + COLUMN_GAP / 2;
      const yy = y + this.topY - TOP_MARGIN;
      if (yy < 0) return -1;
      const i = this.rowAt(yy + (right ? this.rowY(k) : 0));
      if (right ? i >= this.lines.length : i >= k) return -1;
      return i;
    }

    drawGutter(first, last, h) {
      const ctx = this.ctx;
      // 行番号
      ctx.fillStyle = COLOR.gutter;
      ctx.fillRect(0, 0, this.gutterW, h);
      ctx.fillStyle = COLOR.gutterLine;
      ctx.fillRect(this.gutterW - 1, 0, 1, h);
      ctx.font = this.gutterFont;
      ctx.fillStyle = COLOR.gutterText;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = first; i <= last; i++) {
        ctx.fillText(String(i + 1), this.gutterW - 6, this.lineTop(i) + this.chordH + this.lyricH / 2);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }

    // 入力欄を入力位置へ動かす（日本語入力の変換中の文字がそこに出る）
    updateImeAnchor() {
      let x, y, font, h, px;
      if (this.lyricCaretActive()) {
        x = this.xOrigin() + Text.textCells(this.lines[this.caretLine].text, this.caretIdx) * this.cellW;
        y = this.lineTop(this.caretLine) + this.chordH + 2;
        font = this.lyricFont;
        px = this.lyricPx;
        h = this.lyricH - 2;
      } else {
        const idx = this.chordHit(this.targetLine, this.targetCol);
        if (idx >= 0) {
          const c = this.lines[this.targetLine].chords[idx];
          x = this.xOrigin() + c.col * this.cellW + this.chordTextWidth(c.name);
        } else {
          x = this.xOrigin() + this.targetCol * this.cellW;
        }
        y = this.lineTop(this.targetLine) + 1;
        font = this.chordFont;
        px = this.chordPx;
        h = this.chordH - 2;
      }
      // 画面の外に出すと、iPad などでページ自体がスクロールしてしまう
      x = Math.max(this.gutterW, Math.min(this.viewW - 4, x));
      y = Math.max(0, Math.min(this.viewH - h, y));
      for (const el of [this.ta, this.ck]) {
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        el.style.height = h + 'px';
        el.style.font = font;
        // iPad の Safari は 16px 未満の入力欄を選ぶと画面を拡大してしまう
        if (px < 16) el.style.fontSize = '16px';
      }
    }

    // ---- イベント ----

    pos(e) {
      const r = this.scroller.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    attachEvents() {
      const sc = this.scroller;
      sc.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      sc.addEventListener('pointermove', (e) => this.onPointerMove(e));
      sc.addEventListener('pointerup', (e) => this.onPointerUp(e));
      sc.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
      sc.addEventListener('pointerleave', (e) => this.onPointerLeave(e));
      sc.addEventListener('contextmenu', (e) => this.onContextMenu(e));
      sc.addEventListener('dblclick', (e) => this.onDblClick(e));
      sc.addEventListener('click', () => { if (!UI.isMenuOpen()) this.focusEditor(); });
      sc.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      sc.addEventListener('scroll', () => this.onScroll());
      sc.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
      sc.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
      sc.addEventListener('touchend', (e) => this.onTouchEnd(e));
      sc.addEventListener('touchcancel', (e) => this.onTouchEnd(e));

      sc.addEventListener('keydown', (e) => this.onKeyDown(e, sc));
      this.ta.addEventListener('keydown', (e) => this.onKeyDown(e, this.ta));
      this.ck.addEventListener('keydown', (e) => this.onKeyDown(e, this.ck));
      this.ta.addEventListener('input', (e) => this.onTaInput(e));
      this.ck.addEventListener('input', (e) => this.onCkInput(e));
      for (const el of [this.ta, this.ck]) {
        el.addEventListener('compositionstart', () => this.onCompositionStart(el));
        el.addEventListener('compositionupdate', () => this.onCompositionUpdate(el));
        el.addEventListener('compositionend', (e) => this.onCompositionEnd(el, e));
      }
      for (const el of [this.ta, this.ck, sc]) {
        el.addEventListener('paste', (e) => {
          e.preventDefault();
          const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
          // 貼り付けた文字がコード譜なら、アプリ側でコード譜として読み込めるようにする
          if (this.onPaste) this.onPaste(text); else this.pasteText(text);
        });
      }
      this.host.addEventListener('focusin', () => {
        if (!this.focused) {
          this.focused = true;
          this.caretOn = true;
          this.invalidate();
          this.doStatus();
        }
      });
      this.host.addEventListener('focusout', (e) => {
        if (e.relatedTarget && this.host.contains(e.relatedTarget)) return;
        this.focused = false;
        this.dragging = false;
        this.invalidate();
      });
    }

    onPointerDown(e) {
      if (e.button !== 0 && e.button !== 2) return;
      const { x, y } = this.pos(e);
      if (x > this.viewW || y > this.viewH) return; // スクロールバー
      e.preventDefault(); // 入力欄からフォーカスを奪わない
      this.pressX = x; this.pressY = y;
      this.panning = false; this.panCandidate = false;
      this.lastMouse = { x, y };
      if (e.button === 0) {
        this.panTop = this.topY; this.panLeft = this.leftX;
        if (this._mode === 'chord' || this._mode === 'both') {
          clearTimeout(this.longPressTimer);
          this.longPressTimer = setTimeout(() => this.onLongPress(), LONG_PRESS_MS);
        }
      }
      if (this._mode === 'view' && this._choosingSplit && e.button === 0) {
        // タップした行を右の列の先頭にする（左の列の先頭の行は選べない）
        const i = this.twoColumnLineAt(x, y);
        if (i >= 0) this.setSplit(Math.max(1, i));
        return;
      }
      if (this._mode === 'view') {
        this.panCandidate = e.button === 0 && e.pointerType === 'mouse';
        this.focusEditor();
        return;
      }
      this.mouseInside = true;
      if (this.range && e.button === 0) {
        // 範囲選択中：タップした位置を範囲の終わりにする
        clearTimeout(this.longPressTimer);
        this.longPressTimer = 0;
        this.setRangeEnd(this.yToLine(y, true).line, this.xToCol(x));
        return;
      }
      this.updateHover(x, y);
      this.focusEditor();
      const active = this.chordKeyActive();
      const L = this.yToLine(y, active).line;
      const C = this.xToCol(x);
      if (active) {
        this.lastUndoKind = UK_NONE;
        if (this.paletteDismissed) {
          // 閉じたパレットは、コード行をタップし直すと出す
          this.paletteDismissed = false;
          this.doStatus();
        }
        if (e.button === 0) {
          const idx = this.chordHit(L, C);
          if (idx >= 0) {
            this.dragging = true;
            this.dragMoved = false;
            this.dragLine = L;
            this.dragIdx = idx;
            this.dragOffset = C - this.lines[L].chords[idx].col;
            this.dragStartX = x;
            this.dragStartY = y;
            try { this.scroller.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
          }
        }
      } else if ((this._mode === 'lyric' || this._mode === 'both') && e.button === 0) {
        this.moveCaret(L, this.idxFromCellF(L, (x - this.xOrigin()) / this.cellW));
      }
    }

    onPointerMove(e) {
      const { x, y } = this.pos(e);
      this.lastMouse = { x, y };
      if (e.pointerType === 'mouse') this.mouseInside = true;
      if (this.longPressTimer && Math.abs(x - this.pressX) + Math.abs(y - this.pressY) > 8) {
        clearTimeout(this.longPressTimer);
        this.longPressTimer = 0;
      }
      if (this.panCandidate && (e.buttons & 1)) {
        if (!this.panning && Math.abs(x - this.pressX) + Math.abs(y - this.pressY) >= 6) this.panning = true;
        if (this.panning) {
          this.scrollTo(this.panTop - (y - this.pressY), this.panLeft - (x - this.pressX));
          return;
        }
      }
      if (this.dragging) {
        if (!this.dragMoved && Math.abs(x - this.dragStartX) + Math.abs(y - this.dragStartY) >= 4) {
          this.dragMoved = true;
          this.beginChange(UK_OTHER);
          this.lastUndoKind = UK_NONE;
        }
        if (this.dragMoved) {
          const L = this.yToLine(y, true).line;
          const C = Math.max(0, this.xToCol(x) - this.dragOffset);
          if (this.shiftRight && L === this.dragLine) {
            // 「右側も一緒に」：同じ行の中では、右側のコードもまとめて動かす
            const line = this.lines[L];
            if (line.shiftChords(this.dragIdx, C - line.chords[this.dragIdx].col)) {
              this.targetLine = L;
              this.targetCol = C + this.dragOffset;
              this.changed();
            }
          } else if (this.moveChordRaw(this.dragLine, this.dragIdx, L, C)) {
            this.dragLine = L;
            this.dragIdx = this.lines[L].findChordCol(C);
            this.targetLine = L;
            this.targetCol = C + this.dragOffset;
            this.changed();
          }
          this.updateCursor(x, y);
        }
        return;
      }
      // コードパレットを出している間は、マウスを動かしただけでは入力位置を変えない（クリックで変える）
      if (e.pointerType === 'mouse' && e.buttons === 0) {
        if (this.holdTarget) this.updateCursor(x, y); else this.updateHover(x, y);
      }
    }

    onPointerUp(e, cancelled) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = 0;
      this.panCandidate = false;
      if (this.panning) { this.panning = false; return; }
      if (this.dragging) {
        this.dragging = false;
        try { this.scroller.releasePointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
        if (!cancelled) { const p = this.pos(e); this.updateCursor(p.x, p.y); }
      }
    }

    onPointerLeave(e) {
      // タッチでは指を離しても入力位置を保つ。コードパレットを出している間は、マウスがパレットへ移っても保つ
      if (e.pointerType !== 'mouse' || this.dragging || this.holdTarget) return;
      this.mouseInside = false;
      if (this._mode === 'both') {
        this.mouseOnChordRow = false;
        this.applyFocus(false);
        this.updateImeAnchor();
        this.doStatus();
      }
      this.invalidate();
    }

    // 長押し：右クリックの代わりにコードメニューを開く（タッチ操作用）
    onLongPress() {
      this.longPressTimer = 0;
      if (!(this._mode === 'chord' || this._mode === 'both') || this.panning || (this.dragging && this.dragMoved) ||
        this.range || this.pinch) return;
      this.dragging = false;
      this.panCandidate = false;
      const L = this.yToLine(this.pressY, true).line;
      this.mouseInside = true;
      if (this._mode === 'both') this.mouseOnChordRow = true;
      this.setTarget(L, this.xToCol(this.pressX));
      this.longPressAt = Date.now();
      this.showChordMenu(this.pressX, this.pressY);
    }

    onContextMenu(e) {
      e.preventDefault();
      if (Date.now() - this.longPressAt < 1500 || this._mode === 'view') return;
      const { x, y } = this.pos(e);
      this.mouseInside = true;
      this.updateHover(x, y);
      if (this.chordKeyActive()) this.showChordMenu(x, y);
    }

    onDblClick() {
      if (this.chordKeyActive()) {
        this.dragging = false;
        this.editChordDialog(this.targetLine, this.targetCol);
      }
    }

    onWheel(e) {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      this.fontSize = this._fontSize + (e.deltaY < 0 ? 1 : -1);
      if (this.onChange) this.onChange(this);
    }

    onScroll() {
      if (this.suppressScrollHover) {
        this.suppressScrollHover = false;
      } else if (this.mouseInside && !this.holdTarget && !this.dragging && !this.panning && this.lastMouse) {
        this.updateHover(this.lastMouse.x, this.lastMouse.y);
      }
      this.updateImeAnchor();
      this.draw();
    }

    // 2 本指のピンチで文字の大きさを変える（編集中も閲覧中も。iPad のアプリ版と同じ）
    pinchDistance(e) {
      const [a, b] = e.touches;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }

    onTouchMove(e) {
      if (!this.pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const d = this.pinchDistance(e);
      if (this.pinch.d0 < 10) return;
      const size = Math.round(this.pinch.size * d / this.pinch.d0);
      if (size !== this._fontSize) {
        this.fontSize = size;
        if (this.onZoom) this.onZoom(this);
      }
    }

    onTouchEnd(e) {
      if (this.pinch && e.touches.length < 2) this.pinch = null;
    }

    // コードの上から指でなぞったときは、画面のスクロールではなくコードの移動にする
    onTouchStart(e) {
      if (e.touches.length === 2) {
        // ピンチの始まり：1 本目の指で始めたドラッグ・長押しは取り消す
        clearTimeout(this.longPressTimer);
        this.longPressTimer = 0;
        this.dragging = false;
        this.panCandidate = false;
        this.pinch = { d0: this.pinchDistance(e), size: this._fontSize };
        e.preventDefault();
        return;
      }
      if (e.touches.length !== 1 || !(this._mode === 'chord' || this._mode === 'both')) return;
      const t = e.touches[0];
      const r = this.scroller.getBoundingClientRect();
      const x = t.clientX - r.left, y = t.clientY - r.top;
      const { line, onChord } = this.yToLine(y, true);
      if ((this._mode === 'chord' || onChord) && this.chordHit(line, this.xToCol(x)) >= 0) e.preventDefault();
    }

    updateCursor(x, y) {
      let c = 'text';
      if (this._mode === 'view') c = 'default';
      else if (this.dragging && this.dragMoved) c = 'move';
      else if (this.chordKeyActive()) {
        const L = this.yToLine(y, true).line;
        c = this.chordHit(L, this.xToCol(x)) >= 0 ? 'pointer' : 'crosshair';
      }
      this.scroller.style.cursor = c;
    }

    updateHover(x, y) {
      if (this._mode === 'view') return;
      const was = this.chordKeyActive();
      const { line, onChord } = this.yToLine(y, true);
      const c = this.xToCol(x);
      if (this._mode === 'both') this.mouseOnChordRow = onChord;
      if (this.chordKeyActive()) this.setTarget(line, c);
      if (was !== this.chordKeyActive()) {
        this.applyFocus(false);
        this.updateImeAnchor();
        this.invalidate();
        this.doStatus();
      }
      this.updateCursor(x, y);
    }

    // ---- キーボード ----

    onKeyDown(e, source) {
      if (UI.isMenuOpen()) return;
      // 日本語入力の変換中
      if (e.isComposing || e.keyCode === 229) {
        // コード入力中に日本語入力がオンだった：押されたキーから文字を求め、変換は取り消す
        if (source === this.ck && this.chordKeyActive() && !this._freeText && e.key === 'Process') {
          const ch = charFromCode(e.code, e.shiftKey);
          if (ch) {
            this.chordChar(ch);
            this.cancelComposition = true;
            setTimeout(() => {
              this.ck.blur();
              this.ck.value = '';
              this.ck.focus({ preventScroll: true });
              setTimeout(() => { this.cancelComposition = false; }, 50);
            }, 0);
          }
        }
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.altKey || (ctrl && e.key !== 'Home' && e.key !== 'End')) return;
      let handled;
      if (this._mode === 'view') handled = this.viewKeyDown(e);
      else if (this.chordKeyActive()) {
        if (!this._freeText && source === this.ck && e.key.length === 1) {
          this.chordChar(e.key);
          handled = true;
        } else {
          handled = this.chordKeyDown(e);
        }
      } else handled = this.lyricKeyDown(e);
      if (handled) e.preventDefault();
    }

    onTaInput(e) {
      if (this.composing || e.isComposing) return;
      const v = this.ta.value;
      this.ta.value = '';
      if (v) this.typeText(v);
    }

    onCkInput(e) {
      if (this.composing || e.isComposing) return;
      const v = this.ck.value;
      this.ck.value = '';
      if (!v || this.cancelComposition) return;
      // キー入力で処理できなかった文字（iPad の画面キーボードなど）
      this.typeText(v);
    }

    onCompositionStart(el) {
      this.composing = true;
      if (el === this.ta) {
        this.updateImeAnchor();
        el.classList.add('composing');
        this.invalidate();
      }
    }

    onCompositionUpdate(el) {
      if (el !== this.ta) return;
      this.ctx.font = el.style.font || this.lyricFont;
      el.style.width = Math.ceil(this.ctx.measureText(el.value).width + 8) + 'px';
    }

    onCompositionEnd(el, e) {
      this.composing = false;
      el.classList.remove('composing');
      el.style.width = '';
      const v = el.value || e.data || '';
      el.value = '';
      if (el === this.ck && this.cancelComposition) return;
      if (v) this.typeText(v);
      this.applyFocus(false);
      this.invalidate();
    }

    // 入力された文字列（歌詞なら挿入、自由文字なら 1 文字ずつ置く）
    typeText(v) {
      if (this._mode === 'view') return;
      if (this.chordKeyActive()) {
        if (this._freeText) for (const ch of v) this.freeTextInput(ch === '　' ? ' ' : ch);
        else for (const ch of toHalfWidth(v)) if (ch.length === 1) this.chordChar(ch);
      } else {
        this.insertLyricText(v, v.length === 1 ? UK_TYPING : UK_OTHER);
      }
    }

    // ---- 歌詞編集 ----

    setCaret(l, i) {
      this.caretLine = l;
      this.caretIdx = i;
      this.clampPositions();
      const t = this.lines[this.caretLine].text;
      if (this.caretIdx > 0 && this.caretIdx < t.length && Text.isLowSur(t.charCodeAt(this.caretIdx))) this.caretIdx--;
      this.caretOn = true;
      this.ensureVisible(this.caretLine, Text.textCells(t, this.caretIdx));
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    moveCaret(l, i) {
      this.lastUndoKind = UK_NONE;
      this.setCaret(l, i);
    }

    insertLyric(u) {
      if (!u) return;
      const sl = this.lines[this.caretLine];
      const p = Text.textCells(sl.text, this.caretIdx);
      const w = Text.allCells(u);
      const oldLen = Text.allCells(sl.text);
      const at = this.caretIdx;
      const inherit = at > 0 && sl.bold.has(at - 1);
      sl.text = sl.text.slice(0, at) + u + sl.text.slice(at);
      sl.bold = shiftSet(sl.bold, at, u.length);
      if (inherit) for (let k = at; k < at + u.length; k++) sl.bold.add(k);
      // 歌詞の上に乗っているコードは文字と一緒に動かす。行末より右に置いたコードは動かさない
      for (const c of sl.chords) if (c.col >= p && c.col < oldLen) c.col += w;
      sl.normalize();
      this.caretIdx += u.length;
    }

    deleteLyric(l, idx, count) {
      const sl = this.lines[l];
      const p = Text.textCells(sl.text, idx);
      const w = Text.allCells(sl.text.substr(idx, count));
      const oldLen = Text.allCells(sl.text);
      sl.text = sl.text.slice(0, idx) + sl.text.slice(idx + count);
      const bold = new Set();
      for (const k of sl.bold) {
        if (k < idx) bold.add(k);
        else if (k >= idx + count) bold.add(k - count);
      }
      sl.bold = bold;
      for (const c of sl.chords) {
        if (c.col >= p + w && c.col < oldLen) c.col -= w;
        else if (c.col >= p && c.col < p + w) c.col = p;
      }
      sl.normalize();
    }

    splitLine(l, idx) {
      const sl = this.lines[l];
      const p = Text.textCells(sl.text, idx);
      const oldLen = Text.allCells(sl.text);
      const nl = new SheetLine(sl.text.slice(idx));
      sl.text = sl.text.slice(0, idx);
      for (const k of sl.bold) if (k >= idx) nl.bold.add(k - idx);
      sl.bold = new Set([...sl.bold].filter((k) => k < idx));
      sl.chords = sl.chords.filter((c) => {
        if (c.col >= p && c.col < oldLen) { nl.appendChord(c.col - p, c.name, c); return false; }
        return true;
      });
      nl.normalize();
      this.lines.splice(l + 1, 0, nl);
    }

    joinLines(l) {
      if (l + 1 >= this.lines.length) return;
      const a = this.lines[l], b = this.lines[l + 1];
      const lenA = Text.allCells(a.text);
      const nA = a.text.length;
      a.text += b.text;
      for (const k of b.bold) a.bold.add(k + nA);
      for (const c of b.chords) a.appendChord(c.col + lenA, c.name, c);
      a.normalize();
      this.lines.splice(l + 1, 1);
    }

    insertLyricText(u, kind) {
      if (!(this._mode === 'lyric' || this._mode === 'both')) return;
      const s = Text.cleanText(u, true);
      if (!s) return;
      this.beginChange(kind);
      const parts = s.split('\n');
      parts.forEach((part, k) => {
        if (k > 0) {
          this.splitLine(this.caretLine, this.caretIdx);
          this.caretLine++;
          this.caretIdx = 0;
        }
        this.insertLyric(part);
      });
      this.changed();
      this.setCaret(this.caretLine, this.caretIdx);
    }

    lyricKeyDown(e) {
      const sl = this.lines[this.caretLine];
      const t = sl.text;
      const ctrl = e.ctrlKey || e.metaKey;
      let i, n;
      switch (e.key) {
        case 'ArrowLeft':
          if (this.caretIdx > 0) {
            i = this.caretIdx - 1;
            if (i > 0 && Text.isLowSur(t.charCodeAt(i))) i--;
            this.moveCaret(this.caretLine, i);
          } else if (this.caretLine > 0) {
            this.moveCaret(this.caretLine - 1, this.lines[this.caretLine - 1].text.length);
          }
          return true;
        case 'ArrowRight':
          if (this.caretIdx < t.length) {
            i = this.caretIdx + 1;
            if (i < t.length && Text.isLowSur(t.charCodeAt(i))) i++;
            this.moveCaret(this.caretLine, i);
          } else if (this.caretLine < this.lines.length - 1) {
            this.moveCaret(this.caretLine + 1, 0);
          }
          return true;
        case 'ArrowUp':
          if (this.caretLine > 0) {
            this.moveCaret(this.caretLine - 1,
              this.idxFromCellF(this.caretLine - 1, Text.textCells(t, this.caretIdx)));
          }
          return true;
        case 'ArrowDown':
          if (this.caretLine < this.lines.length - 1) {
            this.moveCaret(this.caretLine + 1,
              this.idxFromCellF(this.caretLine + 1, Text.textCells(t, this.caretIdx)));
          }
          return true;
        case 'PageUp':
        case 'PageDown':
          n = Math.max(1, Math.floor(this.viewH / this.lineH) - 1);
          if (e.key === 'PageUp') n = -n;
          i = Math.max(0, Math.min(this.lines.length - 1, this.caretLine + n));
          this.moveCaret(i, this.idxFromCellF(i, Text.textCells(t, this.caretIdx)));
          return true;
        case 'Home':
          if (ctrl) this.moveCaret(0, 0); else this.moveCaret(this.caretLine, 0);
          return true;
        case 'End':
          if (ctrl) this.moveCaret(this.lines.length - 1, this.lines[this.lines.length - 1].text.length);
          else this.moveCaret(this.caretLine, t.length);
          return true;
        case 'Backspace':
          if (this.caretIdx > 0) {
            this.beginChange(UK_DELETE);
            i = this.caretIdx - 1;
            if (i > 0 && Text.isLowSur(t.charCodeAt(i))) i--;
            this.deleteLyric(this.caretLine, i, this.caretIdx - i);
            this.caretIdx = i;
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          } else if (this.caretLine > 0) {
            this.beginChange(UK_OTHER);
            i = this.lines[this.caretLine - 1].text.length;
            this.joinLines(this.caretLine - 1);
            this.caretLine--;
            this.caretIdx = i;
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          }
          return true;
        case 'Delete':
          if (this.caretIdx < t.length) {
            this.beginChange(UK_DELETE);
            n = 1;
            if (this.caretIdx + 1 < t.length && Text.isLowSur(t.charCodeAt(this.caretIdx + 1))) n = 2;
            this.deleteLyric(this.caretLine, this.caretIdx, n);
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          } else if (this.caretLine < this.lines.length - 1) {
            this.beginChange(UK_OTHER);
            this.joinLines(this.caretLine);
            this.changed();
            this.setCaret(this.caretLine, this.caretIdx);
          }
          return true;
        case 'Enter':
          this.beginChange(UK_OTHER);
          this.splitLine(this.caretLine, this.caretIdx);
          this.caretLine++;
          this.caretIdx = 0;
          this.changed();
          this.setCaret(this.caretLine, this.caretIdx);
          return true;
        default:
          return false;
      }
    }

    viewKeyDown(e) {
      const page = Math.max(this.lineH, this.viewH - this.lineH);
      switch (e.key) {
        case 'ArrowUp': this.scrollTo(this.topY - this.lineH, this.leftX); return true;
        case 'ArrowDown': this.scrollTo(this.topY + this.lineH, this.leftX); return true;
        case 'ArrowLeft': this.scrollTo(this.topY, this.leftX - this.cellW * 2); return true;
        case 'ArrowRight': this.scrollTo(this.topY, this.leftX + this.cellW * 2); return true;
        case 'PageUp': this.scrollTo(this.topY - page, this.leftX); return true;
        case 'PageDown': case ' ': this.scrollTo(this.topY + page, this.leftX); return true;
        case 'Home': this.scrollTo(0, 0); return true;
        case 'End': this.scrollTo(this.contentH, 0); return true;
        default: return false;
      }
    }

    // ---- コード編集 ----

    setTarget(l, c) {
      l = Math.max(0, Math.min(this.lines.length - 1 + MAX_VIRTUAL_LINES, l));
      c = Math.max(0, c);
      if (l === this.targetLine && c === this.targetCol) return;
      this.lastEntry = null;
      const oldHit = this.chordHit(this.targetLine, this.targetCol);
      const newHit = this.chordHit(l, c);
      if (l !== this.targetLine || oldHit !== newHit || newHit < 0) {
        this.lastPart = 'none';
        this.pendingBass = false;
      }
      this.targetLine = l;
      this.targetCol = c;
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    setChordName(l, idx, newName) {
      if (idx < 0 || l >= this.lines.length || idx >= this.lines[l].chords.length) return;
      if (this.lines[l].chords[idx].name === newName) return;
      this.beginChange(UK_OTHER);
      if (newName === '') this.lines[l].deleteChord(idx);
      else {
        // 名前が長くなったら後ろのコードを押し出す
        this.lines[l].chords[idx].name = newName;
        this.lines[l].normalize();
      }
      this.changed();
    }

    createChord(l, c, name) {
      if (!name || l < 0) return;
      if (l < this.lines.length && this.lines[l].findChordCol(c) >= 0) return;
      this.beginChange(UK_OTHER);
      this.ensureLines(l);
      this.lines[l].addChord(c, name);
      this.changed();
    }

    moveChordRaw(l, idx, nl, nc) {
      if (nl < 0 || nl >= this.lines.length + MAX_VIRTUAL_LINES || nc < 0) return false;
      if (idx < 0 || idx >= this.lines[l].chords.length) return false;
      const ch = this.lines[l].chords[idx];
      if (nl === l && nc === ch.col) return false;
      // 移動先で、ほかのコードとの間に空白 1 つが取れないときは動かさない（iPad のアプリ版と同じ）
      if (nl < this.lines.length) {
        const blocked = this.lines[nl].chords.some((o) => o !== ch &&
          (o.col <= nc ? o.col + o.name.length + 1 > nc : nc + ch.name.length + 1 > o.col));
        if (blocked) return false;
      }
      this.ensureLines(nl);
      this.lines[l].deleteChord(idx);
      this.lines[nl].addChord(nc, ch.name, ch);
      return true;
    }

    moveTargetChord(dLine, dCol) {
      const idx = this.chordHit(this.targetLine, this.targetCol);
      if (idx < 0) return false;
      const nl = this.targetLine + dLine;
      const nc = this.lines[this.targetLine].chords[idx].col + dCol;
      if (nl < 0 || nl > this.lines.length || nc < 0) return false;
      if (this.shiftRight && dLine === 0) {
        // 「右側も一緒に」：同じ行でそれより右のコードもまとめて動かす
        const line = this.lines[this.targetLine];
        if (!line.canShift(idx, dCol)) return false;
        this.beginChange(UK_MOVE);
        line.shiftChords(idx, dCol);
        this.targetCol = nc;
        this.changed();
        this.ensureVisible(this.targetLine, this.targetCol);
        return true;
      }
      this.beginChange(UK_MOVE);
      if (!this.moveChordRaw(this.targetLine, idx, nl, nc)) return false;
      this.targetLine = nl;
      this.targetCol = nc;
      this.changed();
      this.ensureVisible(this.targetLine, this.targetCol);
      return true;
    }

    // コード入力のキー 1 文字
    chordChar(ch) {
      let r = '', q = '', b = '', cname = '';
      const idx = this.chordHit(this.targetLine, this.targetCol);
      if (idx >= 0) {
        cname = this.lines[this.targetLine].chords[idx].name;
        const p = Chord.parseChord(cname);
        if (p.ok) { r = p.root; q = p.quality; b = p.bass; }
      }
      const L = this.targetLine;
      if (/^[A-Ga-g]$/.test(ch)) {
        // 基音（またはベース音）を入力した直後の小文字 b はフラット
        if (ch === 'b' && idx >= 0 && (this.lastPart === 'root' || this.lastPart === 'bass')) {
          if (this.lastPart === 'bass') b = Chord.toggleAccidental(b, 'b'); else r = Chord.toggleAccidental(r, 'b');
          this.setChordName(L, idx, Chord.buildChord(r, q, b));
          this.lastPart = 'none';
        } else if (this.pendingBass && idx >= 0 && r) {
          if (q.endsWith('/')) q = q.slice(0, -1);
          this.setChordName(L, idx, Chord.buildChord(r, q, ch.toUpperCase()));
          this.pendingBass = false;
          this.lastPart = 'bass';
        } else if (idx >= 0) {
          this.setChordName(L, idx, Chord.buildChord(ch.toUpperCase(), q, b));
          this.lastPart = 'root';
        } else {
          this.createChord(L, this.targetCol, ch.toUpperCase());
          this.lastPart = 'root';
        }
      } else if (ch === '#') {
        if (idx >= 0 && r) {
          if (this.lastPart === 'bass') b = Chord.toggleAccidental(b, '#'); else r = Chord.toggleAccidental(r, '#');
          this.setChordName(L, idx, Chord.buildChord(r, q, b));
        }
      } else if (ch === '/') {
        if (idx >= 0 && r) {
          if (b) {
            this.setChordName(L, idx, Chord.buildChord(r, q, ''));
            this.pendingBass = false;
          } else {
            this.pendingBass = !this.pendingBass;
          }
          this.lastPart = 'none';
        }
      } else if (ch === '|') {
        // 小節線は空いている位置にだけ置く（既存のコードの上では何もしない）
        if (idx < 0) this.createChord(L, this.targetCol, Chord.BAR_LINE);
        this.lastPart = 'none';
        this.pendingBass = false;
      } else if (ch === ' ') {
        this.lastPart = 'none';
        this.pendingBass = false;
      } else if (idx >= 0 && ch > ' ' && ch < '\x7F') {
        if (r) this.setChordName(L, idx, Chord.buildChord(r, q + ch, b));
        else this.setChordName(L, idx, cname + ch);
        this.lastPart = 'none';
        this.pendingBass = false;
      } else if (idx < 0 && /^[0-9]$/.test(ch)) {
        // 空いている位置では数字だけ直接入力できる（続けて打つと桁が続く）
        this.createChord(L, this.targetCol, ch);
        this.lastPart = 'none';
        this.pendingBass = false;
      }
      this.invalidate();
      this.doStatus();
    }

    // 自由文字入力：打った文字を入力位置にそのまま置く（入力位置の文字列があれば後ろに追記）。
    // 空白は文字列の区切りで、入力位置を今の文字列の後ろへ進める
    freeTextInput(s) {
      const idx = this.chordHit(this.targetLine, this.targetCol);
      if (s === ' ') {
        if (idx >= 0) {
          const c = this.lines[this.targetLine].chords[idx];
          this.setTarget(this.targetLine, c.col + this.chordCells(c.name) + 1);
        } else {
          this.setTarget(this.targetLine, this.targetCol + 1);
        }
        this.ensureVisible(this.targetLine, this.targetCol);
        return;
      }
      if (idx >= 0) this.setChordName(this.targetLine, idx, this.lines[this.targetLine].chords[idx].name + s);
      else this.createChord(this.targetLine, this.targetCol, s);
      this.updateImeAnchor();
      this.invalidate();
      this.doStatus();
    }

    // 自由文字を (l, c) に置く。入力位置の文字列は置き換え、空白で区切った語は順に後ろへ並べる
    placeFreeText(l, c, s) {
      if (l < 0) return;
      const words = Text.cleanText(s, false).split(' ');
      this.beginChange(UK_OTHER);
      const idx = this.chordHit(l, c);
      let col = c, attrs = null;
      if (idx >= 0) {
        attrs = this.lines[l].chords[idx];
        col = attrs.col;
        this.lines[l].deleteChord(idx);
      }
      for (const w of words) {
        if (w === '') { col++; continue; }
        this.ensureLines(l);
        this.lines[l].addChord(col, w, attrs);
        col += this.chordCells(w) + 1;
      }
      this.changed();
    }

    chordKeyDown(e) {
      let idx;
      switch (e.key) {
        case 'ArrowLeft':
          if (e.shiftKey) this.moveTargetChord(0, -1);
          else { this.setTarget(this.targetLine, this.targetCol - 1); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'ArrowRight':
          if (e.shiftKey) this.moveTargetChord(0, 1);
          else { this.setTarget(this.targetLine, this.targetCol + 1); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'ArrowUp':
          if (e.shiftKey) this.moveTargetChord(-1, 0);
          else { this.setTarget(this.targetLine - 1, this.targetCol); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'ArrowDown':
          if (e.shiftKey) this.moveTargetChord(1, 0);
          else { this.setTarget(this.targetLine + 1, this.targetCol); this.ensureVisible(this.targetLine, this.targetCol); }
          break;
        case 'Home':
          this.setTarget(this.targetLine, 0);
          this.ensureVisible(this.targetLine, this.targetCol);
          break;
        case 'Delete':
          idx = this.chordHit(this.targetLine, this.targetCol);
          if (idx >= 0) this.setChordName(this.targetLine, idx, '');
          this.lastPart = 'none';
          this.pendingBass = false;
          break;
        case 'Backspace':
          idx = this.chordHit(this.targetLine, this.targetCol);
          if (idx >= 0) {
            // 自由文字では日本語や絵文字も入るため、1 文字単位で消す
            const chars = [...this.lines[this.targetLine].chords[idx].name];
            chars.pop();
            this.setChordName(this.targetLine, idx, chars.join(''));
          }
          this.lastPart = 'none';
          this.pendingBass = false;
          break;
        case 'Enter':
          this.editChordDialog(this.targetLine, this.targetCol);
          break;
        case 'Escape':
          this.lastPart = 'none';
          this.pendingBass = false;
          break;
        case 'ContextMenu':
          this.showChordMenu(this.xOrigin() + this.targetCol * this.cellW, this.lineTop(this.targetLine) + this.chordH);
          break;
        default:
          return false;
      }
      this.invalidate();
      this.doStatus();
      return true;
    }

    async editChordDialog(l, c) {
      if (l < 0) return;
      const idx = this.chordHit(l, c);
      let s = idx >= 0 ? this.lines[l].chords[idx].name : '';
      if (this._freeText) {
        s = await UI.prompt('自由文字入力', '文字（例: サビ, ×2, rit.）　空白で区切ると後ろに並べます', s);
        if (s !== null) this.placeFreeText(l, c, s);
        this.focusEditor();
        return;
      }
      s = await UI.prompt('コード入力', 'コード名（例: Cm7, F#m7-5, G/B）', s);
      if (s !== null) {
        s = Chord.normalizeChordName(s);
        const i2 = this.chordHit(l, c);
        if (i2 >= 0) this.setChordName(l, i2, s); else this.createChord(l, c, s);
        this.lastPart = 'none';
        this.pendingBass = false;
      }
      this.focusEditor();
    }

    showChordMenu(x, y) {
      this.menuLine = this.targetLine;
      this.menuCol = this.targetCol;
      const r = this.scroller.getBoundingClientRect();
      UI.showMenu(this.buildChordMenu(), r.left + x, r.top + y, () => this.focusEditor());
    }

    buildChordMenu() {
      const L = this.menuLine, C = this.menuCol;
      const idx = this.chordHit(L, C);
      const name = idx >= 0 ? this.lines[L].chords[idx].name : '';
      const items = [];
      const header = (label) => items.push({ label, disabled: true, header: true }, '-');
      if (idx >= 0 && name === Chord.BAR_LINE) {
        // 小節線の上
        header('小節線  ' + Chord.BAR_LINE);
        items.push({ label: '小節線を削除', onClick: () => this.menuDelete() });
      } else if (idx >= 0 && Chord.REPEAT_MARKS.includes(name)) {
        header('繰り返し  ' + name);
        items.push({ label: '繰り返し記号を削除', onClick: () => this.menuDelete() });
      } else if (idx >= 0 && Chord.isNoteSymbol(name)) {
        // 音符の上：ほかの音符に変える
        header('音符  ' + name);
        items.push({
          label: '音符を変更',
          submenu: Chord.NOTE_SYMBOLS.map((n) => ({ label: n, checked: n === name, onClick: () => this.menuNote(n) })),
        }, '-', { label: '音符を削除', onClick: () => this.menuDelete() });
      } else if (idx >= 0) {
        const p = Chord.parseChord(name);
        const r = p.ok ? p.root : '', q = p.ok ? p.quality : '', b = p.ok ? p.bass : '';
        header('コード: ' + name);
        Chord.QUALITIES.slice(0, Chord.MAIN_QUALITY_COUNT).forEach((qq) => {
          items.push({
            label: (qq === '' ? 'メジャー' : qq) + '    (' + Chord.buildChord(r, qq, b) + ')',
            checked: !!r && q === qq, disabled: !r, onClick: () => this.menuQuality(qq),
          });
        });
        items.push({
          label: 'その他のコード', disabled: !r,
          submenu: Chord.QUALITIES.slice(Chord.MAIN_QUALITY_COUNT).map((qq) => ({
            label: qq + '    (' + Chord.buildChord(r, qq, b) + ')', checked: q === qq, onClick: () => this.menuQuality(qq),
          })),
        });
        items.push({ label: 'コード名を直接入力...', onClick: () => this.editChordDialog(L, C) }, '-');
        items.push({
          label: '基音',
          submenu: Chord.MENU_NOTES.map((n) => ({ label: n, checked: r === n, onClick: () => this.menuRoot(n) })),
        });
        items.push({
          label: 'ベース音（オンコード）', disabled: !r,
          submenu: [{ label: 'なし', checked: b === '', onClick: () => this.menuBass('') }, '-']
            .concat(Chord.MENU_NOTES.map((n) => ({ label: '/' + n, checked: b === n, onClick: () => this.menuBass(n) }))),
        });
        items.push('-', { label: 'コードを削除', onClick: () => this.menuDelete() });
      } else {
        // 何もない位置：基音を選ぶとその位置にコードが入る（種類は次の右クリックで選ぶ）
        header('基音を選択');
        Chord.MENU_NOTES.filter((n) => n.length === 1).forEach((n) => items.push({ label: n, onClick: () => this.menuRoot(n) }));
        items.push({
          label: '♯ / ♭',
          submenu: Chord.MENU_NOTES.filter((n) => n.length > 1).map((n) => ({ label: n, onClick: () => this.menuRoot(n) })),
        });
        items.push('-', { label: Chord.BAR_LINE + '  小節線', onClick: () => this.createChord(L, C, Chord.BAR_LINE) });
        for (const m of Chord.REPEAT_MARKS) items.push({ label: m, onClick: () => this.createChord(L, C, m) });
        items.push({
          label: '音符',
          submenu: Chord.NOTE_SYMBOLS.map((n) => ({ label: n, onClick: () => this.menuNote(n) })),
        }, '-');
        items.push({ label: this._freeText ? '文字を直接入力...' : 'コード名を直接入力...', onClick: () => this.editChordDialog(L, C) });
      }
      if (idx >= 0) this.addStyleMenu(items, L, idx);
      // 範囲（範囲コピー・貼り付け・点滅・色）。始まりは今の位置で、終わりはコード行をタップして決める
      items.push('-',
        { label: '範囲コピー...', onClick: () => this.startRange('copy') },
        { label: '貼り付け', disabled: !this.clip, onClick: () => this.pasteClip() },
        { label: '範囲を選んで点滅...', onClick: () => this.startRange('blink') },
        { label: '範囲を選んで色を付ける...', onClick: () => this.startRange('color') });
      items.push('-', { label: '自由文字入力 (Ctrl+Shift+F)', checked: this._freeText, onClick: () => { this.freeText = !this._freeText; } });
      return items;
    }

    // コード（小節線・音符・自由文字も）の点滅と色。この行のコードすべてにも当てられる
    addStyleMenu(items, L, idx) {
      const c = this.lines[L].chords[idx];
      const colorItems = (current, apply) => colorChoices().map((o) => ({
        label: o.label, color: o.css, checked: o.key ? current === o.key : isStandardColor(current), onClick: () => apply(o.key),
      }));
      items.push('-',
        { label: '点滅させる', checked: !!c.blink, onClick: () => this.setChordStyle(L, [idx], { blink: !c.blink }) },
        { label: '色', submenu: colorItems(c.color || '', (k) => this.setChordStyle(L, [idx], { color: k })) },
        {
          label: 'この行のコードすべて',
          submenu: [
            { label: '点滅させる', onClick: () => this.setChordStyle(L, null, { blink: true }) },
            { label: '点滅をやめる', onClick: () => this.setChordStyle(L, null, { blink: false }) },
            '-',
          ].concat(colorChoices().map((o) => ({
            label: '色: ' + o.label, color: o.css, onClick: () => this.setChordStyle(L, null, { color: o.key }),
          }))),
        });
    }

    // 行 l のコード（indices が null なら全部）の点滅・色を変える。style: { blink?: bool, color?: '' | 色の名前 }
    setChordStyle(l, indices, style) {
      const line = this.lines[l];
      if (!line) return;
      const targets = indices ? indices.map((i) => line.chords[i]).filter(Boolean) : line.chords;
      const differs = targets.some((c) => ('blink' in style && !!c.blink !== style.blink) ||
        ('color' in style && (c.color || '') !== style.color));
      if (!differs) return;
      this.beginChange(UK_OTHER);
      for (const c of targets) {
        if ('blink' in style) { if (style.blink) c.blink = true; else delete c.blink; }
        if ('color' in style) { if (style.color) c.color = style.color; else delete c.color; }
      }
      this.changed();
    }

    // 歌詞の太字：カーソルのある行をまるごと切り替える（全部太字なら太字をやめる）
    toggleBoldLine(l = this.caretLine) {
      const line = this.lines[l];
      if (!line || line.text.length === 0) return false;
      const all = [...Array(line.text.length).keys()];
      const allBold = all.every((k) => line.bold.has(k));
      this.beginChange(UK_OTHER);
      line.bold = allBold ? new Set() : new Set(all);
      this.changed();
      return true;
    }

    getStyle() {
      return Sheet.getStyle(this.lines);
    }

    menuQuality(q) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx < 0) return;
      const p = Chord.parseChord(this.lines[this.menuLine].chords[idx].name);
      if (!p.ok) return;
      this.setChordName(this.menuLine, idx, Chord.buildChord(p.root, q, p.bass));
    }

    menuRoot(note) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx < 0) {
        this.createChord(this.menuLine, this.menuCol, note);
      } else {
        const p = Chord.parseChord(this.lines[this.menuLine].chords[idx].name);
        this.setChordName(this.menuLine, idx, Chord.buildChord(note, p.ok ? p.quality : '', p.bass));
      }
    }

    menuBass(note) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx < 0) return;
      const p = Chord.parseChord(this.lines[this.menuLine].chords[idx].name);
      if (!p.ok) return;
      this.setChordName(this.menuLine, idx, Chord.buildChord(p.root, p.quality, note));
    }

    // 何もない位置なら音符を置き、音符の上ならその音符を変える
    menuNote(n) {
      const idx = this.chordHit(this.menuLine, this.menuCol);
      if (idx >= 0) this.setChordName(this.menuLine, idx, n);
      else this.createChord(this.menuLine, this.menuCol, n);
    }

    menuDelete() {
      this.setChordName(this.menuLine, this.chordHit(this.menuLine, this.menuCol), '');
    }

    // ---- コードパレット（iPad のアプリ版の下に出るパレット） ----

    /** 入力位置のコード（なければ null）と、その名前を分けたもの */
    targetChord() {
      const idx = this.chordHit(this.targetLine, this.targetCol);
      if (idx < 0) return null;
      const c = this.lines[this.targetLine].chords[idx];
      return { line: this.targetLine, index: idx, chord: c, parsed: Chord.parseChord(c.name) };
    }

    /** 「入力後に右へ」で進めた直後なら、直前に入れたコード */
    lastEntryChord() {
      const le = this.lastEntry;
      if (!le || this.chordHit(this.targetLine, this.targetCol) >= 0) return null;
      const line = this.lines[le.line];
      const idx = line ? line.findChordCol(le.col) : -1;
      return idx >= 0 ? { line: le.line, index: idx, chord: line.chords[idx], parsed: Chord.parseChord(line.chords[idx].name) } : null;
    }

    /**
     * パレットのボタン。op: root（基音）/ quality（種類）/ bass（ベース音。'' で外す）/ accidental（'#'・'b'）/
     * bar（小節線）/ mark（繰り返し記号）/ symbol（音符）/ rename（直接入力）/ delete。
     * 空いている位置に置いたときは「入力後に右へ」で入力位置を 1 桁空けた所へ進め、
     * 進めた直後の種類・♯♭・ベース・削除は直前に入れたコードに当てる（例: A → m → 7 で Am7）
     */
    paletteOp(op, arg) {
      if (this._mode === 'view') return;
      this.pendingBass = false;
      this.lastPart = 'none';
      const L = this.targetLine;
      let t = this.targetChord();
      let viaLast = false;
      if (!t && ['quality', 'bass', 'accidental', 'delete'].includes(op)) {
        t = this.lastEntryChord();
        viaLast = !!t;
      }
      const p = t ? t.parsed : null;
      let newName = null, place = null;
      switch (op) {
        case 'root':
          if (t) newName = p.ok ? Chord.buildChord(arg, p.quality, p.bass) : arg;
          else place = arg;
          break;
        case 'quality': if (p && p.ok) newName = Chord.buildChord(p.root, arg, p.bass); break;
        case 'bass': if (p && p.ok) newName = Chord.buildChord(p.root, p.quality, arg); break;
        case 'accidental': if (p && p.ok) newName = Chord.buildChord(Chord.toggleAccidental(p.root, arg), p.quality, p.bass); break;
        case 'bar': if (!t) place = Chord.BAR_LINE; break;
        case 'mark': if (!t) place = arg; break;
        case 'symbol': if (t) newName = arg; else place = arg; break;
        case 'rename': {
          const s = Chord.normalizeChordName(arg || '');
          if (t) newName = s; else if (s) place = s;
          break;
        }
        case 'delete': if (t) newName = ''; break;
        default: break;
      }
      if (t && newName !== null) {
        if (newName === t.chord.name) return;
        const le = this.lastEntry;
        this.setChordName(t.line, t.index, newName);
        if (viaLast) {
          if (newName === '') {
            // 直前のコードを消したら、入力位置をそこへ戻す
            this.setTarget(le.line, le.col);
          } else {
            // 名前の長さが変わった分だけ進め直す
            this.targetLine = le.line;
            this.targetCol = le.col + this.chordCells(newName) + 1;
            this.lastEntry = le;
            this.updateImeAnchor();
            this.invalidate();
            this.doStatus();
          }
        }
        return;
      }
      if (place) this.placeChord(L, this.targetCol, place);
    }

    // 空いている位置にコードを置く（前のコードのすぐ後ろなら空白 1 つ分右へずれる）。「入力後に右へ」なら入力位置を進める
    placeChord(l, c, name) {
      this.beginChange(UK_OTHER);
      this.ensureLines(l);
      const obj = { col: c, name };
      this.lines[l].chords.push(obj);
      this.lines[l].normalize();
      this.changed();
      if (this.autoAdvance) {
        this.setTarget(l, obj.col + this.chordCells(name) + 1);
        this.lastEntry = { line: l, col: obj.col };
      } else {
        this.setTarget(l, obj.col);
      }
      this.ensureVisible(this.targetLine, this.targetCol);
      this.doStatus();
    }

    /** パレットの自由文字の「置く」（入力位置の文字列を置き換え、空白で区切った語は後ろへ並べる） */
    paletteFreeText(s) {
      if (this._mode === 'view') return;
      this.placeFreeText(this.targetLine, this.targetCol, s);
    }

    /** 入力位置だけを 1 桁動かす（コードの上では、コードをひとまとまりとして飛び越す） */
    cursorStep(d) {
      const l = this.targetLine;
      let c = this.targetCol;
      const idx = this.chordHit(l, c);
      const chords = l < this.lines.length ? this.lines[l].chords : [];
      if (d > 0) {
        c = idx >= 0 ? chords[idx].col + this.chordCells(chords[idx].name) : c + 1;
      } else {
        c = (idx >= 0 ? chords[idx].col : c) - 1;
        const h = this.chordHit(l, c);
        if (h >= 0) c = chords[h].col;
      }
      this.setTarget(l, Math.max(0, c));
      this.ensureVisible(this.targetLine, this.targetCol);
      this.doStatus();
    }

    /** コードがあればそのコードを 1 桁動かし（「右側も一緒に」なら右側も）、なければ入力位置を動かす */
    moveStep(d) {
      if (this.chordHit(this.targetLine, this.targetCol) >= 0) {
        this.moveTargetChord(0, d);
        this.invalidate();
        this.doStatus();
      } else {
        this.cursorStep(d);
      }
    }

    /** 行をまたいで、読む順に前・次のコードへ */
    jumpChord(d) {
      const all = [];
      this.lines.forEach((l, i) => l.chords.forEach((c) => all.push({ line: i, col: c.col })));
      const idx = this.chordHit(this.targetLine, this.targetCol);
      const cur = { line: this.targetLine, col: idx >= 0 ? this.lines[this.targetLine].chords[idx].col : this.targetCol };
      const cmp = (a, b) => (a.line - b.line) || (a.col - b.col);
      const next = d > 0 ? all.find((p) => cmp(p, cur) > 0) : all.reverse().find((p) => cmp(p, cur) < 0);
      if (!next) return;
      this.setTarget(next.line, next.col);
      this.ensureVisible(this.targetLine, this.targetCol);
      this.doStatus();
    }

    // ---- 範囲選択（範囲コピー・点滅・色。iPad のアプリ版と同じ） ----

    /** 範囲選択を始める（いまの入力位置が始まり。purpose: 'copy' / 'blink' / 'color'） */
    startRange(purpose) {
      if (this._mode === 'view') return;
      const idx = this.chordHit(this.targetLine, this.targetCol);
      const col = idx >= 0 ? this.lines[this.targetLine].chords[idx].col : this.targetCol;
      this.range = { purpose, byLine: false, start: { line: this.targetLine, col }, end: null };
      this.rangeChanged();
    }

    cancelRange() {
      if (!this.range) return;
      this.range = null;
      this.rangeChanged();
    }

    /** 「自由に選ぶ」と「行で選ぶ」を切り替える */
    setRangeByLine(v) {
      const r = this.range;
      if (!r || r.byLine === !!v) return;
      r.byLine = !!v;
      if (r.byLine) {
        if (r.end) r.end = { line: r.end.line, col: 0 };
      } else {
        // 自由に選ぶに戻すと、始まりの行の先頭から選び直す
        r.start = { line: r.start.line, col: 0 };
        r.end = null;
      }
      this.rangeChanged();
    }

    /** 範囲の終わり（自由に選ぶ：コードの上ならそのコードの始まり、行で選ぶ：その行） */
    setRangeEnd(l, c) {
      const r = this.range;
      if (!r) return;
      if (r.byLine) {
        r.end = { line: l, col: 0 };
      } else {
        const idx = this.chordHit(l, c);
        r.end = { line: l, col: idx >= 0 ? this.lines[l].chords[idx].col : c };
      }
      this.rangeChanged();
    }

    rangeChanged() {
      this.invalidate();
      if (this.onRangeChange) this.onRangeChange(this);
      this.doStatus();
    }

    /** 範囲の対象のコード [{ line, index }]（終わりが決まる前は、行で選ぶなら始まりの行、自由に選ぶなら始まりのコード） */
    rangeTargets() {
      const r = this.range;
      if (!r) return [];
      if (!r.end && !r.byLine) {
        const l = r.start.line;
        const idx = l < this.lines.length ? this.lines[l].findChordCol(r.start.col) : -1;
        return idx >= 0 ? [{ line: l, index: idx }] : [];
      }
      return Sheet.chordsInRange(this.lines, r.start, r.end || r.start, r.byLine);
    }

    /** 範囲の操作を実行して範囲選択を終える。action: 'copy' / 'blink'（arg: 点けるか）/ 'color'（arg: 色の名前）。戻り値はコードの数 */
    applyRange(action, arg) {
      const r = this.range;
      if (!r) return 0;
      const targets = this.rangeTargets();
      if (!targets.length) return 0;
      if (action === 'copy') {
        this.clip = Sheet.copyChords(this.lines, r.start, r.end || r.start, r.byLine);
      } else {
        const style = action === 'blink' ? { blink: !!arg } : { color: arg || '' };
        this.beginChange(UK_OTHER);
        for (const t of targets) {
          const c = this.lines[t.line].chords[t.index];
          if ('blink' in style) { if (style.blink) c.blink = true; else delete c.blink; }
          if ('color' in style) { if (style.color) c.color = style.color; else delete c.color; }
        }
        this.changed();
      }
      this.cancelRange();
      return targets.length;
    }

    /** 範囲コピーで写したコードを入力位置に貼り付ける。戻り値は貼ったコードの数 */
    pasteClip() {
      if (!this.clip || this._mode === 'view') return 0;
      this.beginChange(UK_OTHER);
      Sheet.pasteChords(this.lines, this.clip, this.targetLine, this.targetCol);
      this.changed();
      return this.clip.rows.reduce((n, row) => n + row.chords.length, 0);
    }

    // ---- 行の操作 ----

    /** 今の行（歌詞の入力中はカーソルの行、コードの入力中は入力位置の行） */
    currentLine() {
      return this.chordKeyActive() ? Math.min(this.targetLine, this.lines.length - 1) : this.caretLine;
    }

    /** 空の行を今の行の上（below なら下）に入れる */
    insertLine(below) {
      if (this._mode === 'view') return;
      const at = this.currentLine() + (below ? 1 : 0);
      this.beginChange(UK_OTHER);
      this.lines.splice(at, 0, new SheetLine());
      this.changed();
      this.setCaret(at, 0);
      if (this.chordKeyActive()) this.setTarget(at, this.targetCol);
    }

    /** 今の行を消す（行がなくなったら空の 1 行にする） */
    deleteLine() {
      if (this._mode === 'view') return;
      const at = this.currentLine();
      this.beginChange(UK_OTHER);
      this.lines.splice(at, 1);
      if (!this.lines.length) this.lines.push(new SheetLine());
      this.changed();
      this.setCaret(Math.min(at, this.lines.length - 1), 0);
    }

    // ---- 文書 ----

    newDocument() {
      this.setSheetText('');
    }

    getSheetText(withHeader) {
      return Sheet.getSheetText(this.lines, withHeader);
    }

    // 今の曲の中身をまるごと置き換える（「元に戻す」で戻せる。コード譜の貼り付けで使う）
    replaceAll(s) {
      this.beginChange(UK_OTHER);
      this.lines = Sheet.parseSheetText(s);
      this.clampPositions();
      this.changed();
    }

    // style: 曲の一覧に持っている飾り（点滅・コードの色・歌詞の太字）
    setSheetText(s, style) {
      this.lines = Sheet.parseSheetText(s);
      Sheet.applyStyle(this.lines, style);
      this.resetAfterLoad();
    }

    assignLines(lines) {
      this.lines = lines.length ? lines : [new SheetLine()];
      for (const l of this.lines) l.normalize();
      this.resetAfterLoad();
    }

    resetAfterLoad() {
      this.caretLine = 0; this.caretIdx = 0; this.targetLine = 0; this.targetCol = 0;
      this.undoStack = []; this.redoStack = []; this.lastUndoKind = UK_NONE;
      this.pendingBass = false; this.lastPart = 'none';
      this.shiftRight = false; this.lastEntry = null; this.clip = null; this.paletteDismissed = false;
      this.cancelRange();
      this.clampPositions();
      this.updateContentSize();
      this.scrollTo(0, 0);
      this.updateImeAnchor();
      this.invalidate();
      this.modified = false;
      if (this.onChange) this.onChange(this);
      this.doStatus();
    }

    pasteText(text) {
      if ((this._mode === 'lyric' || this._mode === 'both') && text) this.insertLyricText(text, UK_OTHER);
    }

    // 閲覧中（演奏中）でも移調できる（iPad のアプリ版と同じ）。名前が長くなったら後ろのコードを押し出す
    transposeAll(steps) {
      this.beginChange(UK_OTHER);
      for (const l of this.lines) {
        for (const c of l.chords) c.name = Chord.transposeChord(c.name, steps);
        l.normalize();
      }
      this.changed();
    }

    // 文字化けした行（UTF-8 を Shift-JIS などとして読んだもの）を元の文字に戻す。
    // apply = false なら数えるだけ。count は修復できる行数、preview は修復後の先頭数行
    repairGarbledText(apply) {
      let count = 0, started = false;
      const preview = [];
      for (const l of this.lines) {
        let fixed = false;
        const r = Text.repairMojibake(Text.fixSurrogates(l.text));
        if (r !== null) {
          fixed = true;
          if (preview.length < 8) preview.push(r);
          if (apply) {
            if (!started) this.beginChange(UK_OTHER);
            started = true;
            l.text = Text.cleanText(r, false);
          }
        }
        // 自由文字など、コード行の文字列も同じように修復する
        for (const c of l.chords) {
          const rc = Text.repairMojibake(c.name);
          if (rc !== null) {
            fixed = true;
            if (apply) {
              if (!started) this.beginChange(UK_OTHER);
              started = true;
              c.name = rc;
            }
          }
        }
        if (fixed) count++;
      }
      if (started) this.changed();
      return { count, preview: preview.join('\n') };
    }
  }

  Editor.colorChoices = colorChoices;
  Editor.isStandardColor = isStandardColor;
  LC.Editor = Editor;
  LC.DEFAULT_FONT_SIZE = DEFAULT_FONT_SIZE;
})(window.LC = window.LC || {});
