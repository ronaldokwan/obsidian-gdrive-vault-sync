# Google Drive Vault Sync (Obsidian plugin)

Free two-way sync between your Obsidian vault and a folder in **your own** Google Drive.
It works on Windows, macOS, Linux, Android and iOS. Nothing goes through a third-party server.

- Mirrors the vault's folder structure into `My Drive/Obsidian - <vault name>/`
- Syncs on startup, every N minutes, from the ribbon button, or with the **Sync now** command
- Edits on two devices never overwrite each other: both versions are kept
- Deletions go to the trash on both sides (Obsidian's trash and Drive's 30-day trash)
- Safety checks: the sync stops instead of wiping your notes if the Drive folder disappears, and asks before deleting many files at once

---

## 1. Create your Google OAuth client (one time, ~5 minutes)

You need your own client ID, because Google requires one for apps that use the Drive API. It's free.

1. Go to <https://console.cloud.google.com/> and **create a project** (any name, e.g. "Obsidian Sync").
2. **APIs & Services → Library**: search **Google Drive API** and click **Enable**.
3. **Google Auth Platform → Branding** (older consoles call this the "OAuth consent screen"):
   - App name: anything. Support email: your email.
   - Audience / User type: **External**.
4. **Data Access → Add or remove scopes**: add `https://www.googleapis.com/auth/drive.file` and save.
   This scope only lets the plugin see files it created, not the rest of your Drive.
5. **Audience → Publish app** (set the publishing status to **In production**).
   > ⚠️ Don't skip this. While the app is in "Testing", Google expires your sign-in every **7 days**.
   > `drive.file` is a non-sensitive scope, so publishing doesn't need Google's review.
6. **Clients → Create client** → Application type **Desktop app** → Create.
   Copy the **Client ID** and **Client secret**.

## 2. Install

### With BRAT (easiest, works on phones too)
1. In Obsidian: **Settings → Community plugins → Browse**, search **BRAT**, then **Install** and **Enable**.
2. Open BRAT's settings → **Add beta plugin** → enter `ronaldokwan/obsidian-gdrive-vault-sync` → **Add plugin**.
3. Go to **Settings → Community plugins** and turn on **Google Drive Vault Sync**.

BRAT keeps the plugin up to date when new releases come out.

### Manually
Download `main.js` and `manifest.json` from the [latest release](https://github.com/ronaldokwan/obsidian-gdrive-vault-sync/releases/latest)
(or build them yourself with `npm install && npm run build`) and put them in:

```
<your vault>/.obsidian/plugins/gdrive-vault-sync/
```

Then open Obsidian → **Settings → Community plugins** → turn on **Google Drive Vault Sync**.

## 3. Sign in

Go to **Settings → Google Drive Vault Sync**, paste the client ID and secret, and click **Sign in**.

- **Desktop:** approve in your browser and it finishes by itself.
- **Mobile:** approve, and your browser then lands on a page that can't load (`127.0.0.1…`). That's expected.
  Copy the **whole address** from the address bar, paste it into the box in Obsidian, and tap **Finish**.

If Google shows "Google hasn't verified this app", click **Advanced → Go to (your app)**. It's your own app.

## 4. Add other devices

1. Get the plugin folder (`main.js` + `manifest.json`) onto the other device's vault, at `.obsidian/plugins/gdrive-vault-sync/`.
   On a phone, the easiest way is to create an empty vault, then copy the folder in with a USB cable or a file manager.
2. Enable it, enter the **same client ID/secret**, sign in with the **same Google account**, and keep the **same Drive folder name**.
3. Run **Sync now**. On a device's first sync, files that exist on both sides are compared: identical ones are linked up,
   different ones are kept as both versions. Nothing is deleted on a first sync.

---

## How syncing decides

The plugin remembers each file's state after the last sync, separately on each device. On every sync it compares that state with both sides:

| Local | Drive | Result |
|---|---|---|
| changed | unchanged | upload |
| unchanged | changed | download |
| changed | changed | **conflict**: your local version stays as `note.md`, and the Drive version is saved as `note (conflict 2026-10-18 1742).md` |
| new | missing | upload |
| missing | new | download |
| deleted | unchanged | moved to Drive's trash |
| unchanged | deleted | moved to Obsidian's trash |
| edited | deleted | kept and re-uploaded (an edit wins over a deletion) |

Changes are detected by content hash, so a file that was only "touched" isn't re-uploaded.

## Settings

- **Drive folder**: the top-level Drive folder for this vault. Changing it resets the sync state, so nothing gets deleted.
- **Auto sync interval**: in minutes. Set it to 0 to turn auto sync off.
- **Sync on startup**
- **Excluded paths**: one per line, e.g. `Attachments/big`, `**/*.mp4`, `Archive/**`.
- **Reset sync state**: forgets past syncs. The next sync merges both sides and deletes nothing.
  Use it after restoring a backup or moving the vault.

## Limitations

- **The `.obsidian` folder isn't synced** (plugins, themes, settings), only your notes and attachments.
- **Files you add to the Drive folder through drive.google.com won't be seen.** The `drive.file` scope only shows the plugin
  files it created itself. Add files through Obsidian instead.
- Native Google Docs/Sheets placed in the folder are ignored.
- A rename syncs as a delete plus a new file.
- Sync isn't real-time. It runs on the interval, so sync before switching devices if you need the latest version right away.
- **Don't also sync this vault with another tool** (OneDrive, iCloud, Syncthing, Obsidian Sync). Two sync engines on one folder cause duplicates.

## Development

```bash
npm run dev     # rebuilds main.js on change
npm test        # simulated two-device sync tests against a fake Drive
```

Source: `src/auth.ts` (OAuth with PKCE), `src/drive.ts` (Drive REST client), `src/sync.ts` (sync engine), `src/main.ts` (plugin, settings, UI).
