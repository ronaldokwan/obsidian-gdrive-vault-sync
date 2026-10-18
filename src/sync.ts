import { App, moment, TFile } from "obsidian";
import { DriveClient, FOLDER_MIME, RemoteFile } from "./drive";

/** What a path looked like on both sides right after it was last synced. */
export interface FileState {
  localHash: string;
  localMtime: number;
  localSize: number;
  remoteId: string;
  /** md5Checksum from Drive (falls back to modifiedTime). */
  remoteVersion: string;
}

export type SyncState = Record<string, FileState>;

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: number;
  errors: string[];
}

export interface SyncOptions {
  rootFolderName: string;
  excludePatterns: string[];
  concurrency: number;
  confirmMassDelete: (localCount: number, remoteCount: number) => Promise<boolean>;
  onProgress: (done: number, total: number) => void;
}

type ActionKind = "upload" | "download" | "deleteLocal" | "deleteRemote" | "reconcile" | "forget";

interface Action {
  kind: ActionKind;
  path: string;
}

// Deleting more than this many files (and this share of tracked files) in one run needs confirmation.
const MASS_DELETE_MIN = 10;
const MASS_DELETE_RATIO = 0.25;

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function remoteVersion(file: RemoteFile): string {
  return file.md5Checksum ?? file.modifiedTime;
}

export function compileExcludes(patterns: string[]): (path: string) => boolean {
  const matchers = patterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"))
    .map((p): ((path: string) => boolean) => {
      if (!p.includes("*")) {
        const prefix = p.replace(/\/+$/, "");
        return (path) => path === prefix || path.startsWith(prefix + "/");
      }
      const source = p
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        // "**/" also matches zero folders, so **/*.tmp matches a root-level x.tmp.
        .replace(/\*\*\//g, "\u0001")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0001/g, "(?:.*/)?")
        .replace(/\u0000/g, ".*");
      const re = new RegExp(`^${source}$`);
      return (path) => re.test(path);
    });
  return (path) => matchers.some((m) => m(path));
}

export class SyncEngine {
  private rootId = "";
  private localFiles = new Map<string, TFile>();
  private remoteFiles = new Map<string, RemoteFile>();
  private remoteFolders = new Map<string, Promise<string>>();
  private result: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, errors: [] };

  constructor(
    private app: App,
    private drive: DriveClient,
    private state: SyncState,
    private options: SyncOptions
  ) {}

  async run(): Promise<SyncResult> {
    const isExcluded = compileExcludes(this.options.excludePatterns);

    this.rootId = await this.drive.findOrCreateRootFolder(this.options.rootFolderName);
    await this.loadRemote(isExcluded);
    for (const file of this.app.vault.getFiles()) {
      if (!isExcluded(file.path)) this.localFiles.set(file.path, file);
    }

    const tracked = Object.keys(this.state).filter((p) => !isExcluded(p)).length;
    if (tracked > 0 && this.remoteFiles.size === 0) {
      throw new Error(
        `The Drive folder "${this.options.rootFolderName}" is empty or missing, so syncing would delete your local notes. ` +
          `Aborted. If this is intended, run "Reset sync state" and sync again.`
      );
    }
    if (tracked > 0 && this.localFiles.size === 0) {
      throw new Error(`Your vault looks empty, so syncing would delete everything in Drive. Aborted.`);
    }

    const actions = await this.plan();

    const localDeletes = actions.filter((a) => a.kind === "deleteLocal").length;
    const remoteDeletes = actions.filter((a) => a.kind === "deleteRemote").length;
    const deletes = localDeletes + remoteDeletes;
    if (deletes > MASS_DELETE_MIN && deletes > tracked * MASS_DELETE_RATIO) {
      if (!(await this.options.confirmMassDelete(localDeletes, remoteDeletes))) {
        throw new Error("Sync cancelled.");
      }
    }

    let done = 0;
    const work = actions.filter((a) => a.kind !== "forget");
    this.options.onProgress(0, work.length);
    for (const a of actions) if (a.kind === "forget") delete this.state[a.path];

    await runPool(work, this.options.concurrency, async (action) => {
      try {
        await this.execute(action);
      } catch (e) {
        console.error(`[gdrive-vault-sync] ${action.kind} ${action.path}`, e);
        this.result.errors.push(`${action.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.options.onProgress(++done, work.length);
    });

    return this.result;
  }

  private async loadRemote(isExcluded: (path: string) => boolean) {
    const all = await this.drive.listAll();
    const byId = new Map(all.map((f) => [f.id, f]));
    const pathCache = new Map<string, string | null>([[this.rootId, ""]]);

    // Rebuild each file's vault-relative path by walking parents up to the root folder.
    // Files outside the root (e.g. another vault's folder) resolve to null.
    const resolve = (id: string): string | null => {
      if (pathCache.has(id)) return pathCache.get(id)!;
      const file = byId.get(id);
      const parentId = file?.parents?.[0];
      let path: string | null = null;
      if (file && parentId) {
        const parent = parentId === this.rootId ? "" : byId.get(parentId)?.mimeType === FOLDER_MIME ? resolve(parentId) : null;
        if (parent !== null) path = parent ? `${parent}/${file.name}` : file.name;
      }
      pathCache.set(id, path);
      return path;
    };

    this.remoteFolders.set("", Promise.resolve(this.rootId));
    for (const file of all) {
      const path = resolve(file.id);
      if (path === null || path === "") continue;
      if (file.mimeType === FOLDER_MIME) {
        if (!this.remoteFolders.has(path)) this.remoteFolders.set(path, Promise.resolve(file.id));
        continue;
      }
      // Native Google Docs/Sheets can't be downloaded as-is.
      if (file.mimeType.startsWith("application/vnd.google-apps.")) continue;
      if (isExcluded(path)) continue;
      // Two files at the same path (e.g. created concurrently by two devices): keep the newest.
      const existing = this.remoteFiles.get(path);
      if (!existing || file.modifiedTime > existing.modifiedTime) this.remoteFiles.set(path, file);
    }
  }

  private async plan(): Promise<Action[]> {
    const paths = new Set([...this.localFiles.keys(), ...this.remoteFiles.keys(), ...Object.keys(this.state)]);
    const actions: Action[] = [];

    for (const path of paths) {
      const local = this.localFiles.get(path);
      const remote = this.remoteFiles.get(path);
      const prev = this.state[path];
      const kind = await this.decide(local, remote, prev);
      if (kind) actions.push({ kind, path });
    }
    return actions;
  }

  private async decide(local: TFile | undefined, remote: RemoteFile | undefined, prev: FileState | undefined): Promise<ActionKind | null> {
    if (local && remote) {
      if (!prev) return "reconcile";
      const localChanged = await this.localChanged(local, prev);
      const remoteChanged = this.remoteChanged(remote, prev);
      if (localChanged && remoteChanged) return "reconcile";
      if (localChanged) return "upload";
      if (remoteChanged) return "download";
      return null;
    }
    if (local) {
      if (!prev) return "upload";
      // Deleted in Drive. Keep the local copy if it was edited since the last sync.
      return (await this.localChanged(local, prev)) ? "upload" : "deleteLocal";
    }
    if (remote) {
      if (!prev) return "download";
      // Deleted locally. Keep the Drive copy if it was edited since the last sync.
      return this.remoteChanged(remote, prev) ? "download" : "deleteRemote";
    }
    return "forget";
  }

  private async localChanged(file: TFile, prev: FileState): Promise<boolean> {
    if (file.stat.mtime === prev.localMtime && file.stat.size === prev.localSize) return false;
    const hash = await sha256Hex(await this.app.vault.readBinary(file));
    if (hash !== prev.localHash) return true;
    // Touched but not edited: remember the new mtime so it isn't re-hashed every run.
    prev.localMtime = file.stat.mtime;
    prev.localSize = file.stat.size;
    return false;
  }

  private remoteChanged(file: RemoteFile, prev: FileState): boolean {
    return file.id !== prev.remoteId || remoteVersion(file) !== prev.remoteVersion;
  }

  private async execute({ kind, path }: Action) {
    switch (kind) {
      case "upload":
        await this.upload(path);
        this.result.uploaded++;
        break;
      case "download":
        await this.download(path, this.remoteFiles.get(path)!);
        this.result.downloaded++;
        break;
      case "deleteLocal":
        await this.app.fileManager.trashFile(this.localFiles.get(path)!);
        delete this.state[path];
        this.result.deletedLocal++;
        break;
      case "deleteRemote":
        await this.drive.trash(this.remoteFiles.get(path)!.id);
        delete this.state[path];
        this.result.deletedRemote++;
        break;
      case "reconcile":
        await this.reconcile(path);
        break;
    }
  }

  private async upload(path: string, knownData?: ArrayBuffer) {
    const file = this.localFiles.get(path)!;
    // Capture stat before reading: if the file changes mid-upload, the next run sees a new mtime.
    const { mtime, size } = file.stat;
    const data = knownData ?? (await this.app.vault.readBinary(file));
    const existing = this.remoteFiles.get(path);
    const uploaded = existing
      ? await this.drive.updateContent(existing.id, basename(path), data)
      : await this.drive.uploadNew(basename(path), await this.ensureRemoteFolder(dirname(path)), data);
    this.state[path] = {
      localHash: await sha256Hex(data),
      localMtime: mtime,
      localSize: size,
      remoteId: uploaded.id,
      remoteVersion: remoteVersion(uploaded),
    };
  }

  private async download(path: string, remote: RemoteFile, knownData?: ArrayBuffer) {
    const data = knownData ?? (await this.drive.download(remote.id));
    await this.writeLocal(path, data);
    const stat = await this.app.vault.adapter.stat(path);
    this.state[path] = {
      localHash: await sha256Hex(data),
      localMtime: stat?.mtime ?? 0,
      localSize: stat?.size ?? data.byteLength,
      remoteId: remote.id,
      remoteVersion: remoteVersion(remote),
    };
  }

  /** Both sides changed (or first sync with both present): keep identical files, otherwise keep both versions. */
  private async reconcile(path: string) {
    const remote = this.remoteFiles.get(path)!;
    const local = this.localFiles.get(path)!;
    const [remoteData, localData] = await Promise.all([this.drive.download(remote.id), this.app.vault.readBinary(local)]);
    const [remoteHash, localHash] = await Promise.all([sha256Hex(remoteData), sha256Hex(localData)]);

    if (remoteHash === localHash) {
      this.state[path] = {
        localHash,
        localMtime: local.stat.mtime,
        localSize: local.stat.size,
        remoteId: remote.id,
        remoteVersion: remoteVersion(remote),
      };
      return;
    }

    // The Drive version is saved beside the note (it uploads on the next sync);
    // the local version wins the original path.
    await this.writeLocal(this.conflictPath(path), remoteData);
    await this.upload(path, localData);
    this.result.conflicts++;
  }

  private conflictPath(path: string): string {
    const dir = dirname(path);
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    const stamp = moment().format("YYYY-MM-DD HHmm");
    for (let i = 1; ; i++) {
      const suffix = i === 1 ? "" : ` ${i}`;
      const candidate = `${dir ? dir + "/" : ""}${stem} (conflict ${stamp}${suffix})${ext}`;
      if (!this.app.vault.getAbstractFileByPath(candidate)) return candidate;
    }
  }

  private async writeLocal(path: string, data: ArrayBuffer) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data);
      return;
    }
    await this.ensureLocalFolder(dirname(path));
    await this.app.vault.createBinary(path, data);
  }

  private async ensureLocalFolder(dir: string): Promise<void> {
    if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
    await this.ensureLocalFolder(dirname(dir));
    try {
      await this.app.vault.createFolder(dir);
    } catch (e) {
      // Another parallel download may have just created it.
      if (!this.app.vault.getAbstractFileByPath(dir)) throw e;
    }
  }

  /** Cached as promises so parallel uploads into a new folder create it only once. */
  private ensureRemoteFolder(dir: string): Promise<string> {
    const cached = this.remoteFolders.get(dir);
    if (cached) return cached;
    const created = (async () => {
      const parentId = await this.ensureRemoteFolder(dirname(dir));
      return this.drive.createFolder(basename(dir), parentId);
    })();
    created.catch(() => this.remoteFolders.delete(dir));
    this.remoteFolders.set(dir, created);
    return created;
  }
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
