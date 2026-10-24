/* 曲の一覧（ブラウザの中に全曲を持つ）。iPad のアプリ版の「曲」のライブラリに相当する。

   1 曲 = { id, name, text, style, updatedAt }
     text  … .lct の形式（Windows 版と同じ）
     style … .lct に書かない飾り（点滅・コードの色・歌詞の太字。Sheet.getStyle の形）
   消した曲は { id, deleted: true, updatedAt } を残す（他の端末に「消した」ことを伝えるため）。

   他の端末との同期では、曲ごとに updatedAt の新しい方を残す（mergeFrom）。 */
(function (LC) {
  'use strict';

  const KEY = 'lyriccode.library';

  function now() {
    return new Date().toISOString();
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  class Library {
    constructor() {
      this.songs = [];      // 消した曲の印も含む
      this.playlists = [];  // アプリ版から取り込んだプレイリスト（{ name, songs: [曲名] }。今は保存だけ）
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

    remove(id) {
      const i = this.songs.findIndex((s) => s.id === id);
      if (i < 0) return;
      this.songs[i] = { id, deleted: true, updatedAt: now() };
      this.save();
    }

    /** 同期で送る内容（並びを決めておき、端末どうしで同じ内容なら同じ文字列になるようにする） */
    snapshot() {
      const songs = [...this.songs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { songs, playlists: this.playlists };
    }

    /**
     * 他の端末の内容を合わせる（曲ごとに新しい方を残す）。
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
      if (Array.isArray(remote.playlists) && remote.playlists.length && !this.playlists.length) {
        this.playlists = remote.playlists;
      }
      if (changed.length) this.save();
      return changed;
    }
  }

  LC.Library = Library;
})(window.LC = window.LC || {});
