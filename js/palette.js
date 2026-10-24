/* コードパレットと範囲選択のバー（iPad のアプリ版の、コード行を選んだときに下に出るパレットに相当する）。
   指で操作するとき（iPad など）は、画面のキーボードを出さずにこのパレットでコードを入れる */
(function (LC) {
  'use strict';

  const { Chord, UI, Editor } = LC;

  const PURPOSE_VERB = { copy: 'をコピーし', blink: 'の点滅を切り替え', color: 'の色を変え' };
  const PURPOSE_LINE_VERB = { copy: 'コピーする', blink: '点滅を切り替える', color: '色を変える' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function button(cls, text, action, title) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (action) b.dataset.a = action;
    if (title) b.title = title;
    return b;
  }

  class ChordPalette {
    /**
     * editor: エディタ、panel: パレットを入れる要素、rangeBar: 範囲選択のバーを入れる要素、
     * opts: { toast(文字), editChord() 直接入力のダイアログ, changed() 設定が変わったとき }
     */
    constructor(editor, panel, rangeBar, opts) {
      this.editor = editor;
      this.panel = panel;
      this.rangeBar = rangeBar;
      this.opts = opts;
      this.enabled = false;
      this.freeKey = '';
      this.build();
      this.buildRangeBar();
    }

    // ---- パレット ----

    build() {
      const p = this.panel;
      p.textContent = '';
      // 見出し：コード名（空き）・行・入力後に右へ・カーソル・コードを動かす・前後のコード・閉じる
      const head = el('div', 'cp-head');
      this.nameEl = el('span', 'cp-name');
      this.lineEl = el('span', 'cp-line');
      this.advance = this.check('入力後に右へ', 'advance');
      const cursor = el('div', 'cp-grp');
      cursor.append(el('span', 'cp-cap', 'カーソル'), this.pair(button('cp-arrow', '‹', 'cur-1', '入力位置を左へ'), button('cp-arrow', '›', 'cur1', '入力位置を右へ')));
      const move = el('div', 'cp-grp');
      this.shift = this.check('右側も一緒に', 'shift', 'small');
      move.append(this.pair(button('cp-arrow', '←', 'mv-1', 'コードを左へ動かす'), button('cp-arrow', '→', 'mv1', 'コードを右へ動かす')), this.shift.label);
      const jump = el('div', 'cp-grp');
      jump.append(el('span', 'cp-cap', '前後のコード'), this.pair(button('cp-arrow', '⏮', 'jmp-1', '前のコード'), button('cp-arrow', '⏭', 'jmp1', '次のコード')));
      head.append(this.nameEl, this.lineEl, el('span', 'cp-spacer'), this.advance.label, cursor, move, jump,
        button('cp-close', '✕', 'close', '閉じる'));

      // 基音（C～B と ♯ ♭）
      this.roots = el('div', 'cp-roots');
      for (const n of ['C', 'D', 'E', 'F', 'G', 'A', 'B']) {
        const b = button('cp-root', n);
        b.dataset.root = n;
        this.roots.appendChild(b);
      }
      this.sharp = button('cp-root', '♯', 'acc#', 'シャープを付ける・外す');
      this.flat = button('cp-root', '♭', 'accb', 'フラットを付ける・外す');
      this.roots.append(this.sharp, this.flat);

      // 種類（横にスクロール）
      this.quals = el('div', 'cp-quals');
      for (const q of Chord.QUALITIES) {
        const b = button('cp-qual', q === '' ? 'メジャー' : q);
        b.dataset.q = q;
        this.quals.appendChild(b);
      }

      // 自由文字の入力欄（自由文字入力のときだけ、基音と種類の代わりに出す）
      this.free = el('div', 'cp-free');
      this.freeInput = el('input');
      this.freeInput.type = 'text';
      this.freeInput.placeholder = '文字を入力（例: サビ ×2 rit.）';
      this.freeInput.enterKeyHint = 'done';
      this.freeInput.autocomplete = 'off';
      this.freeInput.spellcheck = false;
      this.free.append(this.freeInput, button('primary', '置く', 'put'));
      this.freeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); this.putFree(); }
      });

      // その他（横にスクロール。右端に削除）
      const others = el('div', 'cp-others');
      this.freeBtn = button('cp-tool', '自由文字', 'free', 'コード行に文字をそのまま置く');
      this.noteBtn = button('cp-tool', '音符 ▾', 'note');
      this.barBtn = button('cp-tool', '｜小節線', 'bar');
      this.markBtns = Chord.REPEAT_MARKS.map((m) => { const b = button('cp-tool mono', m, 'mark'); b.dataset.mark = m; return b; });
      this.copyBtn = button('cp-tool', '範囲コピー', 'copy');
      this.pasteBtn = button('cp-tool', '貼り付け', 'paste');
      this.blinkBtn = button('cp-tool', '点滅', 'blink');
      this.colorBtn = button('cp-tool', '色 ▾', 'color');
      this.bassBtn = button('cp-tool', 'ベース ▾', 'bass');
      this.renameBtn = button('cp-tool', '直接入力', 'rename');
      this.delBtn = button('cp-tool danger', '削除', 'delete');
      const scroll = el('div', 'cp-scroll');
      scroll.append(this.freeBtn, this.noteBtn, this.barBtn, ...this.markBtns, this.copyBtn, this.pasteBtn, this.blinkBtn,
        this.colorBtn, this.bassBtn, this.renameBtn);
      others.append(scroll, this.delBtn);

      p.append(head, this.roots, this.quals, this.free, others);
      // ボタンを押しても、エディタからフォーカスを外さない（キーボードでの入力も続けられる）
      p.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) e.preventDefault();
      });
      p.addEventListener('click', (e) => this.onClick(e));
    }

    check(text, key, cls) {
      const label = el('label', 'cp-check' + (cls ? ' ' + cls : ''));
      const input = el('input');
      input.type = 'checkbox';
      label.append(input, document.createTextNode(text));
      input.addEventListener('change', () => this.onCheck(key, input.checked));
      // チェックを切り替えても、エディタからフォーカスを外さない
      label.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        input.checked = !input.checked;
        this.onCheck(key, input.checked);
      });
      label.addEventListener('click', (e) => e.preventDefault());
      return { label, input };
    }

    pair(a, b) {
      const d = el('div', 'cp-pair');
      d.append(a, b);
      return d;
    }

    onCheck(key, v) {
      const ed = this.editor;
      if (key === 'advance') { ed.autoAdvance = v; ed.lastEntry = null; this.opts.changed(); }
      if (key === 'shift') ed.shiftRight = v;
      this.refresh();
    }

    onClick(e) {
      const ed = this.editor;
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      if (b.dataset.root) { ed.paletteOp('root', b.dataset.root); return this.after(); }
      if (b.dataset.q !== undefined) { ed.paletteOp('quality', b.dataset.q); return this.after(); }
      const a = b.dataset.a;
      switch (a) {
        case 'cur-1': case 'cur1': ed.cursorStep(a === 'cur1' ? 1 : -1); break;
        case 'mv-1': case 'mv1': ed.moveStep(a === 'mv1' ? 1 : -1); break;
        case 'jmp-1': case 'jmp1': ed.jumpChord(a === 'jmp1' ? 1 : -1); break;
        case 'close':
          ed.paletteDismissed = true;
          ed.lastEntry = null;
          break;
        case 'acc#': ed.paletteOp('accidental', '#'); break;
        case 'accb': ed.paletteOp('accidental', 'b'); break;
        case 'put': this.putFree(); return;
        case 'free': ed.freeText = !ed.freeText; this.opts.changed(); break;
        case 'note': this.noteMenu(b); return;
        case 'bar': ed.paletteOp('bar'); break;
        case 'mark': ed.paletteOp('mark', b.dataset.mark); break;
        case 'copy': ed.startRange('copy'); break;
        case 'paste':
          if (ed.clip) {
            ed.pasteClip();
            this.opts.toast('貼り付けました');
          }
          break;
        case 'blink': ed.startRange('blink'); break;
        case 'color': this.colorMenu(b); return;
        case 'bass': this.bassMenu(b); return;
        case 'rename': this.opts.editChord(); return;
        case 'delete': ed.paletteOp('delete'); break;
        default: return;
      }
      this.after();
    }

    after() {
      this.refresh();
    }

    putFree() {
      this.editor.paletteFreeText(this.freeInput.value);
      // 置いたら自由文字入力をやめる（iPad のアプリ版と同じ）
      this.editor.freeText = false;
      this.freeKey = '';
      this.opts.changed();
      this.editor.focusEditor();
      this.refresh();
    }

    showMenu(btn, items) {
      const r = btn.getBoundingClientRect();
      UI.showMenu(items, r.left, r.top, () => { this.editor.focusEditor(); this.refresh(); });
    }

    noteMenu(btn) {
      const t = this.editor.targetChord();
      this.showMenu(btn, Chord.NOTE_SYMBOLS.map((n) => ({
        label: n, checked: !!t && t.chord.name === n, onClick: () => this.editor.paletteOp('symbol', n),
      })));
    }

    colorMenu(btn) {
      const ed = this.editor;
      const t = ed.targetChord();
      const cur = t ? t.chord.color || '' : null;
      const items = Editor.colorChoices().map((o) => ({
        label: '● ' + o.label, color: o.css, disabled: !t,
        checked: !!t && (o.key ? cur === o.key : Editor.isStandardColor(cur)),
        onClick: () => ed.setChordStyle(t.line, [t.index], { color: o.key }),
      }));
      items.push('-', { label: '範囲を選んで色を付ける…', onClick: () => ed.startRange('color') });
      this.showMenu(btn, items);
    }

    bassMenu(btn) {
      const t = this.editor.targetChord() || this.editor.lastEntryChord();
      const bass = t && t.parsed.ok ? t.parsed.bass : '';
      this.showMenu(btn, [{ label: 'なし', checked: !bass, onClick: () => this.editor.paletteOp('bass', '') }, '-']
        .concat(Chord.MENU_NOTES.map((n) => ({ label: '/' + n, checked: bass === n, onClick: () => this.editor.paletteOp('bass', n) }))));
    }

    /** パレットを出すか */
    get shown() {
      const ed = this.editor;
      return this.enabled && ed.mode !== 'view' && !ed.range && !ed.paletteDismissed && ed.chordTargetShown();
    }

    refresh() {
      const ed = this.editor;
      const show = this.shown;
      if (this.panel.hidden === show) this.panel.hidden = !show;
      // パレットを出している間は、マウスがパレットへ移っても入力位置を保つ
      ed.holdTarget = show;
      this.refreshRangeBar();
      if (!show) return;
      const t = ed.targetChord();
      const last = t ? null : ed.lastEntryChord();
      const mod = t || last;
      const ok = !!mod && mod.parsed.ok;

      this.nameEl.textContent = '';
      if (t) {
        const s = el('span', 'cp-chord', t.chord.name);
        s.style.color = Editor.colorChoices().find((o) => o.key && o.key === t.chord.color)?.css || '';
        this.nameEl.appendChild(s);
      } else {
        this.nameEl.appendChild(el('span', 'cp-empty', '空き'));
        if (last) this.nameEl.appendChild(el('span', 'cp-last', '← ' + last.chord.name));
      }
      this.lineEl.textContent = `${ed.targetLine + 1} 行目`;
      this.advance.input.checked = ed.autoAdvance;
      this.shift.input.checked = ed.shiftRight;
      this.shift.label.classList.toggle('on', ed.shiftRight);

      const free = ed.freeText;
      this.roots.hidden = free;
      this.quals.hidden = free;
      this.free.hidden = !free;
      this.freeBtn.classList.toggle('on', free);
      this.bassBtn.hidden = free;
      this.renameBtn.hidden = free;
      if (free) {
        // 入力位置が変わったら、入力欄をその位置の文字列にする
        const key = ed.targetLine + ':' + ed.targetCol;
        if (key !== this.freeKey) {
          this.freeKey = key;
          this.freeInput.value = t ? t.chord.name : '';
        }
      } else {
        this.freeKey = '';
        const root = t && t.parsed.ok ? t.parsed.root[0] : '';
        this.roots.querySelectorAll('[data-root]').forEach((b) => b.classList.toggle('cur', b.dataset.root === root));
        const acc = mod && mod.parsed.ok ? mod.parsed.root.slice(1) : '';
        this.sharp.disabled = !ok;
        this.flat.disabled = !ok;
        this.sharp.classList.toggle('cur', acc === '#');
        this.flat.classList.toggle('cur', acc === 'b');
        this.quals.classList.toggle('off', !ok);
        const q = ok ? mod.parsed.quality : null;
        this.quals.querySelectorAll('button').forEach((b) => {
          b.disabled = !ok;
          b.classList.toggle('cur', ok && b.dataset.q === q);
        });
        this.bassBtn.disabled = !ok;
        this.bassBtn.textContent = ok && mod.parsed.bass ? '/' + mod.parsed.bass + ' ▾' : 'ベース ▾';
      }
      this.barBtn.disabled = !!t;
      this.markBtns.forEach((b) => { b.disabled = !!t; });
      this.pasteBtn.disabled = !ed.clip;
      this.colorBtn.disabled = false;
      this.delBtn.disabled = !mod;
    }

    // ---- 範囲選択のバー ----

    buildRangeBar() {
      const r = this.rangeBar;
      r.textContent = '';
      const seg = el('div', 'seg');
      this.segFree = button('', '自由に選ぶ', 'free');
      this.segLine = button('', '行で選ぶ', 'line');
      seg.append(this.segFree, this.segLine);
      this.rangeInfo = el('span', 'range-info');
      this.rangeActions = el('div', 'range-actions');
      const row = el('div', 'range-row');
      row.append(seg, el('span', 'cp-spacer'), button('', 'キャンセル', 'cancel'), this.rangeActions);
      r.append(row, this.rangeInfo);
      r.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) e.preventDefault();
      });
      r.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b || b.disabled) return;
        const ed = this.editor;
        const a = b.dataset.a;
        if (a === 'free' || a === 'line') { ed.setRangeByLine(a === 'line'); return; }
        if (a === 'cancel') { ed.cancelRange(); return; }
        const n = ed.rangeTargets().length;
        if (a === 'copy') {
          ed.applyRange('copy');
          this.opts.toast(`コード ${n} 個をコピーしました。貼り付け先をタップして「貼り付け」を押します`);
        } else if (a === 'blink-on' || a === 'blink-off') {
          ed.applyRange('blink', a === 'blink-on');
          this.opts.toast(a === 'blink-on' ? `コード ${n} 個を点滅させます` : `コード ${n} 個の点滅をやめました`);
        } else if (b.dataset.color !== undefined) {
          ed.applyRange('color', b.dataset.color);
          this.opts.toast(`コード ${n} 個を${b.title}にしました`);
        }
        ed.focusEditor();
      });
    }

    refreshRangeBar() {
      const r = this.editor.range;
      this.rangeBar.hidden = !r;
      if (!r) { this.rangeKey = ''; return; }
      this.segFree.classList.toggle('cur', !r.byLine);
      this.segLine.classList.toggle('cur', r.byLine);
      const n = this.editor.rangeTargets().length;
      // 操作のボタン（目的が変わったときだけ作り直す）
      if (this.rangeKey !== r.purpose) {
        this.rangeKey = r.purpose;
        this.rangeActions.textContent = '';
        if (r.purpose === 'copy') {
          this.rangeActions.appendChild(button('primary', 'コピー', 'copy'));
        } else if (r.purpose === 'blink') {
          this.rangeActions.append(button('', '点滅をやめる', 'blink-off'), button('primary', '点滅させる', 'blink-on'));
        } else {
          for (const o of Editor.colorChoices()) {
            const b = button('swatch', '', '', o.label);
            b.dataset.color = o.key;
            b.style.background = o.css;
            this.rangeActions.appendChild(b);
          }
        }
      }
      // 終わりが決まっていない（コピー以外は始まりの 1 個だけでもよい）か、対象が 0 個のときは押せない
      const ready = n > 0 && (r.purpose !== 'copy' || !!r.end || r.byLine);
      this.rangeActions.querySelectorAll('button').forEach((b) => { b.disabled = !ready; });
      this.rangeInfo.textContent = this.rangeMessage(r, n);
    }

    rangeMessage(r, n) {
      const verb = PURPOSE_VERB[r.purpose];
      if (r.byLine) {
        const a = Math.min(r.start.line, (r.end || r.start).line) + 1;
        const b = Math.max(r.start.line, (r.end || r.start).line) + 1;
        if (a === b) {
          return `${a} 行目のコード ${n} 個。続けて${PURPOSE_LINE_VERB[r.purpose]}最後の行をタップすると、行をまとめて選べます`;
        }
        return `${a}〜${b} 行目のコード ${n} 個${verb}ます`;
      }
      if (!r.end) {
        if (r.purpose === 'copy') return `コピーの終わりの位置（コード行）をタップしてください（始まり: ${r.start.line + 1} 行目）`;
        return `始まりのコード ${n} 個${verb}ます。範囲にするときは終わりの位置（コード行）をタップします`;
      }
      return `選んだ範囲のコード ${n} 個${verb}ます。終わりを変えるときはタップし直します`;
    }
  }

  LC.ChordPalette = ChordPalette;
})(window.LC = window.LC || {});
