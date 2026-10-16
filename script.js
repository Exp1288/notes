
const titleInput = document.getElementById("note-title");
const textInput = document.getElementById("note-text");
const addButton = document.getElementById("add-note");
const notesList = document.getElementById("notes-list");
const exportButton = document.getElementById("export-notes");
const importButton = document.getElementById("import-notes");
const importFile = document.getElementById("import-file");

// Загружаем сохранённые заметки
let notes = JSON.parse(localStorage.getItem("my-notes")) || [];

function saveNotes() {
    localStorage.setItem("my-notes", JSON.stringify(notes));
}

function renderNotes() {
    notesList.innerHTML = "";

    if (notes.length === 0) {
        showEmptyMessage();
        return;
    }

    notes.forEach(function (note) {
        const article = document.createElement("article");
        article.className = "note";

        const heading = document.createElement("h3");
        heading.textContent = note.title || "Без названия";

        const paragraph = document.createElement("p");
        paragraph.textContent = note.text;

        const deleteButton = document.createElement("button");
        deleteButton.className = "delete-button";
        deleteButton.textContent = "Удалить";

        deleteButton.addEventListener("click", function () {
            notes = notes.filter(function (item) {
                return item.id !== note.id;
            });

            saveNotes();
            renderNotes();
        });

        article.append(heading, paragraph, deleteButton);
        notesList.append(article);
    });
}

function showEmptyMessage() {
    const message = document.createElement("p");
    message.className = "empty-message";
    message.textContent = "Пока заметок нет";
    notesList.append(message);
}

addButton.addEventListener("click", function () {
    const title = titleInput.value.trim();
    const text = textInput.value.trim();

    if (!title && !text) {
        alert("Напиши хотя бы название или текст заметки.");
        return;
    }

    const note = {
        id: crypto.randomUUID(),
        title: title,
        text: text
    };

    notes.unshift(note);

    saveNotes();
    renderNotes();

    titleInput.value = "";
    textInput.value = "";
});

// Показываем заметки при открытии приложения
renderNotes();
if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
        navigator.serviceWorker.register("./sw.js")
            .then(function () {
                console.log("Офлайн-режим подключён");
            })
            .catch(function (error) {
                console.error("Ошибка Service Worker:", error);
            });
    });
}
// Экспорт заметок в JSON-файл
exportButton.addEventListener("click", function () {
    const backup = JSON.stringify(notes, null, 2);

    const blob = new Blob([backup], {
        type: "application/json"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "my-notes-backup.json";
    link.click();

    URL.revokeObjectURL(url);
});
// Открываем выбор файла для импорта
importButton.addEventListener("click", function () {
    importFile.click();
});

// Читаем и проверяем резервную копию
importFile.addEventListener("change", function () {
    const file = importFile.files[0];

    if (!file) {
        return;
    }

    const reader = new FileReader();

    reader.onload = function () {
        try {
            const importedNotes = JSON.parse(reader.result);

            const validNotes =
                Array.isArray(importedNotes) &&
                importedNotes.every(function (note) {
                    return (
                        note &&
                        typeof note.id === "string" &&
                        typeof note.title === "string" &&
                        typeof note.text === "string"
                    );
                });

            if (!validNotes) {
                alert("Файл имеет неправильный формат.");
                return;
            }

            const shouldReplace = confirm(
                "Импорт заменит все текущие заметки. Продолжить?"
            );

            if (!shouldReplace) {
                return;
            }

            notes = importedNotes;
            saveNotes();
            renderNotes();

            alert("Заметки успешно восстановлены.");
        } catch (error) {
            alert("Не удалось прочитать файл. Проверь, что это JSON-копия заметок.");
        } finally {
            importFile.value = "";
        }
    };

    reader.readAsText(file);
});
