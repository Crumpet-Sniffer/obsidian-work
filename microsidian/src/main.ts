import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { OfficeView } from "./viewer/OfficeView";
import { ConnectionsPanel } from "./panel/ConnectionsPanel";
import { Pairing } from "./pairing";
import { MicrosidianSettings, DEFAULT_SETTINGS } from "./settings";
import { Layout, trimFolder } from "./config";
import { ImageIndex } from "./vault/imageIndex";
import { SyncService } from "./vault/sync";
import { IngestService } from "./ingest/IngestService";
import { MicrosidianSettingTab } from "./settingsTab";
import { OFFICE_EXTENSIONS, VIEW_TYPE_CONNECTIONS, VIEW_TYPE_OFFICE } from "./constants";

export default class Microsidian extends Plugin {
  declare settings: MicrosidianSettings;
  pairing!: Pairing;
  imageIndex!: ImageIndex;
  sync!: SyncService;
  ingest!: IngestService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.pairing = new Pairing(this.app, () => this.layout);
    this.imageIndex = new ImageIndex(this.app, () => this.layout.originals, () => this.persistImageIndex());
    this.imageIndex.load(this.settings.imageIndex);
    this.sync = new SyncService(this);
    this.ingest = new IngestService(this);
    this.addSettingTab(new MicrosidianSettingTab(this.app, this));

    this.registerView(VIEW_TYPE_OFFICE, (leaf) => new OfficeView(leaf, this));
    this.registerExtensions(OFFICE_EXTENSIONS, VIEW_TYPE_OFFICE);
    this.registerView(VIEW_TYPE_CONNECTIONS, (leaf) => new ConnectionsPanel(leaf, this));

    this.addRibbonIcon("network", "Microsidian connections", () => void this.activatePanel());

    this.addCommand({
      id: "open-connections-panel",
      name: "Open connections panel",
      callback: () => void this.activatePanel(),
    });
    this.addCommand({
      id: "open-counterpart",
      name: "Switch between note and original file",
      callback: () => void this.openCounterpart(),
    });
    this.addCommand({
      id: "resync-current",
      name: "Re-sync the note for the open original",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const orig = f ? (OFFICE_EXTENSIONS.includes(f.extension) ? f : this.pairing.originalFor(f)) : null;
        if (!orig) return false;
        if (!checking) void this.sync.syncOriginal(orig, true).then((s) => s === "unchanged" && new Notice("Note is already up to date."));
        return true;
      },
    });
    this.addCommand({
      id: "resync-all",
      name: "Re-sync all notes from their originals",
      callback: () => void this.sync.syncAll(),
    });
    this.addCommand({
      id: "process-ingest",
      name: "Process the Ingest folder now",
      callback: () => {
        const n = this.ingest.scan();
        new Notice(n ? `Processing ${n} file${n === 1 ? "" : "s"}…` : "Nothing is waiting in the Ingest folder.");
      },
    });
    this.addCommand({
      id: "rebuild-image-index",
      name: "Rebuild the image index (template logos)",
      callback: async () => {
        const n = new Notice("Scanning originals for images…", 0);
        await this.imageIndex.rebuild((d, t) => n.setMessage(`Scanning originals… ${d}/${t}`));
        n.hide();
        new Notice("Image index rebuilt.");
      },
    });

    this.app.workspace.onLayoutReady(() => {
      this.pairing.rebuild();
      void this.ingest.ensureFolder();
      this.registerEvent(this.app.vault.on("create", (f) => this.ingest.onCreate(f)));
      this.registerEvent(this.app.metadataCache.on("changed", (f) => this.pairing.index(f)));
      this.registerEvent(this.app.vault.on("modify", (f) => this.sync.schedule(f as TFile)));
      this.registerEvent(this.app.vault.on("delete", (f) => this.pairing.remove(f.path)));
      this.registerEvent(
        this.app.vault.on("rename", (f, oldPath) => {
          this.pairing.remove(oldPath);
          if (f instanceof TFile) this.pairing.index(f);
        }),
      );
    });
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OFFICE);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_CONNECTIONS);
  }

  /** Folder layout from the settings (blank entries fall back to the defaults). */
  get layout(): Layout {
    const s = this.settings;
    return {
      originals: trimFolder(s.originalsFolder) || DEFAULT_SETTINGS.originalsFolder,
      attachments: trimFolder(s.attachmentsFolder) || DEFAULT_SETTINGS.attachmentsFolder,
      topics: trimFolder(s.topicsFolder) || DEFAULT_SETTINGS.topicsFolder,
      topicsIndex: s.topicsIndexNote.trim() || DEFAULT_SETTINGS.topicsIndexNote,
      ingest: trimFolder(s.ingestFolder) || DEFAULT_SETTINGS.ingestFolder,
    };
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
  async persistImageIndex(): Promise<void> {
    this.settings.imageIndex = this.imageIndex.toJSON();
    await this.saveSettings();
  }

  private async activatePanel(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_CONNECTIONS)[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_CONNECTIONS, active: true });
    }
    if (leaf) await workspace.revealLeaf(leaf);
  }

  private async openCounterpart(): Promise<void> {
    const f = this.app.workspace.getActiveFile();
    const other = f ? this.pairing.counterpart(f) : null;
    if (!other) {
      new Notice("No paired note or original found for this file.");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(other);
  }
}
