import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS = "id,name,mimeType,parents,md5Checksum,modifiedTime,size";
// Above this size, uploads use the resumable protocol instead of a single request.
const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
const MAX_ATTEMPTS = 5;

export interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  md5Checksum?: string;
  modifiedTime: string;
  size?: string;
}

export class DriveError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  canvas: "application/json",
  css: "text/css",
  csv: "text/csv",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

function mimeFor(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function buildMultipart(boundary: string, metadata: object, data: ArrayBuffer, mime: string): ArrayBuffer {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.byteLength + data.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(new Uint8Array(data), head.byteLength);
  body.set(tail, head.byteLength + data.byteLength);
  return body.buffer;
}

export class DriveClient {
  constructor(private getAccessToken: (forceRefresh: boolean) => Promise<string>) {}

  /** Adds auth, refreshes the token once on 401, and backs off on rate limits / 5xx. */
  private async request(params: RequestUrlParam): Promise<RequestUrlResponse> {
    let forceRefresh = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const token = await this.getAccessToken(forceRefresh);
      const res = await requestUrl({
        ...params,
        headers: { ...params.headers, Authorization: `Bearer ${token}` },
        throw: false,
      });
      if (res.status < 400) return res;

      if (res.status === 401 && !forceRefresh) {
        forceRefresh = true;
        continue;
      }
      const rateLimited = res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(res.text);
      if (res.status === 429 || res.status >= 500 || rateLimited) {
        forceRefresh = false;
        await sleep(2 ** attempt * 1000 + Math.random() * 500);
        continue;
      }
      throw new DriveError(res.status, `Drive ${params.method ?? "GET"} failed (${res.status}): ${res.text}`);
    }
    throw new Error(`Drive request kept failing after ${MAX_ATTEMPTS} attempts.`);
  }

  async findOrCreateRootFolder(name: string): Promise<string> {
    const q = `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
    const res = await this.request({
      url: `${API}/files?${new URLSearchParams({ q, fields: "files(id)", spaces: "drive" })}`,
    });
    const existing = res.json.files?.[0];
    if (existing) return existing.id;
    return this.createFolder(name, "root");
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const res = await this.request({
      url: `${API}/files?fields=id`,
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return res.json.id;
  }

  /** Every non-trashed file this app can see (with drive.file, only ones it created). */
  async listAll(): Promise<RemoteFile[]> {
    const files: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: "trashed = false",
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        pageSize: "1000",
        spaces: "drive",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.request({ url: `${API}/files?${params}` });
      files.push(...res.json.files);
      pageToken = res.json.nextPageToken;
    } while (pageToken);
    return files;
  }

  async download(id: string): Promise<ArrayBuffer> {
    const res = await this.request({ url: `${API}/files/${id}?alt=media` });
    return res.arrayBuffer;
  }

  async uploadNew(name: string, parentId: string, data: ArrayBuffer): Promise<RemoteFile> {
    const mime = mimeFor(name);
    const metadata = { name, parents: [parentId], mimeType: mime };
    if (data.byteLength > SIMPLE_UPLOAD_LIMIT) {
      return this.resumableUpload(`${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`, "POST", metadata, data, mime);
    }
    const boundary = `gdvs-${crypto.getRandomValues(new Uint32Array(2)).join("")}`;
    const res = await this.request({
      url: `${UPLOAD_API}/files?uploadType=multipart&fields=${FILE_FIELDS}`,
      method: "POST",
      contentType: `multipart/related; boundary=${boundary}`,
      body: buildMultipart(boundary, metadata, data, mime),
    });
    return res.json;
  }

  async updateContent(id: string, name: string, data: ArrayBuffer): Promise<RemoteFile> {
    const mime = mimeFor(name);
    if (data.byteLength > SIMPLE_UPLOAD_LIMIT) {
      return this.resumableUpload(`${UPLOAD_API}/files/${id}?uploadType=resumable&fields=${FILE_FIELDS}`, "PATCH", {}, data, mime);
    }
    const res = await this.request({
      url: `${UPLOAD_API}/files/${id}?uploadType=media&fields=${FILE_FIELDS}`,
      method: "PATCH",
      contentType: mime,
      body: data,
    });
    return res.json;
  }

  private async resumableUpload(url: string, method: string, metadata: object, data: ArrayBuffer, mime: string): Promise<RemoteFile> {
    const session = await this.request({
      url,
      method,
      contentType: "application/json; charset=UTF-8",
      headers: { "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(data.byteLength) },
      body: JSON.stringify(metadata),
    });
    const location = header(session.headers, "location");
    if (!location) throw new Error("Drive did not return an upload session URL.");
    const res = await this.request({ url: location, method: "PUT", contentType: mime, body: data });
    return res.json;
  }

  /** Moves to Drive's trash (recoverable for 30 days) rather than deleting. */
  async trash(id: string): Promise<void> {
    await this.request({
      url: `${API}/files/${id}?fields=id`,
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    });
  }
}
