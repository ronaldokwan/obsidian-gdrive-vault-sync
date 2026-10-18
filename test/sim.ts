import { TFile } from "obsidian";
import { SyncEngine, SyncState } from "../src/sync";

const enc = new TextEncoder(), dec = new TextDecoder();
let clock = 1000;

class FakeVault {
  files = new Map<string, { data: ArrayBuffer; file: TFile }>();
  folders = new Set<string>();
  trashed: string[] = [];
  write(path: string, text: string) {
    const data = enc.encode(text).buffer as ArrayBuffer;
    const e = this.files.get(path);
    if (e) { e.data = data; e.file.stat = { mtime: ++clock, size: data.byteLength }; }
    else this.files.set(path, { data, file: new TFile(path, { mtime: ++clock, size: data.byteLength }) });
  }
  read(path: string) { const e = this.files.get(path); return e ? dec.decode(e.data) : undefined; }
  app = {
    vault: {
      getFiles: () => [...this.files.values()].map((e) => e.file),
      readBinary: async (f: TFile) => this.files.get(f.path)!.data,
      modifyBinary: async (f: TFile, d: ArrayBuffer) => this.write(f.path, dec.decode(d)),
      createBinary: async (p: string, d: ArrayBuffer) => { if (this.files.has(p)) throw new Error("exists"); this.write(p, dec.decode(d)); },
      createFolder: async (p: string) => { if (this.folders.has(p)) throw new Error("exists"); this.folders.add(p); },
      getAbstractFileByPath: (p: string) => this.files.get(p)?.file ?? (this.folders.has(p) ? { path: p } : null),
      adapter: { stat: async (p: string) => this.files.get(p)?.file.stat ?? null },
    },
    fileManager: { trashFile: async (f: TFile) => { this.files.delete(f.path); this.trashed.push(f.path); } },
  };
}

class FakeDrive {
  items = new Map<string, any>();
  n = 0;
  private md5(d: ArrayBuffer) { return "h" + dec.decode(d); }
  async findOrCreateRootFolder(name: string) {
    for (const f of this.items.values()) if (f.name === name && f.parents[0] === "root" && !f.trashed) return f.id;
    return this.createFolder(name, "root");
  }
  async createFolder(name: string, parent: string) {
    const id = "id" + ++this.n;
    this.items.set(id, { id, name, mimeType: "application/vnd.google-apps.folder", parents: [parent], modifiedTime: String(++clock) });
    return id;
  }
  async listAll() { return [...this.items.values()].filter((f) => !f.trashed).map((f) => ({ ...f, data: undefined })); }
  async download(id: string) { return this.items.get(id).data as ArrayBuffer; }
  async uploadNew(name: string, parent: string, data: ArrayBuffer) {
    const id = "id" + ++this.n;
    const f = { id, name, mimeType: "text/markdown", parents: [parent], data, md5Checksum: this.md5(data), modifiedTime: String(++clock) };
    this.items.set(id, f);
    return { ...f, data: undefined };
  }
  async updateContent(id: string, _n: string, data: ArrayBuffer) {
    const f = this.items.get(id); f.data = data; f.md5Checksum = this.md5(data); f.modifiedTime = String(++clock);
    return { ...f, data: undefined };
  }
  async trash(id: string) { this.items.get(id).trashed = true; }
  textAt(path: string) {
    const live = [...this.items.values()].filter((f) => !f.trashed);
    const walk = (f: any): string => { const p = live.find((x) => x.id === f.parents[0]); return p && p.parents[0] !== "root" ? walk(p) + "/" + f.name : f.name; };
    const f = live.find((x) => x.data && walk(x) === path);
    return f ? dec.decode(f.data) : undefined;
  }
}

const drive = new FakeDrive();
async function sync(v: FakeVault, state: SyncState, confirm = true) {
  const r = await new SyncEngine(v.app as any, drive as any, state, {
    rootFolderName: "Obsidian - Test", excludePatterns: ["**/*.tmp", "Private"], concurrency: 4,
    confirmMassDelete: async () => confirm, onProgress: () => {},
  }).run();
  if (r.errors.length) throw new Error(r.errors.join("\n"));
  return r;
}
let failures = 0;
function check(label: string, cond: boolean) { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; }

(async () => {
  const A = new FakeVault(), B = new FakeVault();
  const sA: SyncState = {}, sB: SyncState = {};

  A.write("a.md", "hello"); A.write("folder/sub/b.md", "bee"); A.write("x.tmp", "skip"); A.write("Private/secret.md", "s");
  let r = await sync(A, sA);
  check("A first sync uploads 2 (excludes respected)", r.uploaded === 2 && drive.textAt("folder/sub/b.md") === "bee" && drive.textAt("x.tmp") === undefined);

  r = await sync(B, sB);
  check("B first sync downloads both into nested folders", r.downloaded === 2 && B.read("folder/sub/b.md") === "bee");

  r = await sync(A, sA);
  check("no-op sync does nothing", r.uploaded + r.downloaded + r.deletedLocal + r.deletedRemote === 0);

  A.write("a.md", "hello v2");
  B.files.delete("folder/sub/b.md");
  r = await sync(B, sB);
  check("B local delete trashes in Drive", r.deletedRemote === 1 && drive.textAt("folder/sub/b.md") === undefined);
  r = await sync(A, sA);
  check("A uploads edit + trashes b.md locally", r.uploaded === 1 && r.deletedLocal === 1 && !A.files.has("folder/sub/b.md"));
  r = await sync(B, sB);
  check("B downloads A's edit", r.downloaded === 1 && B.read("a.md") === "hello v2");

  // touched but unchanged content should not upload
  A.write("a.md", "hello v2");
  r = await sync(A, sA);
  check("touched-but-identical file is not re-uploaded", r.uploaded === 0);

  A.write("a.md", "from A"); B.write("a.md", "from B");
  await sync(A, sA);
  r = await sync(B, sB);
  const conflict = [...B.files.keys()].find((p) => p.includes("conflict"));
  check("concurrent edit -> conflict copy, nothing lost", r.conflicts === 1 && B.read("a.md") === "from B" && !!conflict && B.read(conflict!) === "from A");
  await sync(B, sB);
  r = await sync(A, sA);
  check("A receives winner + conflict copy", A.read("a.md") === "from B" && A.read(conflict!) === "from A");

  // Edited locally while deleted remotely -> keep & re-upload
  A.write("c.md", "c"); await sync(A, sA); await sync(B, sB);
  B.files.delete("c.md"); await sync(B, sB);
  A.write("c.md", "c edited");
  r = await sync(A, sA);
  check("edit beats remote delete (re-uploaded)", A.read("c.md") === "c edited" && drive.textAt("c.md") === "c edited");

  // Both new with same content on first sync -> no conflict
  const C = new FakeVault(); const sC: SyncState = {};
  C.write("a.md", "from B");
  r = await sync(C, sC);
  check("third device with identical file: no conflict", r.conflicts === 0 && C.read("a.md") === "from B");

  // Safety: remote folder vanishes -> abort, don't delete local notes
  for (const f of drive.items.values()) f.trashed = true;
  let aborted = false;
  try { await sync(A, sA); } catch { aborted = true; }
  check("empty/missing Drive folder aborts instead of deleting local", aborted && A.files.has("a.md"));

  console.log(failures ? `\n${failures} FAILED` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
})();
