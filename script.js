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

const ui = readJSON("my-notes-ui") || {};
if (!Array.isArray(ui.closed)) ui.closed = [];
const layoutEl = $("layout");
const editorEl = $("note-body");
const QUADS = ["1. Срочно и важно", "2. Важно, не срочно", "3. Срочно, не важно", "4. Не срочно и не важно"];
const FACES = ["Arial", "Georgia", "Courier New", "Times New Roman", "Verdana", "Trebuchet MS"];
const TAGS = ["B", "STRONG", "I", "EM", "U", "S", "BR", "DIV", "P", "SPAN", "FONT", "UL", "OL", "LI"];
let openId = null, view = "editor", loadedId = null, loadedVer = 0;

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
}

// Оставляем только безопасное форматирование: жирный, курсив, размер и шрифт
function sanitize(html) {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    (function walk(node) {
        Array.from(node.childNodes).forEach(function (ch) {
            if (ch.nodeType === 3) return;
            if (ch.nodeType !== 1 || ["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE"].includes(ch.tagName)) {
                ch.remove();
                return;
            }
            walk(ch);
            if (!TAGS.includes(ch.tagName)) { ch.replaceWith(...ch.childNodes); return; }
            Array.from(ch.attributes).forEach(function (a) {
                const ok = ch.tagName === "FONT" &&
                    ((a.name === "size" && /^[1-7]$/.test(a.value)) || (a.name === "face" && FACES.includes(a.value)));
                if (!ok) ch.removeAttribute(a.name);
            });
        });
    })(doc.body);
    return doc.body.innerHTML;
}

function plain(html) { return new DOMParser().parseFromString(html, "text/html").body.textContent; }

function toHTML(note) {
    if (note.rich) return sanitize(note.text);
    return sanitize(note.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>"));
}

// Проверка дополнительных полей заметки (из файла или с сервера)
function extras(d) {
    const num = function (v) { return typeof v === "number" && isFinite(v) ? Math.round(v) : null; };
    const x = num(d.cx), y = num(d.cy), onCanvas = x !== null && y !== null;
    return {
        rich: !!d.rich,
        quad: Number.isInteger(d.quad) && d.quad >= 0 && d.quad <= 3 ? d.quad : null,
        cx: onCanvas ? x : null, cy: onCanvas ? y : null,
        links: Array.isArray(d.links)
            ? d.links.filter(function (id) { return typeof id === "string" && ID_RE.test(id); }).slice(0, 50) : []
    };
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

const cur = function () { return db.notes.find(function (n) { return n.id === openId && !n.deleted; }); };

function openNote(id) {
    openId = id;
    view = "editor";
    if (matchMedia("(max-width:700px)").matches) layoutEl.classList.add("collapsed");
    render();
}

function newNote(title) {
    const n = {
        id: crypto.randomUUID(), title: title || "", text: "", rich: true, folderId: null,
        quad: null, cx: null, cy: null, links: [], updatedAt: Date.now(), deleted: false, dirty: true
    };
    db.notes.push(n);
    save();
    openNote(n.id);
}

/* Папки и дерево заметок в боковой панели */

function folderSummary(f) {
    const s = document.createElement("summary");
    s.append(el("span", "", "📁 " + f.name));
    const btn = function (label, title, fn) {
        const b = el("button", "icon mini", label);
        b.title = title;
        b.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); fn(); });
        return b;
    };
    s.append(btn("✎", "Переименовать", function () { renameFolder(f); }),
             btn("✕", "Удалить папку", function () { deleteFolder(f); }));
    return s;
}

function renderSide() {
    notesList.replaceChildren();
    const live = db.notes.filter(function (n) { return !n.deleted; })
        .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    const item = function (n) {
        const b = el("button", "note-item" + (n.id === openId ? " active" : ""), n.title || "Без названия");
        b.addEventListener("click", function () { openNote(n.id); });
        return b;
    };

    liveFolders().forEach(function (f) {
        const d = document.createElement("details");
        d.open = !ui.closed.includes(f.id);
        d.addEventListener("toggle", function () {
            ui.closed = ui.closed.filter(function (x) { return x !== f.id; });
            if (!d.open) ui.closed.push(f.id);
            localStorage.setItem("my-notes-ui", JSON.stringify(ui));
        });
        d.append(folderSummary(f));
        live.filter(function (n) { return folderOf(n) === f.id; }).forEach(function (n) { d.append(item(n)); });
        notesList.append(d);
    });
    live.filter(function (n) { return !folderOf(n); }).forEach(function (n) { notesList.append(item(n)); });
    if (!live.length) notesList.append(el("p", "empty-message", "Пока заметок нет"));
}

function addFolder() {
    const name = (prompt("Название папки") || "").trim().slice(0, MAX_FOLDER);
    if (!name) return;
    db.folders.push({ id: crypto.randomUUID(), name: name, updatedAt: Date.now(), deleted: false, dirty: true });
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
    if (!confirm("Удалить папку «" + folder.name + "»? Заметки из неё останутся без папки.")) return;
    db.notes.forEach(function (n) {
        if (n.folderId === folder.id && !n.deleted) { n.folderId = null; touch(n); }
    });
    tombstone(folder);
    save();
    render();
}

/* Редактор заметки */

function renderEditor() {
    const n = cur();
    $("editor-empty").hidden = !!n;
    $("editor").hidden = !n;
    if (!n) return;
    const typing = $("editor").contains(document.activeElement);
    if (loadedId !== n.id || (n.updatedAt !== loadedVer && !typing)) {
        titleInput.value = n.title;
        editorEl.innerHTML = toHTML(n);
        loadedId = n.id;
        loadedVer = n.updatedAt;
    }
    folderOptions(folderSelect, folderOf(n));
    $("note-quad").value = n.quad == null ? "" : String(n.quad);
}

let editTimer = null;
function edit() {
    const n = cur();
    if (!n) return;
    const html = sanitize(editorEl.innerHTML);
    if (html.length > MAX_TEXT) { setStatus("Заметка слишком длинная и не сохранена"); return; }
    n.title = titleInput.value.slice(0, MAX_TITLE);
    n.text = html;
    n.rich = true;
    touch(n);
    loadedVer = n.updatedAt;
    clearTimeout(editTimer);
    editTimer = setTimeout(function () { save(); renderSide(); }, 500);
}

titleInput.addEventListener("input", edit);
editorEl.addEventListener("input", edit);
editorEl.addEventListener("drop", function (e) { e.preventDefault(); });
editorEl.addEventListener("paste", function (e) {
    e.preventDefault(); // вставляем только текст, без чужого форматирования
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
});
window.addEventListener("pagehide", persist);

folderSelect.addEventListener("change", function () {
    const n = cur();
    if (!n) return;
    n.folderId = folderSelect.value || null;
    touch(n);
    save();
    render();
});

$("note-quad").addEventListener("change", function () {
    const n = cur();
    if (n) setQuad(n, $("note-quad").value);
});

$("delete-note").addEventListener("click", function () {
    const n = cur();
    if (!n || !confirm("Удалить заметку?")) return;
    tombstone(n);
    openId = null;
    save();
    render();
});

// Панель форматирования
let savedRange = null;
document.addEventListener("selectionchange", function () {
    const s = getSelection();
    if (s.rangeCount && editorEl.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
});

function fmt(cmd, value) {
    editorEl.focus();
    if (savedRange) {
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(savedRange);
    }
    document.execCommand("styleWithCSS", false, false);
    document.execCommand(cmd, false, value);
    edit();
}

document.querySelectorAll("[data-cmd]").forEach(function (b) {
    b.addEventListener("mousedown", function (e) { e.preventDefault(); });
    b.addEventListener("click", function () { fmt(b.dataset.cmd); });
});
$("fmt-size").addEventListener("change", function (e) { if (e.target.value) fmt("fontSize", e.target.value); e.target.value = ""; });
$("fmt-font").addEventListener("change", function (e) { if (e.target.value) fmt("fontName", e.target.value); e.target.value = ""; });

$("new-note").addEventListener("click", function () { newNote(""); });
$("add-folder").addEventListener("click", addFolder);
$("today-note").addEventListener("click", function () {
    const title = new Date().toLocaleDateString("ru-RU");
    const exists = db.notes.find(function (n) { return !n.deleted && n.title === title; });
    if (exists) openNote(exists.id); else newNote(title);
});

["side-toggle", "side-open"].forEach(function (id) {
    $(id).addEventListener("click", function () { layoutEl.classList.toggle("collapsed"); });
});

/* Квадрат Эйзенхауэра */

function setQuad(n, value) {
    n.quad = value === "" ? null : Number(value);
    touch(n);
    save();
    render();
}

function dropZone(node, value) {
    node.addEventListener("dragover", function (e) { e.preventDefault(); });
    node.addEventListener("drop", function (e) {
        e.preventDefault();
        const id = e.dataTransfer.getData("text/plain");
        const n = db.notes.find(function (x) { return x.id === id && !x.deleted; });
        if (n) setQuad(n, value);
    });
}

function quadItem(n) {
    const d = el("div", "q-item");
    d.draggable = true;
    d.addEventListener("dragstart", function (e) { e.dataTransfer.setData("text/plain", n.id); });
    const t = el("button", "link-btn", n.title || "Без названия");
    t.addEventListener("click", function () { openNote(n.id); });
    const s = document.createElement("select");
    s.setAttribute("aria-label", "Квадрат");
    [["", "Без квадрата"]].concat(QUADS.map(function (q, i) { return [String(i), q]; })).forEach(function (p) {
        const o = el("option", "", p[1]);
        o.value = p[0];
        s.append(o);
    });
    s.value = n.quad == null ? "" : String(n.quad);
    s.addEventListener("change", function () { setQuad(n, s.value); });
    d.append(t, s);
    return d;
}

function renderMatrix() {
    const live = db.notes.filter(function (n) { return !n.deleted; });
    const grid = $("matrix-grid");
    grid.replaceChildren();
    QUADS.forEach(function (name, i) {
        const q = el("div", "quad q" + i);
        q.append(el("h3", "", name));
        live.filter(function (n) { return n.quad === i; }).forEach(function (n) { q.append(quadItem(n)); });
        dropZone(q, String(i));
        grid.append(q);
    });
    const pool = $("matrix-pool");
    pool.replaceChildren();
    live.filter(function (n) { return n.quad == null; }).forEach(function (n) { pool.append(quadItem(n)); });
    dropZone(pool, "");
}

/* Холст */

const pan = { x: 20, y: 20 };
let linkMode = false, linkFrom = null;
const CARD_W = 170, CARD_H = 90;

function drawLinks(svg, onCanvas) {
    svg.replaceChildren();
    onCanvas.forEach(function (a) {
        (a.links || []).forEach(function (id) {
            const b = onCanvas.find(function (x) { return x.id === id; });
            if (!b) return;
            const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", a.cx + CARD_W / 2);
            line.setAttribute("y1", a.cy + CARD_H / 2);
            line.setAttribute("x2", b.cx + CARD_W / 2);
            line.setAttribute("y2", b.cy + CARD_H / 2);
            line.addEventListener("click", function () {
                if (!confirm("Удалить связь?")) return;
                a.links = a.links.filter(function (x) { return x !== id; });
                touch(a);
                save();
                renderCanvas();
            });
            svg.append(line);
        });
    });
}

function pickLink(n) {
    if (!linkFrom) { linkFrom = n.id; }
    else if (linkFrom !== n.id) {
        const a = db.notes.find(function (x) { return x.id === linkFrom; });
        if (a && !(a.links || []).includes(n.id)) { a.links = (a.links || []).concat(n.id); touch(a); save(); }
        linkFrom = null;
    } else { linkFrom = null; }
    renderCanvas();
}

function renderCanvas() {
    const plane = $("plane");
    plane.replaceChildren();
    plane.style.transform = "translate(" + pan.x + "px," + pan.y + "px)";
    const live = db.notes.filter(function (n) { return !n.deleted; });
    const onCanvas = live.filter(function (n) { return n.cx != null && n.cy != null; });

    const add = $("canvas-add");
    add.replaceChildren();
    const first = el("option", "", "Добавить заметку на холст…");
    first.value = "";
    add.append(first);
    live.filter(function (n) { return n.cx == null; }).forEach(function (n) {
        const o = el("option", "", n.title || "Без названия");
        o.value = n.id;
        add.append(o);
    });
    $("link-mode").classList.toggle("on", linkMode);

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "links");
    plane.append(svg);

    onCanvas.forEach(function (n) {
        const c = el("div", "card" + (linkFrom === n.id ? " picked" : ""));
        c.style.left = n.cx + "px";
        c.style.top = n.cy + "px";
        const bar = el("div", "card-bar");
        const open = el("button", "icon mini", "↗");
        open.title = "Открыть";
        open.addEventListener("click", function () { openNote(n.id); });
        const del = el("button", "icon mini", "✕");
        del.title = "Убрать с холста";
        del.addEventListener("click", function () {
            n.cx = null; n.cy = null; n.links = [];
            touch(n);
            save();
            renderCanvas();
        });
        bar.append(open, del);
        c.append(bar, el("strong", "", n.title || "Без названия"), el("p", "", plain(toHTML(n)).slice(0, 90)));

        c.addEventListener("pointerdown", function (e) {
            if (e.target.closest("button")) return;
            e.stopPropagation();
            if (linkMode) { pickLink(n); return; }
            const sx = e.clientX, sy = e.clientY, ox = n.cx, oy = n.cy;
            let moved = false;
            c.setPointerCapture(e.pointerId);
            const move = function (ev) {
                moved = true;
                n.cx = Math.round(ox + ev.clientX - sx);
                n.cy = Math.round(oy + ev.clientY - sy);
                c.style.left = n.cx + "px";
                c.style.top = n.cy + "px";
                drawLinks(svg, onCanvas);
            };
            const up = function () {
                c.removeEventListener("pointermove", move);
                c.removeEventListener("pointerup", up);
                c.removeEventListener("pointercancel", up);
                if (moved) { touch(n); save(); }
            };
            c.addEventListener("pointermove", move);
            c.addEventListener("pointerup", up);
            c.addEventListener("pointercancel", up);
        });
        plane.append(c);
    });
    drawLinks(svg, onCanvas);
}

$("canvas-add").addEventListener("change", function () {
    const n = db.notes.find(function (x) { return x.id === $("canvas-add").value && !x.deleted; });
    if (!n) return;
    n.cx = Math.round(-pan.x + 30 + Math.random() * 80);
    n.cy = Math.round(-pan.y + 30 + Math.random() * 80);
    touch(n);
    save();
    renderCanvas();
});

$("link-mode").addEventListener("click", function () {
    linkMode = !linkMode;
    linkFrom = null;
    renderCanvas();
});

// Перетаскивание самого холста
$("canvas").addEventListener("pointerdown", function (e) {
    const sx = e.clientX, sy = e.clientY, ox = pan.x, oy = pan.y;
    const canvas = $("canvas");
    canvas.setPointerCapture(e.pointerId);
    const move = function (ev) {
        pan.x = ox + ev.clientX - sx;
        pan.y = oy + ev.clientY - sy;
        $("plane").style.transform = "translate(" + pan.x + "px," + pan.y + "px)";
    };
    const up = function () {
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", up);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
});

/* Общая отрисовка */

document.querySelectorAll(".tab").forEach(function (b) {
    b.addEventListener("click", function () { view = b.dataset.view; render(); });
});

function render() {
    renderSide();
    document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b.dataset.view === view); });
    ["editor", "matrix", "canvas"].forEach(function (v) { $("view-" + v).hidden = v !== view; });
    if (view === "editor") renderEditor();
    else if (view === "matrix") renderMatrix();
    else renderCanvas();
}

/* ---------- Экспорт / импорт ---------- */

$("export-notes").addEventListener("click", function () {
    const backup = {
        version: 2,
        folders: liveFolders().map(function (f) { return { id: f.id, name: f.name }; }),
        notes: db.notes.filter(function (n) { return !n.deleted; }).map(function (n) {
            return Object.assign({ id: n.id, title: n.title, text: n.text, folderId: folderOf(n) }, extras(n));
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
                     folderId: folderIds.has(n.folderId) ? n.folderId : null, ...extras(n) };
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
            ? { title: item.title, text: item.text, folderId: item.folderId, rich: !!item.rich, quad: item.quad == null ? null : item.quad, cx: item.cx == null ? null : item.cx, cy: item.cy == null ? null : item.cy, links: item.links || [] }
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
            folderId: typeof d.folderId === "string" && ID_RE.test(d.folderId) ? d.folderId : null, ...extras(d) };
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
