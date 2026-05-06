// Shared "project source" persistence across all tool tabs.
//
// The user uploads a sprite sheet once; every tab (collision, pivot, tags,
// normal-map, palette, pixelate, atlas, gif) reads it from this store.
// Backed by IndexedDB so File/Blob data survives page reloads.
//
// This is deliberately a tiny, purpose-built wrapper rather than a full
// IDB lib — keeps the surface small and easy to audit.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const DB_NAME = "sprite-tools";
const STORE = "project";
const KEY = "source";
const DB_VERSION = 1;

interface StoredSource {
  file: Blob;
  name: string;
  type: string;
  savedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

// Same-tab subscriber list. The localStorage `storage` event only fires in
// *other* tabs, so when one component on this page updates the source we
// need an in-memory broadcaster to keep peer instances of useProjectSource
// in sync. Without this, e.g. the SampleSprites button updates its own
// state but the surrounding tool page still shows "no source".
type SourceListener = (next: ProjectSource | null) => void;
const sameTabListeners = new Set<SourceListener>();

function notifySameTabListeners(next: ProjectSource | null): void {
  for (const fn of sameTabListeners) fn(next);
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function putSource(source: StoredSource): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(source, KEY);
  });
}

async function getSource(): Promise<StoredSource | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as StoredSource | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteSource(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).delete(KEY);
  });
}

// -----------------------------------------------------------------
// Hook
// -----------------------------------------------------------------

export interface ProjectSource {
  file: File;
  name: string;
  savedAt: number;
}

/**
 * Shared project-source state. Each tool page calls this instead of managing
 * its own File state; uploads on any page become the source for every page.
 *
 * - `source` is `undefined` during initial load, `null` when no project.
 * - `setSource(file)` persists to IDB and fires a cross-tab event.
 * - `clearSource()` resets.
 */
export function useProjectSource() {
  const [source, setSourceState] = useState<ProjectSource | null | undefined>(undefined);

  // Initial load + cross-tab + same-tab sync.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const stored = await getSource();
        if (!active) return;
        setSourceState(storedToProject(stored));
      } catch {
        if (active) setSourceState(null);
      }
    })();

    const onLocal: SourceListener = (next) => {
      if (active) setSourceState(next);
    };
    sameTabListeners.add(onLocal);

    const onStorage = (e: StorageEvent) => {
      if (e.key !== "sprite-tools:source-rev") return;
      getSource()
        .then((s) => {
          if (active) setSourceState(storedToProject(s));
        })
        .catch(() => {});
    };
    window.addEventListener("storage", onStorage);

    return () => {
      active = false;
      sameTabListeners.delete(onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setSource = useCallback(async (file: File) => {
    const stored: StoredSource = {
      file,
      name: file.name,
      type: file.type,
      savedAt: Date.now(),
    };
    await putSource(stored);
    const next = storedToProject(stored);
    setSourceState(next);
    notifySameTabListeners(next);
    // Broadcast to other open tabs.
    try {
      localStorage.setItem("sprite-tools:source-rev", String(stored.savedAt));
    } catch {
      // localStorage may be unavailable (incognito); hook still works in-tab.
    }
  }, []);

  const clearSource = useCallback(async () => {
    await deleteSource();
    setSourceState(null);
    notifySameTabListeners(null);
    try {
      localStorage.setItem("sprite-tools:source-rev", String(Date.now()));
    } catch {
      /* ignore */
    }
  }, []);

  return { source, setSource, clearSource } as const;
}

function storedToProject(s: StoredSource | null): ProjectSource | null {
  if (!s) return null;
  // Reconstitute a File from the persisted Blob.
  const file = new File([s.file], s.name, { type: s.type, lastModified: s.savedAt });
  return { file, name: s.name, savedAt: s.savedAt };
}

/**
 * Thin shim on top of useProjectSource that matches the shape each tool page
 * was already using (sourceFile + sourceUrl). Pages only have to drop in this
 * hook and replace their local upload handler with `setSharedSource`.
 */
export function useSharedProjectSource() {
  const { source, setSource, clearSource } = useProjectSource();
  // Blob-URL lifecycle: derive synchronously so downstream renders see a
  // stable string for the same File, then revoke on change/unmount. We key
  // on the File reference directly (useMemo with source?.file) because the
  // wrapping `source` object changes on every IDB round-trip even when the
  // underlying blob is the same.
  const sourceFile = source?.file ?? null;
  const sourceUrl = useMemo(
    () => (sourceFile ? URL.createObjectURL(sourceFile) : null),
    [sourceFile],
  );
  useEffect(() => {
    if (!sourceUrl) return;
    return () => URL.revokeObjectURL(sourceUrl);
  }, [sourceUrl]);

  return {
    sourceFile,
    sourceUrl,
    setSharedSource: setSource,
    clearSharedSource: clearSource,
    isLoading: source === undefined,
  } as const;
}
