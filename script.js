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

function ensure(d) {
    d.canvases = Array.isArray(d.canvases) ? d.canvases : [];
    d.blocks = Array.isArray(d.blocks) ? d.blocks : [];
    return d;
}

let db = ensure(loadData());
let current = "all"; // "all" | "none" | id папки

function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch (e) { alert("Не удалось сохранить: память браузера заполнена."); }
}

function save() { persist(); scheduleSync(); }

function touch(item) { item.updatedAt = Date.now(); item.dirty = true; }

function tombstone(item) {
    item.deleted = true;
    if ("text" in item) { item.text = ""; if ("title" in item) item.title = ""; if ("src" in item) item.src = ""; } else { item.name = ""; }
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
const DAILY_FOLDER = "Дневник";
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
    return { rich: !!d.rich, quad: Number.isInteger(d.quad) && d.quad >= 0 && d.quad <= 3 ? d.quad : null };
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

function newNote(title, folderId) {
    const n = {
        id: crypto.randomUUID(), title: title || "", text: "", rich: true, folderId: folderId || null,
        quad: null, updatedAt: Date.now(), deleted: false, dirty: true
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
    if (exists) { openNote(exists.id); return; }
    let f = liveFolders().find(function (x) { return x.name === DAILY_FOLDER; });
    if (!f) {
        f = { id: crypto.randomUUID(), name: DAILY_FOLDER, updatedAt: Date.now(), deleted: false, dirty: true };
        db.folders.push(f);
    }
    newNote(title, f.id);
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

    const text = el("div", "q-text");
    const t = el("button", "link-btn", n.title || "Без названия");
    t.addEventListener("click", function () { openNote(n.id); });
    const f = liveFolders().find(function (x) { return x.id === folderOf(n); });
    text.append(t, el("small", "badge", f ? "📁 " + f.name : "Без папки"));

    const s = document.createElement("select");
    s.setAttribute("aria-label", "Квадрат");
    [["", "Без квадрата"]].concat(QUADS.map(function (q, i) { return [String(i), q]; })).forEach(function (p) {
        const o = el("option", "", p[1]);
        o.value = p[0];
        s.append(o);
    });
    s.value = n.quad == null ? "" : String(n.quad);
    s.addEventListener("change", function () { setQuad(n, s.value); });
    d.append(text, s);
    return d;
}

// Группа нераспределённых заметок (одна папка), её можно сворачивать
function poolGroup(key, label, list) {
    if (!list.length) return null;
    const d = document.createElement("details");
    d.className = "pool-group";
    d.open = !(ui.poolClosed || []).includes(key);
    d.addEventListener("toggle", function () {
        ui.poolClosed = (ui.poolClosed || []).filter(function (x) { return x !== key; });
        if (!d.open) ui.poolClosed.push(key);
        saveUI();
    });
    d.append(el("summary", "", label + " (" + list.length + ")"));
    list.forEach(function (n) { d.append(quadItem(n)); });
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

    const free = live.filter(function (n) { return n.quad == null; })
        .sort(function (a, b) { return (a.title || "").localeCompare(b.title || ""); });
    const pool = $("matrix-pool");
    pool.replaceChildren();
    liveFolders().forEach(function (f) {
        const g = poolGroup(f.id, "📁 " + f.name, free.filter(function (n) { return folderOf(n) === f.id; }));
        if (g) pool.append(g);
    });
    const rest = poolGroup("none", "Без папки", free.filter(function (n) { return !folderOf(n); }));
    if (rest) pool.append(rest);
    if (!free.length) pool.append(el("p", "empty-message", "Все заметки распределены"));
    $("pool-count").textContent = "(" + free.length + ")";
    $("pool-box").open = !ui.poolHidden;
}

// Эти обработчики добавляем один раз
dropZone($("pool-box"), "");
$("pool-box").addEventListener("toggle", function () {
    ui.poolHidden = !$("pool-box").open;
    saveUI();
});

/* Холст */

const pan = { x: 20, y: 20 };
let zoom = 1, linkMode = false, linkFrom = null, selLink = null, canvasId = ui.canvas || null;
const HEX = /^#[0-9a-f]{6}$/i;
const IMG_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMG = 45000; // сервер принимает до ~60 КБ на запись

function saveUI() { localStorage.setItem("my-notes-ui", JSON.stringify(ui)); }
const liveCanvases = function () { return db.canvases.filter(function (c) { return !c.deleted; }); };
const noteOf = function (b) { return db.notes.find(function (n) { return n.id === b.ref && !n.deleted; }); };

// Карточки старого холста (положение хранилось в заметках) переносим в новый формат
function migrateCanvas() {
    const old = db.notes.filter(function (n) { return !n.deleted && n.cx != null && n.cy != null; });
    if (!old.length) return;
    const now = Date.now(), ids = new Set(old.map(function (n) { return n.id; }));
    if (!db.canvases.some(function (c) { return c.id === "canvas-main"; })) {
        db.canvases.push({ id: "canvas-main", name: "Холст 1", updatedAt: now, deleted: false, dirty: true });
    }
    old.forEach(function (n) {
        const id = "mig-" + n.id;
        if (!db.blocks.some(function (b) { return b.id === id; })) {
            db.blocks.push({
                id: id, canvasId: "canvas-main", type: "note", ref: n.id, text: "", src: "",
                x: n.cx, y: n.cy, updatedAt: now, deleted: false, dirty: true,
                links: (n.links || []).filter(function (t) { return ids.has(t); })
                    .map(function (t) { return { to: "mig-" + t, color: null }; })
            });
        }
        n.cx = null; n.cy = null; n.links = [];
    });
    persist();
}
migrateCanvas();

function curCanvas() {
    let c = liveCanvases().find(function (x) { return x.id === canvasId; }) || liveCanvases()[0];
    if (!c) {
        c = { id: crypto.randomUUID(), name: "Холст 1", updatedAt: Date.now(), deleted: false, dirty: true };
        db.canvases.push(c);
        save();
    }
    canvasId = c.id;
    return c;
}

function setTransform() {
    $("plane").style.transform = "translate(" + pan.x + "px," + pan.y + "px) scale(" + zoom + ")";
    $("zoom-label").textContent = Math.round(zoom * 100) + "%";
}

function zoomAt(factor, px, py) {
    const nz = Math.min(2.5, Math.max(0.3, zoom * factor));
    pan.x = px - (px - pan.x) * (nz / zoom);
    pan.y = py - (py - pan.y) * (nz / zoom);
    zoom = nz;
    setTransform();
}

function addBlock(type, props) {
    const c = curCanvas();
    db.blocks.push(Object.assign({
        id: crypto.randomUUID(), canvasId: c.id, type: type, ref: null, text: "", src: "",
        x: Math.round((40 - pan.x) / zoom + Math.random() * 60), y: Math.round((40 - pan.y) / zoom + Math.random() * 60),
        links: [], updatedAt: Date.now(), deleted: false, dirty: true
    }, props));
    save();
    renderCanvas();
}

// Фото уменьшаем в браузере, чтобы оно поместилось в синхронизацию
function readImage(file, done) {
    const reader = new FileReader();
    reader.onload = function () {
        const img = new Image();
        img.onload = function () {
            let scale = Math.min(1, 420 / Math.max(img.width, img.height)), q = 0.7, out;
            do {
                const c = document.createElement("canvas");
                c.width = Math.max(1, Math.round(img.width * scale));
                c.height = Math.max(1, Math.round(img.height * scale));
                c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
                out = c.toDataURL("image/jpeg", q);
                q -= 0.1; scale *= 0.85;
            } while (out.length > MAX_IMG && q > 0.15);
            if (out.length > MAX_IMG) alert("Не удалось уменьшить фото до нужного размера."); else done(out);
        };
        img.onerror = function () { alert("Не удалось открыть изображение."); };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function drawLinks(svg, blocks, els) {
    svg.replaceChildren();
    const center = function (b) { const e = els[b.id]; return [b.x + e.offsetWidth / 2, b.y + e.offsetHeight / 2]; };
    blocks.forEach(function (a) {
        (a.links || []).forEach(function (lk) {
            const t = blocks.find(function (x) { return x.id === lk.to; });
            if (!t || !els[a.id] || !els[t.id]) return;
            const p = center(a), q = center(t);
            const make = function (cls) {
                const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
                l.setAttribute("class", cls);
                l.setAttribute("x1", p[0]); l.setAttribute("y1", p[1]);
                l.setAttribute("x2", q[0]); l.setAttribute("y2", q[1]);
                return l;
            };
            const sel = selLink && selLink.from === a.id && selLink.to === lk.to;
            const vis = make("vis" + (sel ? " sel" : ""));
            if (HEX.test(lk.color || "")) vis.style.stroke = lk.color;
            const hit = make("hit"); // широкая невидимая линия, чтобы удобно попадать
            hit.addEventListener("click", function () { selLink = { from: a.id, to: lk.to }; renderCanvas(); });
            svg.append(vis, hit);
        });
    });
}

function pickLink(b) {
    if (!linkFrom) { linkFrom = b.id; }
    else if (linkFrom !== b.id) {
        const a = db.blocks.find(function (x) { return x.id === linkFrom; });
        if (a && !(a.links || []).some(function (l) { return l.to === b.id; })) {
            a.links = (a.links || []).concat({ to: b.id, color: null });
            touch(a);
            save();
        }
        linkFrom = null;
    } else { linkFrom = null; }
    renderCanvas();
}

function selectedLink() {
    if (!selLink) return null;
    const a = db.blocks.find(function (b) { return b.id === selLink.from && !b.deleted; });
    const l = a && (a.links || []).find(function (x) { return x.to === selLink.to; });
    return l ? { a: a, l: l } : null;
}

function renderCanvas() {
    const active = document.activeElement;
    if (active && active.tagName === "TEXTAREA" && $("plane").contains(active)) return; // не мешаем печатать

    const c = curCanvas();
    const sel = $("canvas-select");
    sel.replaceChildren();
    liveCanvases().forEach(function (x) { const o = el("option", "", x.name); o.value = x.id; sel.append(o); });
    sel.value = c.id;

    const blocks = db.blocks.filter(function (b) {
        return !b.deleted && b.canvasId === c.id && (b.type !== "note" || noteOf(b));
    });
    const used = new Set(blocks.filter(function (b) { return b.type === "note"; }).map(function (b) { return b.ref; }));
    const add = $("canvas-add");
    add.replaceChildren();
    const first = el("option", "", "Добавить заметку…");
    first.value = "";
    add.append(first);
    const free = db.notes.filter(function (n) { return !n.deleted && !used.has(n.id); })
        .sort(function (a, b) { return (a.title || "").localeCompare(b.title || ""); });
    const group = function (label, list) {
        if (!list.length) return;
        const g = document.createElement("optgroup");
        g.label = label;
        list.forEach(function (n) {
            const o = el("option", "", n.title || "Без названия");
            o.value = n.id;
            g.append(o);
        });
        add.append(g);
    };
    liveFolders().forEach(function (f) {
        group("📁 " + f.name, free.filter(function (n) { return folderOf(n) === f.id; }));
    });
    group("Без папки", free.filter(function (n) { return !folderOf(n); }));
    $("link-mode").classList.toggle("on", linkMode);

    const s = selectedLink();
    if (!s) selLink = null;
    $("link-bar").hidden = !s;
    $("link-color").value = s && HEX.test(s.l.color || "") ? s.l.color : (settings.accent || "#315efb");

    const plane = $("plane");
    plane.replaceChildren();
    setTransform();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "links");
    plane.append(svg);
    const els = {};

    blocks.forEach(function (b) {
        const card = el("div", "card " + b.type + (linkFrom === b.id ? " picked" : ""));
        card.style.left = b.x + "px";
        card.style.top = b.y + "px";
        els[b.id] = card;

        const bar = el("div", "card-bar");
        if (b.type === "note") {
            const open = el("button", "icon mini", "↗");
            open.title = "Открыть заметку";
            open.addEventListener("click", function () { openNote(b.ref); });
            bar.append(open);
        }
        const del = el("button", "icon mini", "✕");
        del.title = "Убрать с холста";
        del.addEventListener("click", function () { tombstone(b); save(); renderCanvas(); });
        bar.append(del);
        card.append(bar);

        if (b.type === "note") {
            const n = noteOf(b);
            card.append(el("strong", "", n.title || "Без названия"), el("p", "", plain(toHTML(n)).slice(0, 90)));
        } else if (b.type === "text") {
            const ta = document.createElement("textarea");
            ta.maxLength = 2000;
            ta.placeholder = "Текст…";
            ta.value = b.text;
            let tt = null;
            ta.addEventListener("input", function () {
                b.text = ta.value;
                touch(b);
                clearTimeout(tt);
                tt = setTimeout(save, 500);
            });
            card.append(ta);
        } else if (IMG_RE.test(b.src)) {
            const im = document.createElement("img");
            im.src = b.src;
            im.alt = "";
            im.draggable = false;
            card.append(im);
        }

        card.addEventListener("pointerdown", function (e) {
            if (e.target.closest("button, textarea")) return;
            e.stopPropagation();
            if (linkMode) { pickLink(b); return; }
            const sx = e.clientX, sy = e.clientY, ox = b.x, oy = b.y;
            let moved = false;
            card.setPointerCapture(e.pointerId);
            const move = function (ev) {
                moved = true;
                b.x = Math.round(ox + (ev.clientX - sx) / zoom);
                b.y = Math.round(oy + (ev.clientY - sy) / zoom);
                card.style.left = b.x + "px";
                card.style.top = b.y + "px";
                drawLinks(svg, blocks, els);
            };
            const up = function () {
                card.removeEventListener("pointermove", move);
                card.removeEventListener("pointerup", up);
                card.removeEventListener("pointercancel", up);
                if (moved) { touch(b); save(); }
            };
            card.addEventListener("pointermove", move);
            card.addEventListener("pointerup", up);
            card.addEventListener("pointercancel", up);
        });
        plane.append(card);
    });
    drawLinks(svg, blocks, els);
}

// Панель инструментов холста
$("canvas-add").addEventListener("change", function () {
    const id = $("canvas-add").value;
    if (id) addBlock("note", { ref: id });
});
$("canvas-text").addEventListener("click", function () { addBlock("text", {}); });
$("canvas-img-btn").addEventListener("click", function () { $("canvas-img").click(); });
$("canvas-img").addEventListener("change", function () {
    const file = $("canvas-img").files[0];
    $("canvas-img").value = "";
    if (file && file.type.startsWith("image/") && file.size < 15 * 1024 * 1024) {
        readImage(file, function (src) { addBlock("image", { src: src }); });
    }
});
$("link-mode").addEventListener("click", function () { linkMode = !linkMode; linkFrom = null; renderCanvas(); });

$("link-color").addEventListener("change", function () {
    const s = selectedLink();
    if (!s) return;
    s.l.color = $("link-color").value;
    touch(s.a);
    save();
    renderCanvas();
});
$("link-del").addEventListener("click", function () {
    const s = selectedLink();
    if (s) { s.a.links = s.a.links.filter(function (x) { return x !== s.l; }); touch(s.a); save(); }
    selLink = null;
    renderCanvas();
});
$("link-done").addEventListener("click", function () { selLink = null; renderCanvas(); });

// Несколько холстов
$("canvas-select").addEventListener("change", function () {
    canvasId = $("canvas-select").value;
    ui.canvas = canvasId;
    saveUI();
    selLink = null; linkFrom = null;
    renderCanvas();
});
$("canvas-new").addEventListener("click", function () {
    const name = (prompt("Название холста") || "").trim().slice(0, MAX_FOLDER);
    if (!name) return;
    const c = { id: crypto.randomUUID(), name: name, updatedAt: Date.now(), deleted: false, dirty: true };
    db.canvases.push(c);
    canvasId = ui.canvas = c.id;
    saveUI();
    save();
    renderCanvas();
});
$("canvas-rename").addEventListener("click", function () {
    const c = curCanvas();
    const name = (prompt("Новое название", c.name) || "").trim().slice(0, MAX_FOLDER);
    if (!name) return;
    c.name = name;
    touch(c);
    save();
    renderCanvas();
});
$("canvas-del").addEventListener("click", function () {
    const c = curCanvas();
    if (!confirm("Удалить холст «" + c.name + "»? Сами заметки останутся.")) return;
    db.blocks.forEach(function (b) { if (b.canvasId === c.id && !b.deleted) tombstone(b); });
    tombstone(c);
    canvasId = ui.canvas = null;
    saveUI();
    save();
    renderCanvas();
});

// Масштаб: кнопки и колесо мыши
const canvasEl = $("canvas");
const zoomCenter = function (f) { zoomAt(f, canvasEl.clientWidth / 2, canvasEl.clientHeight / 2); };
$("zoom-in").addEventListener("click", function () { zoomCenter(1.2); });
$("zoom-out").addEventListener("click", function () { zoomCenter(1 / 1.2); });
$("zoom-reset").addEventListener("click", function () { zoom = 1; pan.x = 20; pan.y = 20; setTransform(); });
canvasEl.addEventListener("wheel", function (e) {
    e.preventDefault();
    const r = canvasEl.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

// Перетаскивание самого холста (только за пустое место)
canvasEl.addEventListener("pointerdown", function (e) {
    if (e.target !== canvasEl && e.target !== $("plane")) return;
    const sx = e.clientX, sy = e.clientY, ox = pan.x, oy = pan.y;
    canvasEl.setPointerCapture(e.pointerId);
    const move = function (ev) { pan.x = ox + ev.clientX - sx; pan.y = oy + ev.clientY - sy; setTransform(); };
    const up = function () {
        canvasEl.removeEventListener("pointermove", move);
        canvasEl.removeEventListener("pointerup", up);
        canvasEl.removeEventListener("pointercancel", up);
    };
    canvasEl.addEventListener("pointermove", move);
    canvasEl.addEventListener("pointerup", up);
    canvasEl.addEventListener("pointercancel", up);
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

function allItems() {
    return [].concat(
        db.folders.map(function (x) { return ["folder", x]; }),
        db.notes.map(function (x) { return ["note", x]; }),
        db.canvases.map(function (x) { return ["canvas", x]; }),
        db.blocks.map(function (x) { return ["block", x]; })
    );
}

function toRow(kind, item) {
    const data = {
        folder: { name: item.name },
        canvas: { name: item.name },
        note: { title: item.title, text: item.text, folderId: item.folderId, rich: !!item.rich, quad: item.quad == null ? null : item.quad },
        block: { canvasId: item.canvasId, type: item.type, ref: item.ref, text: item.text, src: item.src, x: item.x, y: item.y, links: item.links || [] }
    }[kind];
    return { user_id: user.id, id: item.id, kind: kind, data: data, updated_at: item.updatedAt, deleted: !!item.deleted };
}

// Данные с сервера не доверенные: приводим типы и обрезаем длину
function applyRemote(row) {
    if (!ID_RE.test(String(row.id))) return;
    const lists = { folder: db.folders, note: db.notes, canvas: db.canvases, block: db.blocks };
    const list = lists[row.kind];
    if (!list) return;
    const local = list.find(function (x) { return x.id === row.id; });
    if (local && local.updatedAt >= row.updated_at) return; // побеждает более новая версия

    const d = row.data || {};
    const idOk = function (v) { return typeof v === "string" && ID_RE.test(v); };
    const num = function (v) { return typeof v === "number" && isFinite(v) ? Math.round(v) : 0; };
    let item;
    if (row.kind === "folder" || row.kind === "canvas") {
        item = { name: String(d.name || "").slice(0, MAX_FOLDER) };
    } else if (row.kind === "note") {
        item = Object.assign({ title: String(d.title || "").slice(0, MAX_TITLE), text: String(d.text || "").slice(0, MAX_TEXT),
            folderId: idOk(d.folderId) ? d.folderId : null }, extras(d));
    } else {
        item = {
            canvasId: idOk(d.canvasId) ? d.canvasId : "",
            type: ["note", "text", "image"].includes(d.type) ? d.type : "text",
            ref: idOk(d.ref) ? d.ref : null,
            text: String(d.text || "").slice(0, 2000),
            src: typeof d.src === "string" && d.src.length <= MAX_IMG && IMG_RE.test(d.src) ? d.src : "",
            x: num(d.x), y: num(d.y),
            links: Array.isArray(d.links)
                ? d.links.filter(function (l) { return l && idOk(l.to); }).slice(0, 50)
                    .map(function (l) { return { to: l.to, color: HEX.test(l.color || "") ? l.color : null }; }) : []
        };
    }
    Object.assign(item, { id: row.id, updatedAt: Number(row.updated_at), deleted: !!row.deleted, dirty: false });
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
    const dirty = allItems().filter(function (pair) { return pair[1].dirty; });
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
    if (db.owner && db.owner !== u.id) db = ensure({ notes: [], folders: [], lastPull: null, owner: null });
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
            db = ensure({ notes: [], folders: [], lastPull: null, owner: null });
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
