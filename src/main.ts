import { App, Modal, moment, Notice, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
  AccessToken,
  buildAuthUrl,
  createPkce,
  exchangeCode,
  extractCode,
  listenForLoopbackCode,
  LoopbackListener,
  randomString,
  refreshAccessToken,
} from "./auth";
import { DriveClient } from "./drive";
import { SyncEngine, SyncResult, SyncState } from "./sync";

interface Settings {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  remoteFolder: string;
  autoSyncMinutes: number;
  syncOnStartup: boolean;
  excludePatterns: string;
}

interface PluginData {
  settings: Settings;
  state: SyncState;
  /** The remote folder `state` belongs to; a mismatch resets state so nothing is wrongly deleted. */
  stateFolder: string;
}

const DEFAULT_SETTINGS: Settings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  remoteFolder: "",
  autoSyncMinutes: 5,
  syncOnStartup: true,
  excludePatterns: "",
};

export default class DriveSyncPlugin extends Plugin {
  settings!: Settings;
  private state: SyncState = {};
  private stateFolder = "";
  private token: AccessToken | null = null;
  private refreshing: Promise<AccessToken> | null = null;
  private syncing = false;
  private autoSyncTimer: number | null = null;
  private statusBar: HTMLElement | null = null;

  async onload() {
    const data = ((await this.loadData()) ?? {}) as Partial<PluginData>;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    if (!this.settings.remoteFolder) this.settings.remoteFolder = `Obsidian - ${this.app.vault.getName()}`;
    this.state = data.state ?? {};
    this.stateFolder = data.stateFolder ?? this.settings.remoteFolder;

    this.addSettingTab(new DriveSyncSettingTab(this.app, this));
    this.statusBar = this.addStatusBarItem();
    this.setStatus(this.settings.refreshToken ? "Drive: idle" : "Drive: signed out");

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => this.sync(true));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(true) });
    this.addCommand({
      id: "reset-sync-state",
      name: "Reset sync state (next sync compares everything, deletes nothing)",
      callback: () => this.resetState(),
    });

    this.scheduleAutoSync();
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.syncOnStartup && this.settings.refreshToken) {
        window.setTimeout(() => this.sync(false), 3000);
      }
    });
  }

  onunload() {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
  }

  async save() {
    const data: PluginData = { settings: this.settings, state: this.state, stateFolder: this.stateFolder };
    await this.saveData(data);
  }

  scheduleAutoSync() {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    this.autoSyncTimer = null;
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.autoSyncTimer = window.setInterval(() => this.sync(false), minutes * 60_000);
      this.registerInterval(this.autoSyncTimer);
    }
  }

  async resetState() {
    this.state = {};
    this.stateFolder = this.settings.remoteFolder;
    await this.save();
    new Notice("Sync state reset. The next sync will merge both sides without deleting anything.");
  }

  async setSignedIn(refreshToken: string, token: AccessToken) {
    this.settings.refreshToken = refreshToken;
    this.token = token;
    // A different account means the stored Drive IDs are meaningless.
    this.state = {};
    this.stateFolder = this.settings.remoteFolder;
    await this.save();
    this.setStatus("Drive: idle");
  }

  async signOut() {
    this.settings.refreshToken = "";
    this.token = null;
    await this.save();
    this.setStatus("Drive: signed out");
  }

  private setStatus(text: string) {
    this.statusBar?.setText(text);
  }

  private async getAccessToken(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }
    if (!this.refreshing) {
      this.refreshing = refreshAccessToken(this.settings, this.settings.refreshToken).finally(() => (this.refreshing = null));
    }
    try {
      this.token = await this.refreshing;
    } catch (e) {
      if (String(e).includes("invalid_grant") || String(e).includes("expired or revoked")) {
        throw new Error("Your Google sign-in expired or was revoked. Sign in again in the plugin settings.");
      }
      throw e;
    }
    return this.token.accessToken;
  }

  async sync(manual: boolean) {
    if (this.syncing) {
      if (manual) new Notice("A sync is already running.");
      return;
    }
    if (!this.settings.clientId || !this.settings.clientSecret || !this.settings.refreshToken) {
      if (manual) new Notice("Google Drive Vault Sync: add your client ID and sign in from the plugin settings first.");
      return;
    }

    if (this.stateFolder !== this.settings.remoteFolder) {
      this.state = {};
      this.stateFolder = this.settings.remoteFolder;
    }

    this.syncing = true;
    this.setStatus("Drive: syncing…");
    try {
      const engine = new SyncEngine(
        this.app,
        new DriveClient((force) => this.getAccessToken(force)),
        this.state,
        {
          rootFolderName: this.settings.remoteFolder,
          excludePatterns: this.settings.excludePatterns.split("\n"),
          concurrency: Platform.isMobile ? 3 : 6,
          confirmMassDelete: (local, remote) => confirm(this.app, massDeleteMessage(local, remote), "Delete"),
          onProgress: (done, total) => this.setStatus(total ? `Drive: syncing ${done}/${total}` : "Drive: syncing…"),
        }
      );
      const result = await engine.run();
      this.report(result, manual);
      this.setStatus(`Drive: synced ${moment().format("HH:mm")}${result.errors.length ? " (with errors)" : ""}`);
    } catch (e) {
      console.error("[gdrive-vault-sync]", e);
      new Notice(`Google Drive sync failed: ${e instanceof Error ? e.message : String(e)}`, 10_000);
      this.setStatus("Drive: sync failed");
    } finally {
      this.syncing = false;
      await this.save();
    }
  }

  private report(r: SyncResult, manual: boolean) {
    const parts = [
      r.uploaded && `${r.uploaded} uploaded`,
      r.downloaded && `${r.downloaded} downloaded`,
      r.deletedLocal && `${r.deletedLocal} deleted locally`,
      r.deletedRemote && `${r.deletedRemote} deleted in Drive`,
      r.conflicts && `${r.conflicts} conflict${r.conflicts > 1 ? "s" : ""} (both versions kept)`,
    ].filter(Boolean);

    if (r.errors.length) {
      new Notice(`Drive sync finished with ${r.errors.length} error(s). First: ${r.errors[0]}`, 10_000);
    } else if (parts.length) {
      new Notice(`Drive sync: ${parts.join(", ")}.`);
    } else if (manual) {
      new Notice("Drive sync: everything is up to date.");
    }
  }
}

function massDeleteMessage(local: number, remote: number): string {
  const parts = [local && `${local} file(s) from this vault`, remote && `${remote} file(s) from Google Drive`].filter(Boolean);
  return `This sync would delete ${parts.join(" and ")}. Deleted files go to the trash. Continue?`;
}

function confirm(app: App, message: string, cta: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const modal = new Modal(app);
    modal.titleEl.setText("Google Drive Vault Sync");
    modal.contentEl.createEl("p", { text: message });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => modal.close()))
      .addButton((b) =>
        b
          .setButtonText(cta)
          .setWarning()
          .onClick(() => {
            answered = true;
            modal.close();
          })
      );
    modal.onClose = () => resolve(answered);
    modal.open();
  });
}

class SignInModal extends Modal {
  private listener: LoopbackListener | null = null;
  private finished = false;

  constructor(app: App, private plugin: DriveSyncPlugin, private onDone: () => void) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    this.titleEl.setText("Sign in to Google Drive");

    const { verifier, challenge } = await createPkce();
    const state = randomString(16);
    const url = buildAuthUrl(this.plugin.settings.clientId, challenge, state);

    this.listener = listenForLoopbackCode(state);
    this.listener?.code.then(
      (code) => this.finish(code, verifier),
      // Port busy or similar: the paste box below still works.
      (e) => console.warn("[gdrive-vault-sync] loopback sign-in unavailable", e)
    );

    contentEl.createEl("p", {
      text: this.listener
        ? "Click the button, approve access in your browser, and this window will finish by itself."
        : "Click the button and approve access. Your browser will then show a page that can't load (127.0.0.1). That's expected: copy the whole address from the address bar and paste it below.",
    });

    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText("Open Google sign-in")
        .setCta()
        .onClick(() => window.open(url))
    );

    let pasted = "";
    new Setting(contentEl)
      .setName(this.listener ? "Didn't finish automatically?" : "Paste the address here")
      .setDesc("Paste the full address of the page Google redirected you to.")
      .addText((t) => t.setPlaceholder("http://127.0.0.1:43821/?state=…&code=…").onChange((v) => (pasted = v)))
      .addButton((b) =>
        b.setButtonText("Finish").onClick(async () => {
          try {
            await this.finish(extractCode(pasted, state), verifier);
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e), 8000);
          }
        })
      );
  }

  private async finish(code: string, verifier: string) {
    if (this.finished) return;
    this.finished = true;
    try {
      const tokens = await exchangeCode(this.plugin.settings, code, verifier);
      await this.plugin.setSignedIn(tokens.refreshToken, tokens);
      new Notice("Signed in to Google Drive.");
      this.close();
      this.onDone();
    } catch (e) {
      this.finished = false;
      new Notice(e instanceof Error ? e.message : String(e), 10_000);
    }
  }

  onClose() {
    this.listener?.close();
    this.contentEl.empty();
  }
}

class DriveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DriveSyncPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Google account").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Uses your own Google Cloud OAuth client (type: Desktop app). See the README for the 5-minute setup.",
    });

    new Setting(containerEl).setName("Client ID").addText((t) =>
      t.setValue(s.clientId).onChange(async (v) => {
        s.clientId = v.trim();
        await this.plugin.save();
      })
    );

    new Setting(containerEl).setName("Client secret").addText((t) => {
      t.inputEl.type = "password";
      t.setValue(s.clientSecret).onChange(async (v) => {
        s.clientSecret = v.trim();
        await this.plugin.save();
      });
    });

    const account = new Setting(containerEl)
      .setName("Status")
      .setDesc(s.refreshToken ? "Signed in." : "Not signed in.");
    if (s.refreshToken) {
      account.addButton((b) =>
        b.setButtonText("Sign out").onClick(async () => {
          await this.plugin.signOut();
          this.display();
        })
      );
    } else {
      account.addButton((b) =>
        b
          .setButtonText("Sign in")
          .setCta()
          .onClick(() => {
            if (!s.clientId || !s.clientSecret) {
              new Notice("Enter the client ID and secret first.");
              return;
            }
            new SignInModal(this.app, this.plugin, () => this.display()).open();
          })
      );
    }

    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Drive folder")
      .setDesc("Folder at the top of your Google Drive that mirrors this vault. Use the same name on every device.")
      .addText((t) =>
        t.setValue(s.remoteFolder).onChange(async (v) => {
          s.remoteFolder = v.trim();
          await this.plugin.save();
        })
      );

    new Setting(containerEl)
      .setName("Auto sync interval")
      .setDesc("Minutes between automatic syncs. 0 turns it off.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.setValue(String(s.autoSyncMinutes)).onChange(async (v) => {
          const n = Number(v);
          s.autoSyncMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.save();
          this.plugin.scheduleAutoSync();
        });
      });

    new Setting(containerEl).setName("Sync on startup").addToggle((t) =>
      t.setValue(s.syncOnStartup).onChange(async (v) => {
        s.syncOnStartup = v;
        await this.plugin.save();
      })
    );

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("One per line. A folder or file path, or a glob like *.mp4 or Archive/**. Lines starting with # are ignored.")
      .addTextArea((t) => {
        t.inputEl.rows = 5;
        t.setPlaceholder("Attachments/large\n**/*.mp4").setValue(s.excludePatterns).onChange(async (v) => {
          s.excludePatterns = v;
          await this.plugin.save();
        });
      });

    new Setting(containerEl)
      .setName("Sync now")
      .addButton((b) => b.setButtonText("Sync").onClick(() => this.plugin.sync(true)));

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc("Forget what was synced before. The next sync merges both sides and deletes nothing. Use after moving or restoring the vault.")
      .addButton((b) => b.setButtonText("Reset").onClick(() => this.plugin.resetState()));
  }
}
