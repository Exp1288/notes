const $ = function (id) { return document.getElementById(id); };

const titleInput = $("note-title");
const textInput = $("note-text");
const addButton = $("add-note");
const notesList = $("notes-list");
const folderNav = $("folders");
const folderSelect = $("note-folder");
const statusEl = $("sync-status");
const authMsg = $("auth-msg");

const KEY = "my-notes-v2";
const SETTINGS_KEY = "my-notes-settings";
const MAX_TITLE = 200, MAX_TEXT = 20000, MAX_FOLDER = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ---------- Данные ---------- */

function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

function loadData() {
    const d = readJSON(KEY);
    if (d && Array.isArray(d.notes) && Array.isArray(d.folders)) return d;

    // Миграция со старой версии (ключ "my-notes")
    const old = readJSON("my-notes");
    const now = Date.now();
    return {
        notes: (Array.isArray(old) ? old : [])
            .filter(function (n) { return n && ID_RE.test(String(n.id)); })
            .map(function (n) {
                return { id: n.id, title: String(n.title || ""), text: String(n.text || ""),
                         folderId: null, updatedAt: now, deleted: false, dirty: true };
            }),
        folders: [], lastPull: null, owner: null
    };
}

let db = loadData();
let current = "all"; // "all" | "none" | id папки

function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { alert("Не удалось сохранить: память браузера заполнена."); }
}

function save() { persist(); scheduleSync(); }

function touch(item) { item.updatedAt = Date.now(); item.dirty = true; }

function tombstone(item) {
    item.deleted = true;
    if ("text" in item) { item.title = ""; item.text = ""; } else { item.name = ""; }
    touch(item);
}

const liveFolders = function () {
    return db.folders.filter(function (f) { return !f.deleted; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
};

function folderOf(note) {
    return liveFolders().some(function (f) { return f.id === note.folderId; }) ? note.folderId : null;
}

/* ---------- Отрисовка ---------- */

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

function folderOptions(select, selected) {
    select.replaceChildren();
    const none = el("option", "", "Без папки");
    none.value = "";
    select.append(none);
    liveFolders().forEach(function (f) {
        const o = el("option", "", "📁 " + f.name);
        o.value = f.id;
        select.append(o);
    });
    select.value = selected || "";
}

function chip(label, id, extra) {
    const b = el("button", "chip" + (current === id ? " active" : "") + (extra || ""), label);
    b.addEventListener("click", function () { current = id; render(); });
    return b;
}

function actionChip(label, handler) {
    const b = el("button", "chip ghost", label);
    b.addEventListener("click", handler);
    return b;
}

function renderFolders() {
    folderNav.replaceChildren(chip("Все", "all"), chip("Без папки", "none"));
    liveFolders().forEach(function (f) { folderNav.append(chip("📁 " + f.name, f.id)); });
    folderNav.append(actionChip("＋ Папка", addFolder));

    const open = liveFolders().find(function (f) { return f.id === current; });
    if (open) {
        folderNav.append(actionChip("Переименовать", function () { renameFolder(open); }));
        folderNav.append(actionChip("Удалить папку", function () { deleteFolder(open); }));
    }
}

function renderNotes() {
    notesList.replaceChildren();

    const shown = db.notes.filter(function (n) {
        if (n.deleted) return false;
        if (current === "all") return true;
        return (folderOf(n) || "none") === current;
    }).sort(function (a, b) { return b.updatedAt - a.updatedAt; });

    if (shown.length === 0) {
        notesList.append(el("p", "empty-message", "Пока заметок нет"));
        return;
    }

    shown.forEach(function (note) {
        const article = el("article", "note");
        const heading = el("h3", "", note.title || "Без названия");
        const paragraph = el("p", "", note.text);

        const move = document.createElement("select");
        move.setAttribute("aria-label", "Переместить в папку");
        folderOptions(move, folderOf(note));
        move.addEventListener("change", function () {
            note.folderId = move.value || null;
            touch(note);
            save();
            render();
        });

        const del = el("button", "delete-button", "Удалить");
        del.addEventListener("click", function () {
            tombstone(note);
            save();
            render();
        });

        const actions = el("div", "note-actions");
        actions.append(move, del);
        article.append(heading, paragraph, actions);
        notesList.append(article);
    });
}

function render() {
    if (current !== "all" && current !== "none" &&
        !liveFolders().some(function (f) { return f.id === current; })) {
        current = "all";
    }
    renderFolders();
    folderOptions(folderSelect, current !== "all" && current !== "none" ? current : "");
    renderNotes();
}

/* ---------- Папки и заметки ---------- */

function addFolder() {
    const name = (prompt("Название папки") || "").trim().slice(0, MAX_FOLDER);
    if (!name) return;
    const folder = { id: crypto.randomUUID(), name: name, updatedAt: Date.now(), deleted: false, dirty: true };
    db.folders.push(folder);
    current = folder.id;
    save();
    render();
}

function renameFolder(folder) {
    const name = (prompt("Новое название", folder.name) || "").trim().slice(0, MAX_FOLDER);
    if (!name) return;
    folder.name = name;
    touch(folder);
    save();
    render();
}

function deleteFolder(folder) {
    if (!confirm("Удалить папку «" + folder.name + "»? Заметки из неё останутся в разделе «Без папки».")) return;
    db.notes.forEach(function (n) {
        if (n.folderId === folder.id && !n.deleted) { n.folderId = null; touch(n); }
    });
    tombstone(folder);
    current = "all";
    save();
    render();
}

addButton.addEventListener("click", function () {
    const title = titleInput.value.trim().slice(0, MAX_TITLE);
    const text = textInput.value.trim().slice(0, MAX_TEXT);

    if (!title && !text) {
        alert("Напиши хотя бы название или текст заметки.");
        return;
    }

    db.notes.push({
        id: crypto.randomUUID(), title: title, text: text,
        folderId: folderSelect.value || null,
        updatedAt: Date.now(), deleted: false, dirty: true
    });
    save();
    render();

    titleInput.value = "";
    textInput.value = "";
});

/* ---------- Экспорт / импорт ---------- */

$("export-notes").addEventListener("click", function () {
    const backup = {
        version: 2,
        folders: liveFolders().map(function (f) { return { id: f.id, name: f.name }; }),
        notes: db.notes.filter(function (n) { return !n.deleted; }).map(function (n) {
            return { id: n.id, title: n.title, text: n.text, folderId: folderOf(n) };
        })
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "my-notes-backup.json";
    link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
});

$("import-notes").addEventListener("click", function () { $("import-file").click(); });

// Строгая проверка: принимаем только известные поля и типы
function parseBackup(raw) {
    const notes = Array.isArray(raw) ? raw : raw && raw.notes;
    const folders = Array.isArray(raw) ? [] : (raw && raw.folders) || [];
    if (!Array.isArray(notes) || !Array.isArray(folders)) return null;
    if (notes.length > 5000 || folders.length > 500) return null;

    const okId = function (x) { return x && typeof x.id === "string" && ID_RE.test(x.id); };
    if (!folders.every(function (f) { return okId(f) && typeof f.name === "string"; })) return null;
    if (!notes.every(function (n) { return okId(n) && typeof n.title === "string" && typeof n.text === "string"; })) return null;

    const folderIds = new Set(folders.map(function (f) { return f.id; }));
    return {
        folders: folders.map(function (f) { return { id: f.id, name: f.name.slice(0, MAX_FOLDER) }; }),
        notes: notes.map(function (n) {
            return { id: n.id, title: n.title.slice(0, MAX_TITLE), text: n.text.slice(0, MAX_TEXT),
                     folderId: folderIds.has(n.folderId) ? n.folderId : null };
        })
    };
}

function replaceAll(incoming, current) {
    const now = Date.now();
    const ids = new Set(incoming.map(function (x) { return x.id; }));
    current.forEach(function (x) { if (!ids.has(x.id) && !x.deleted) tombstone(x); });
    const kept = current.filter(function (x) { return !ids.has(x.id); });
    return incoming.map(function (x) {
        return Object.assign({}, x, { updatedAt: now, deleted: false, dirty: true });
    }).concat(kept);
}

$("import-file").addEventListener("change", function () {
    const input = $("import-file");
    const file = input.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
        alert("Файл слишком большой.");
        input.value = "";
        return;
    }

    const reader = new FileReader();
    reader.onload = function () {
        try {
            const data = parseBackup(JSON.parse(reader.result));
            if (!data) { alert("Файл имеет неправильный формат."); return; }
            if (!confirm("Импорт заменит все текущие заметки. Продолжить?")) return;

            db.notes = replaceAll(data.notes, db.notes);
            db.folders = replaceAll(data.folders, db.folders);
            save();
            render();
            alert("Заметки успешно восстановлены.");
        } catch (error) {
            alert("Не удалось прочитать файл. Проверь JSON-копию.");
        } finally {
            input.value = "";
        }
    };
    reader.readAsText(file);
});

/* ---------- Настройки внешнего вида ---------- */

const DEFAULTS = { theme: "system", accent: "#315efb", font: "16" };
const saved = readJSON(SETTINGS_KEY) || {};
const settings = {
    theme: ["system", "light", "dark"].includes(saved.theme) ? saved.theme : DEFAULTS.theme,
    accent: /^#[0-9a-f]{6}$/i.test(saved.accent) ? saved.accent : DEFAULTS.accent,
    font: ["14", "16", "18"].includes(saved.font) ? saved.font : DEFAULTS.font
};

function applySettings() {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
    root.style.setProperty("--accent", settings.accent);
    root.style.setProperty("--fs", settings.font + "px");

    const bg = getComputedStyle(root).getPropertyValue("--bg").trim();
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.setAttribute("content", bg);
}

function bindSetting(id, key) {
    const input = $(id);
    input.value = settings[key];
    input.addEventListener("input", function () {
        settings[key] = input.value;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        applySettings();
    });
}

bindSetting("set-theme", "theme");
bindSetting("set-accent", "accent");
bindSetting("set-font", "font");
applySettings();

/* ---------- Синхронизация (Supabase) ---------- */

const cfg = window.NOTES_CONFIG || {};
let sb = null, user = null, syncing = false, syncTimer = null;

if (window.supabase && cfg.supabaseUrl && cfg.supabaseKey) {
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true }
    });
}

function setStatus(text) { statusEl.textContent = text; }

function toRow(kind, item) {
    return {
        user_id: user.id, id: item.id, kind: kind,
        data: kind === "note"
            ? { title: item.title, text: item.text, folderId: item.folderId }
            : { name: item.name },
        updated_at: item.updatedAt, deleted: !!item.deleted
    };
}

// Данные с сервера не доверенные: приводим типы и обрезаем длину
function applyRemote(row) {
    if (!ID_RE.test(String(row.id))) return;
    const list = row.kind === "folder" ? db.folders : db.notes;
    const local = list.find(function (x) { return x.id === row.id; });
    if (local && local.updatedAt >= row.updated_at) return; // побеждает более новая версия

    const d = row.data || {};
    const item = row.kind === "folder"
        ? { id: row.id, name: String(d.name || "").slice(0, MAX_FOLDER) }
        : { id: row.id, title: String(d.title || "").slice(0, MAX_TITLE), text: String(d.text || "").slice(0, MAX_TEXT),
            folderId: typeof d.folderId === "string" && ID_RE.test(d.folderId) ? d.folderId : null };
    Object.assign(item, { updatedAt: Number(row.updated_at), deleted: !!row.deleted, dirty: false });

    if (local) Object.assign(local, item); else list.push(item);
}

async function pull() {
    // Берём с запасом в 5 секунд: так не потеряем строки, записанные почти одновременно
    let since = db.lastPull ? new Date(Date.parse(db.lastPull) - 5000).toISOString() : null;
    let last = db.lastPull;
    for (;;) {
        let q = sb.from("items").select("*").order("synced_at", { ascending: true }).limit(1000);
        if (since) q = q.gt("synced_at", since);
        const res = await q;
        if (res.error) throw res.error;
        res.data.forEach(applyRemote);
        if (res.data.length) { last = since = res.data[res.data.length - 1].synced_at; }
        if (res.data.length < 1000) break;
    }
    db.lastPull = last;
}

async function push() {
    const dirty = db.folders.map(function (f) { return ["folder", f]; })
        .concat(db.notes.map(function (n) { return ["note", n]; }))
        .filter(function (pair) { return pair[1].dirty; });
    if (!dirty.length) return;

    const versions = dirty.map(function (p) { return p[1].updatedAt; });
    const res = await sb.from("items").upsert(
        dirty.map(function (p) { return toRow(p[0], p[1]); }),
        { onConflict: "user_id,id" }
    );
    if (res.error) throw res.error;
    // Если заметку изменили во время отправки, она останется «грязной» и уйдёт в следующий раз
    dirty.forEach(function (p, i) { if (p[1].updatedAt === versions[i]) p[1].dirty = false; });
}

async function sync() {
    if (!sb || !user || syncing || !navigator.onLine) return;
    syncing = true;
    setStatus("Синхронизация…");
    try {
        await pull();   // сначала забираем чужие изменения, чтобы не затереть более новые
        await push();
        persist();
        render();
        setStatus("Синхронизировано " + new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
        console.error(e);
        setStatus("Ошибка синхронизации");
    } finally {
        syncing = false;
    }
}

function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 800);
}

function setUser(u) {
    user = u;
    $("auth-out").hidden = !!u;
    $("auth-in").hidden = !u;
    $("user-email").textContent = u ? u.email : "";
    if (!u) { setStatus(sb ? "Не выполнен вход" : ""); return; }

    // Если на устройстве данные другого аккаунта, не смешиваем их
    if (db.owner && db.owner !== u.id) db = { notes: [], folders: [], lastPull: null, owner: null };
    db.owner = u.id;
    persist();
    render();
    setTimeout(sync, 0);
}

async function authenticate(signUp) {
    const email = $("auth-email").value.trim();
    const password = $("auth-pass").value;
    if (!email || password.length < 8) {
        authMsg.textContent = "Введите email и пароль не короче 8 символов.";
        return;
    }
    authMsg.textContent = "Подождите…";
    const res = signUp
        ? await sb.auth.signUp({ email: email, password: password })
        : await sb.auth.signInWithPassword({ email: email, password: password });
    if (res.error) { authMsg.textContent = "Ошибка: " + res.error.message; return; }
    $("auth-pass").value = "";
    authMsg.textContent = signUp && !res.data.session
        ? "Письмо отправлено. Подтвердите email и затем войдите."
        : "";
}

if (!sb) {
    $("auth-out").hidden = true;
    authMsg.textContent = window.supabase
        ? "Синхронизация выключена: заполните config.js (см. инструкцию)."
        : "Синхронизация недоступна: не загрузилась библиотека (нет интернета?).";
} else {
    $("auth-in-btn").addEventListener("click", function () { authenticate(false); });
    $("auth-up-btn").addEventListener("click", function () { authenticate(true); });
    $("auth-pass").addEventListener("keydown", function (e) { if (e.key === "Enter") authenticate(false); });
    $("sync-now").addEventListener("click", sync);
    $("logout").addEventListener("click", async function () {
        await sb.auth.signOut();
        if (confirm("Удалить заметки с этого устройства? В облаке они сохранятся.")) {
            db = { notes: [], folders: [], lastPull: null, owner: null };
            persist();
            render();
        }
    });

    sb.auth.getSession().then(function (r) { setUser(r.data.session ? r.data.session.user : null); });
    sb.auth.onAuthStateChange(function (event, session) {
        const next = session ? session.user : null;
        // Колбэк не должен ждать запросы к Supabase, поэтому откладываем
        if ((next && next.id) !== (user && user.id)) setTimeout(function () { setUser(next); }, 0);
    });

    window.addEventListener("online", sync);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) sync(); });
    setInterval(sync, 30000);
}

/* ---------- Запуск ---------- */

render();

if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js").catch(function (error) {
            console.error("Ошибка Service Worker:", error);
        });
    });
}
