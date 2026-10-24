/* 画面部品：ポップアップメニュー（サブメニュー付き）とダイアログ（入力・確認・お知らせ） */
(function (LC) {
  'use strict';

  // ---- ポップアップメニュー ----
  // items: [{ label, onClick, checked, disabled, submenu: [...] } | '-']

  let openMenus = [];
  let restoreFocus = null;

  function closeMenus() {
    openMenus.forEach((m) => m.remove());
    openMenus = [];
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
    if (restoreFocus) {
      const f = restoreFocus;
      restoreFocus = null;
      f();
    }
  }

  function onOutside(e) {
    if (!openMenus.some((m) => m.contains(e.target))) closeMenus();
  }

  function itemsOf(menu) {
    return [...menu.querySelectorAll(':scope > .mi:not(.disabled)')];
  }

  function onMenuKey(e) {
    const menu = openMenus[openMenus.length - 1];
    if (!menu) return;
    const items = itemsOf(menu);
    let i = items.indexOf(menu.querySelector(':scope > .mi.active'));
    const setActive = (k) => {
      items.forEach((el) => el.classList.remove('active'));
      if (items[k]) items[k].classList.add('active');
    };
    switch (e.key) {
      case 'Escape':
        if (openMenus.length > 1) openMenus.pop().remove(); else closeMenus();
        break;
      case 'ArrowDown': setActive((i + 1) % items.length); break;
      case 'ArrowUp': setActive((i - 1 + items.length) % items.length); break;
      case 'ArrowRight':
      case 'Enter':
      case ' ':
        if (items[i]) items[i].dispatchEvent(new Event('activate'));
        break;
      case 'ArrowLeft':
        if (openMenus.length > 1) openMenus.pop().remove();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function place(menu, x, y) {
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (x + r.width > vw - 4) x = Math.max(4, vw - r.width - 4);
    if (y + r.height > vh - 4) y = Math.max(4, vh - r.height - 4);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  function buildMenu(items, level) {
    const menu = document.createElement('div');
    menu.className = 'popup-menu';
    menu.setAttribute('role', 'menu');
    for (const it of items) {
      if (it === '-') {
        const sep = document.createElement('div');
        sep.className = 'sep';
        menu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'mi' + (it.disabled ? ' disabled' : '') + (it.header ? ' header' : '');
      el.setAttribute('role', 'menuitem');
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = it.checked ? '✓' : '';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = it.label;
      el.append(check, label);
      if (it.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'shortcut';
        sc.textContent = it.shortcut;
        el.appendChild(sc);
      }
      if (it.submenu) {
        const arrow = document.createElement('span');
        arrow.className = 'arrow';
        arrow.textContent = '▶';
        el.appendChild(arrow);
      }
      const openSub = () => {
        while (openMenus.length > level + 1) openMenus.pop().remove();
        const sub = buildMenu(it.submenu, level + 1);
        const r = el.getBoundingClientRect();
        openMenus.push(sub);
        place(sub, r.right - 2, r.top - 4);
        if (r.right - 2 + sub.offsetWidth > window.innerWidth - 4) {
          sub.style.left = Math.max(4, r.left - sub.offsetWidth + 2) + 'px';
        }
      };
      const activate = () => {
        if (it.disabled) return;
        if (it.submenu) { openSub(); return; }
        closeMenus();
        if (it.onClick) it.onClick();
      };
      el.addEventListener('activate', activate);
      el.addEventListener('click', (e) => { e.stopPropagation(); activate(); });
      el.addEventListener('pointerenter', (e) => {
        if (e.pointerType !== 'mouse' || it.disabled) return;
        menu.querySelectorAll(':scope > .mi').forEach((m) => m.classList.remove('active'));
        el.classList.add('active');
        if (it.submenu) openSub();
        else while (openMenus.length > level + 1) openMenus.pop().remove();
      });
      menu.appendChild(el);
    }
    return menu;
  }

  // clientX, clientY の位置にメニューを出す。onClose はメニューを閉じた後に呼ぶ
  function showMenu(items, x, y, onClose) {
    closeMenus();
    const menu = buildMenu(items, 0);
    openMenus.push(menu);
    place(menu, x, y);
    restoreFocus = onClose || null;
    setTimeout(() => {
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onMenuKey, true);
    }, 0);
  }

  const isMenuOpen = () => openMenus.length > 0;

  // ---- ダイアログ ----

  // ダイアログを作る。finish(結果) で閉じて resolve(結果) を呼ぶ。Esc は cancelValue で閉じる
  // （close イベントは環境によって遅れたり届かなかったりするため、閉じる処理は自分で行う）
  function makeDialog(title, resolve, cancelValue) {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg';
    const h = document.createElement('div');
    h.className = 'dlg-title';
    h.textContent = title;
    const body = document.createElement('div');
    body.className = 'dlg-body';
    const buttons = document.createElement('div');
    buttons.className = 'dlg-buttons';
    dlg.append(h, body, buttons);
    document.body.appendChild(dlg);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
      resolve(value);
    };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(cancelValue); });
    dlg.addEventListener('close', () => finish(cancelValue));
    return { dlg, body, buttons, finish };
  }

  function addButton(parent, label, primary, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  // 文字列の入力。キャンセルなら null
  function prompt(title, label, value) {
    return new Promise((resolve) => {
      const { dlg, body, buttons, finish } = makeDialog(title, resolve, null);
      const lbl = document.createElement('label');
      lbl.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value || '';
      input.autocomplete = 'off';
      input.spellcheck = false;
      lbl.appendChild(input);
      body.appendChild(lbl);
      addButton(buttons, 'キャンセル', false, () => finish(null));
      addButton(buttons, 'OK', true, () => finish(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finish(input.value); }
      });
      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  // 確認。choices: [{ key, label, primary }]。Esc は 'cancel'
  function choose(title, message, choices) {
    return new Promise((resolve) => {
      const { dlg, body, buttons, finish } = makeDialog(title, resolve, 'cancel');
      const p = document.createElement('div');
      p.className = 'dlg-message';
      p.textContent = message;
      body.appendChild(p);
      let focusBtn = null;
      for (const c of choices) {
        const b = addButton(buttons, c.label, c.primary, () => finish(c.key));
        if (c.primary) focusBtn = b;
      }
      dlg.showModal();
      if (focusBtn) focusBtn.focus();
    });
  }

  function message(title, text) {
    return choose(title, text, [{ key: 'ok', label: 'OK', primary: true }]);
  }

  async function confirm(title, text) {
    return (await choose(title, text, [
      { key: 'no', label: 'いいえ' },
      { key: 'yes', label: 'はい', primary: true }])) === 'yes';
  }

  // HTML の内容を見せるだけのダイアログ（ヘルプ用）
  function showHtml(title, html) {
    return new Promise((resolve) => {
      const { dlg, body, buttons, finish } = makeDialog(title, resolve, undefined);
      dlg.classList.add('wide');
      body.innerHTML = html;
      addButton(buttons, '閉じる', true, () => finish());
      dlg.showModal();
    });
  }

  // 中身を自由に組み立てるダイアログ。build(body, buttons, finish) で中身とボタンを作る
  function custom(title, build, cancelValue, wide) {
    return new Promise((resolve) => {
      const { dlg, body, buttons, finish } = makeDialog(title, resolve, cancelValue);
      if (wide) dlg.classList.add('wide');
      build(body, buttons, finish);
      dlg.showModal();
      const input = body.querySelector('input:not([hidden])');
      const primary = buttons.querySelector('button.primary:not([hidden])');
      if (input && input.offsetParent) input.focus();
      else if (primary) primary.focus();
    });
  }

  LC.UI = { showMenu, closeMenus, isMenuOpen, prompt, choose, message, confirm, showHtml, custom, addButton };
})(window.LC = window.LC || {});
