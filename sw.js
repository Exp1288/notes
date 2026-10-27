const CACHE_NAME = "my-notes-v4";
const SUPABASE_JS = "./supabase.min.js";

const FILES_TO_CACHE = [
    "./", "./index.html", "./style.css", "./script.js", "./config.js", "./manifest.json"
];

self.addEventListener("install", function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) {
                // Библиотека с CDN необязательна: если не загрузилась, офлайн-режим всё равно ставится
                return cache.addAll(FILES_TO_CACHE).then(function () {
                    return cache.add(SUPABASE_JS).catch(function () {});
                });
            })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys.filter(function (key) { return key !== CACHE_NAME; })
                    .map(function (key) { return caches.delete(key); })
            );
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener("fetch", function (event) {
    const url = new URL(event.request.url);

    // Запросы к серверу синхронизации никогда не кэшируем
    if (event.request.method !== "GET" || url.origin !== location.origin) {
        return;
    }

    // Сначала свежая версия из сети, при отсутствии интернета берём из кэша
    event.respondWith(
        fetch(event.request).then(function (response) {
            if (response.ok) {
                const copy = response.clone();
                caches.open(CACHE_NAME).then(function (cache) { cache.put(event.request, copy); });
            }
            return response;
        }).catch(function () {
            return caches.match(event.request).then(function (cached) {
                return cached || caches.match("./index.html");
            });
        })
    );
});
