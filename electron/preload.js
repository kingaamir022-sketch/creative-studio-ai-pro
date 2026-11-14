'use strict';
// Preload script — contextBridge only.
// The SPA needs nothing from Electron: it talks to the local server over
// HTTP (fetch) and runs with contextIsolation + nodeIntegration off +
// sandbox on. This file is intentionally minimal — it exists so the
// window has a preload wired in (main.js), and so a future desktop-only
// bridge has one obvious place to live. Nothing is exposed today.
const { contextBridge } = require('electron');

// Deliberately no contextBridge.exposeInMainWorld calls: the UI needs none.
void contextBridge;
