# Crash Recovery & Reliable Save Design

## [S1] Problem
- Recording chunks stored in in-memory `Map` in background service worker
- MV3 service workers can be killed at any time → all chunks lost
- `saveAs: true` on download can fail silently → recording lost even on normal stop
- No crash recovery: Chrome close = total data loss

## [S2] Solution Overview
Three mechanisms working together:

1. **IndexedDB chunk persistence** — Every chunk received is persisted to IndexedDB immediately
2. **Auto-save on stop** — Use `saveAs: false` with a configurable download folder, falling back to `saveAs: true` if no folder is set
3. **Crash recovery** — On extension startup, detect incomplete recordings in IndexedDB and present recovery UI

## [S3] IndexedDB Schema
Database: `tab-audio-recorder-db`, version 1

Object store: `recordings`
- Key: `tabId` (number)
- Fields: `tabId`, `startTime`, `status` ("recording" | "finalizing"), `chunkCount`

Object store: `chunks`
- Key: auto-increment
- Fields: `tabId`, `index`, `data` (Uint8Array), `timestamp`

## [S4] Modified Recording Flow
1. Start recording: create IndexedDB record with status="recording"
2. Each chunk: write to IndexedDB `chunks` store (in addition to in-memory Map for backward compat)
3. Stop recording:
   a. Mark status="finalizing" in IndexedDB
   b. Read all chunks from IndexedDB, merge
   c. Create blob URL → download
   d. On download success: delete IndexedDB records
   e. On download failure: keep records, show error
4. Chrome restart:
   a. On background.js init, query IndexedDB for status="recording" or "finalizing"
   b. Show badge/notification indicating recoverable recordings
   c. Popup shows "Recover" button for incomplete recordings

## [S5] Service Worker Keep-Alive
- Use `chrome.alarms` to periodically wake the service worker during recording (every 25 seconds, before the ~5 min timeout)
- Alarm handler checks if recordings are active; if not, clears itself

## [S6] Files to Modify
- `background.js` — IndexedDB helper, auto-save, keep-alive, crash recovery
- `popup.js` / `popup.html` — Recovery UI
- `manifest.json` — Add `alarms` permission

## [S7] Out of Scope
- User-configurable download folder (future enhancement)
- Recording resumption after crash (just save what we have)
- Encryption or compression of stored chunks
