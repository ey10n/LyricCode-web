/* 曲の一覧とプレイリスト（ブラウザの中に全曲を持つ）。iPad のアプリ版の「曲」「プレイリスト」に相当する。

   1 曲 = { id, name, text, style, updatedAt }
     text  … .lct の形式（Windows 版と同じ）
     style … .lct に書かない飾り（点滅・コードの色・歌詞の太字。Sheet.getStyle の形）
   1 プレイリスト = { id, name, songs, pos, updatedAt }
     songs … 演奏順の曲（曲の id。同じ曲を何度入れてもよい）。曲の一覧に無い曲は 'name:曲名' で持つ
     pos   … プレイリストの一覧での並び順
   消した曲・プレイリストは { id, deleted: true, updatedAt } を残す（他の端末に「消した」ことを伝えるため）。

   他の端末との同期では、曲・プレイリストごとに updatedAt の新しい方を残す（mergeFrom）。 */
(function (LC) {
  'use strict';

  const KEY = 'lyriccode.library';
  const NAME_PREFIX = 'name:';

  function now() {
    return new Date().toISOString();
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  class Library {
    constructor() {
      this.songs = [];      // 消した曲の印も含む
      this.playlists = [];  // 消したプレイリストの印も含む
      this.currentId = '';
      this.load();
    }

    load() {
      try {
        const d = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (d) {
          this.songs = Array.isArray(d.songs) ? d.songs : [];
          this.playlists = Array.isArray(d.playlists) ? d.playlists : [];
          this.currentId = d.currentId || '';
        }
      } catch (e) { /* 読めなければ空から始める */ }
      // 前の版（v3～v5）は、アプリ版から取り込んだプレイリストを { name, songs: [曲名] } のまま持っていた
      if (this.playlists.some((p) => p && !p.id)) {
        this.playlists = this.fromNamed(this.playlists.filter((p) => p && !p.id))
          .concat(this.playlists.filter((p) => p && p.id));
        this.save();
      }
      const merged = this.dedupeByName();
      if (merged.has(this.currentId)) this.currentId = merged.get(this.currentId);
      if (merged.size) this.save();
    }

    /**
     * 同じ名前の曲が 2 曲以上あれば、新しい方（updatedAt が新しい方。同じなら id の大きい方）を 1 曲だけ残す。
     * 2 つの端末で同じファイルを別々に取り込むと、同期で同じ曲が 2 曲ずつになるため。
     * 消した曲は削除の印にして他の端末にも伝え、プレイリストの中の曲は残した曲に付け替える。
     * 戻り値は「消した曲の id → 残した曲の id」
     */
    dedupeByName() {
      const groups = new Map();
      for (const s of this.songs) {
        if (s.deleted || typeof s.name !== 'string') continue;
        const k = s.name.normalize('NFC');
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
      }
      const merged = new Map();
      for (const list of groups.values()) {
        if (list.length < 2) continue;
        list.sort((a, b) => ((b.updatedAt || '') > (a.updatedAt || '') ? 1 : (b.updatedAt || '') < (a.updatedAt || '') ? -1 :
          (b.id > a.id ? 1 : -1)));
        for (const s of list.slice(1)) merged.set(s.id, list[0].id);
      }
      if (!merged.size) return merged;
      this.songs = this.songs.map((s) => (merged.has(s.id) ? { id: s.id, deleted: true, updatedAt: now() } : s));
      for (const p of this.playlistList()) {
        if (p.songs.some((e) => merged.has(e))) {
          this.updatePlaylist(p.id, (q) => { q.songs = q.songs.map((e) => merged.get(e) || e); });
        }
      }
      return merged;
    }

    save() {
      try {
        localStorage.setItem(KEY, JSON.stringify({ songs: this.songs, playlists: this.playlists, currentId: this.currentId }));
        return true;
      } catch (e) {
        return false;
      }
    }

    get exists() {
      return localStorage.getItem(KEY) !== null;
    }

    /** 消していない曲を、名前の順に */
    list() {
      return this.songs.filter((s) => !s.deleted)
        .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
    }

    get(id) {
      return this.songs.find((s) => s.id === id && !s.deleted) || null;
    }

    findByName(name) {
      const n = name.normalize('NFC');
      return this.songs.find((s) => !s.deleted && s.name.normalize('NFC') === n) || null;
    }

    /** 同じ名前の曲があれば「名前 2」「名前 3」… */
    uniqueName(name, exceptId) {
      const base = (name || '').trim() || '無題';
      let n = base, k = 2;
      while (this.songs.some((s) => !s.deleted && s.id !== exceptId && s.name === n)) n = `${base} ${k++}`;
      return n;
    }

    add(name, text, style) {
      const s = { id: newId(), name: this.uniqueName(name), text: text || '', style: style || {}, updatedAt: now() };
      this.songs.push(s);
      this.save();
      return s;
    }

    /** 中身を書き換える。変わっていなければ何もしない（updatedAt も変えない） */
    update(id, fields) {
      const s = this.get(id);
      if (!s) return null;
      let changed = false;
      for (const k of Object.keys(fields)) {
        if (JSON.stringify(s[k]) !== JSON.stringify(fields[k])) { s[k] = fields[k]; changed = true; }
      }
      if (changed) {
        s.updatedAt = now();
        this.saveOk = this.save();
      }
      return s;
    }

    rename(id, name) {
      return this.update(id, { name: this.uniqueName(name, id) });
    }

    /** 曲を消す（プレイリストからも外す） */
    remove(id) {
      const i = this.songs.findIndex((s) => s.id === id);
      if (i < 0) return;
      this.songs[i] = { id, deleted: true, updatedAt: now() };
      for (const p of this.playlistList()) {
        if (p.songs.includes(id)) this.updatePlaylist(p.id, (q) => { q.songs = q.songs.filter((x) => x !== id); });
      }
      this.save();
    }

    // ---- プレイリスト ----

    /** 消していないプレイリストを、並び順に */
    playlistList() {
      return this.playlists.filter((p) => !p.deleted).sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
    }

    getPlaylist(id) {
      return this.playlists.find((p) => p.id === id && !p.deleted) || null;
    }

    findPlaylistByName(name) {
      const n = name.normalize('NFC');
      return this.playlistList().find((p) => p.name.normalize('NFC') === n) || null;
    }

    createPlaylist(name, songs) {
      const list = this.playlistList();
      const pos = list.length ? Math.max(...list.map((p) => p.pos ?? 0)) + 1 : 0;
      const p = { id: newId(), name: (name || '').trim() || '新しいプレイリスト', songs: songs || [], pos, updatedAt: now() };
      this.playlists.push(p);
      this.save();
      return p;
    }

    /** change(プレイリスト) で書き換える */
    updatePlaylist(id, change) {
      const p = this.getPlaylist(id);
      if (!p) return null;
      const before = JSON.stringify(p);
      change(p);
      if (JSON.stringify(p) !== before) {
        p.updatedAt = now();
        this.save();
      }
      return p;
    }

    deletePlaylist(id) {
      const i = this.playlists.findIndex((p) => p.id === id);
      if (i < 0) return;
      this.playlists[i] = { id, deleted: true, updatedAt: now() };
      this.save();
    }

    /** プレイリストの一覧で、上下（delta = -1 / +1）に動かす */
    movePlaylist(id, delta) {
      const list = this.playlistList();
      const i = list.findIndex((p) => p.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      // 並び順を振り直す（変わったものだけ更新日時が変わる）
      list.forEach((p, k) => this.updatePlaylist(p.id, (q) => { q.pos = k; }));
    }

    /** プレイリストの 1 曲分（曲の id か 'name:曲名'）を曲にする。曲の一覧に無ければ null */
    resolve(entry) {
      if (typeof entry !== 'string') return null;
      if (entry.startsWith(NAME_PREFIX)) return this.findByName(entry.slice(NAME_PREFIX.length));
      return this.get(entry);
    }

    /** プレイリストの 1 曲分の名前（見つからない曲も名前を出す） */
    entryName(entry) {
      const s = this.resolve(entry);
      if (s) return s.name;
      if (typeof entry === 'string' && entry.startsWith(NAME_PREFIX)) return entry.slice(NAME_PREFIX.length);
      return '（削除された曲）';
    }

    /** 曲名で並べたプレイリスト（アプリ版の書き出し・前の版の形）を、この形に直す */
    fromNamed(named) {
      let pos = this.playlistList().reduce((m, p) => Math.max(m, (p.pos ?? 0) + 1), 0);
      return named.filter((p) => p && Array.isArray(p.songs)).map((p) => ({
        id: newId(),
        name: String(p.name || '新しいプレイリスト').normalize('NFC'),
        songs: p.songs.map((n) => {
          const s = this.findByName(String(n).normalize('NFC'));
          return s ? s.id : NAME_PREFIX + String(n).normalize('NFC');
        }),
        pos: pos++,
        updatedAt: now(),
      }));
    }

    /** アプリ版から取り込んだプレイリストを入れる（同じ名前のものは曲順を置き換える） */
    importPlaylists(named) {
      for (const p of this.fromNamed(named)) {
        const same = this.findPlaylistByName(p.name);
        if (same) this.updatePlaylist(same.id, (q) => { q.songs = p.songs; });
        else this.playlists.push(p);
      }
      this.save();
    }

    /** 同期で送る内容（並びを決めておき、端末どうしで同じ内容なら同じ文字列になるようにする） */
    snapshot() {
      const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { songs: [...this.songs].sort(byId), playlists: [...this.playlists].sort(byId) };
    }

    /**
     * 他の端末の内容を合わせる（曲・プレイリストごとに新しい方を残す）。
     * 戻り値はこの端末で中身が変わった曲の id（今開いている曲を読み直すため）
     */
    mergeFrom(remote) {
      const changed = [];
      if (!remote || !Array.isArray(remote.songs)) return changed;
      for (const r of remote.songs) {
        if (!r || !r.id) continue;
        const i = this.songs.findIndex((s) => s.id === r.id);
        if (i < 0) {
          this.songs.push(r);
          changed.push(r.id);
        } else if ((r.updatedAt || '') > (this.songs[i].updatedAt || '')) {
          this.songs[i] = r;
          changed.push(r.id);
        }
      }
      let playlistsChanged = false;
      if (Array.isArray(remote.playlists)) {
        // 前の版の端末が送ってきた名前だけのプレイリストは、この端末に 1 つも無いときだけ受け取る
        const legacy = remote.playlists.filter((p) => p && !p.id);
        if (legacy.length && !this.playlistList().length) {
          this.playlists.push(...this.fromNamed(legacy));
          playlistsChanged = true;
        }
        for (const r of remote.playlists) {
          if (!r || !r.id) continue;
          const i = this.playlists.findIndex((p) => p.id === r.id);
          if (i < 0) {
            this.playlists.push(r);
            playlistsChanged = true;
          } else if ((r.updatedAt || '') > (this.playlists[i].updatedAt || '')) {
            this.playlists[i] = r;
            playlistsChanged = true;
          }
        }
      }
      // 他の端末で別々に取り込んだ同じ曲は 1 曲にまとめる（消した曲 → 残した曲を mergedIds に覚える）
      this.mergedIds = this.dedupeByName();
      for (const id of this.mergedIds.keys()) if (!changed.includes(id)) changed.push(id);
      if (this.mergedIds.size) playlistsChanged = true;
      if (changed.length || playlistsChanged) this.save();
      this.playlistsChanged = playlistsChanged;
      return changed;
    }
  }

  LC.Library = Library;
})(window.LC = window.LC || {});
