import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type Microsidian from "./main";
import { MODEL, apiKey } from "./ai/analyse";
import type { MicrosidianSettings } from "./settings";

type TextKey = "ingestFolder" | "originalsFolder" | "attachmentsFolder" | "topicsFolder" | "topicsIndexNote";

export class MicrosidianSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: Microsidian) {
    super(app, plugin);
  }

  private text(el: HTMLElement, key: TextKey, name: string, desc: string): void {
    const s: MicrosidianSettings = this.plugin.settings;
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((t) =>
        t.setValue(s[key]).onChange(async (v) => {
          s[key] = v.trim();
          await this.plugin.saveSettings();
        }),
      );
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Filing new documents with Claude" });

    new Setting(containerEl)
      .setName("Anthropic API key")
      .setDesc(
        "Stored in Obsidian's secret storage, never in the vault or in this plugin's settings file. " +
          (apiKey(this.plugin) ? "A key is set." : "No key is set yet: choose or create a secret here."),
      )
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(s.apiKeySecretId).onChange(async (id) => {
          if (id) {
            s.apiKeySecretId = id;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl).setName("Model").setDesc(`${MODEL} (fixed). Only the text of the document you drop in, plus a list of your notes (folders, titles, topics), is sent.`);

    new Setting(containerEl)
      .setName("Thinking effort")
      .setDesc("Higher is slower and costs more. Medium is enough for filing.")
      .addDropdown((d) =>
        d.addOption("low", "Low").addOption("medium", "Medium").addOption("high", "High").setValue(s.effort).onChange(async (v) => {
          s.effort = v as typeof s.effort;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Your filing guidance")
      .setDesc(
        "Plain-language rules added to Claude's instructions, for example: " +
          '"This vault holds my chemistry course. Do not file worksheets or answer sheets." or "Put every client document under Clients/<client name>."',
      )
      .addTextArea((t) => {
        t.setValue(s.guidance).onChange(async (v) => {
          s.guidance = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 5;
        t.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("File without asking")
      .setDesc("Skip the confirmation and review windows. Documents that your guidance says not to file stay in the Ingest folder.")
      .addToggle((t) =>
        t.setValue(s.autoAcceptIngest).onChange(async (v) => {
          s.autoAcceptIngest = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Process waiting files now").addButton((b) =>
      b.setButtonText("Process Ingest folder").onClick(() => {
        const n = this.plugin.ingest.scan();
        new Notice(n ? `Processing ${n} file${n === 1 ? "" : "s"}…` : "Nothing is waiting in the Ingest folder.");
      }),
    );

    containerEl.createEl("h3", { text: "Folders" });
    containerEl.createEl("p", {
      text: "Changing a name does not move existing files. Move them yourself in Obsidian, then update the name here.",
      cls: "setting-item-description",
    });
    this.text(containerEl, "ingestFolder", "Ingest folder", "Drop a .docx or .pptx here to have it converted, filed and linked.");
    this.text(containerEl, "originalsFolder", "Originals folder", "Where the original Word and PowerPoint files are kept. It mirrors the folders your notes are in.");
    this.text(containerEl, "attachmentsFolder", "Images folder", "Where images taken from documents are saved.");
    this.text(containerEl, "topicsFolder", "Topics folder", "One note per concept, listing every note that covers it. Created when the first topic is added.");
    this.text(containerEl, "topicsIndexNote", "Topics index note", "Optional. A note listing all topics; updated when it exists.");

    new Setting(containerEl)
      .setName("Update folder index notes")
      .setDesc('When a note is filed under a top-level folder "X" and a note called "X - Index" exists, add the new note to it.')
      .addToggle((t) =>
        t.setValue(s.updateFolderIndexes).onChange(async (v) => {
          s.updateFolderIndexes = v;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "Notes and originals" });

    new Setting(containerEl)
      .setName("Update a note when its original changes")
      .setDesc(
        "When you edit and save a Word or PowerPoint file in the originals folder, its note is re-converted. " +
          "The Connections section and topic links are kept, but changes you typed into the converted text are replaced.",
      )
      .addToggle((t) =>
        t.setValue(s.autoSyncOnModify).onChange(async (v) => {
          s.autoSyncOnModify = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Smallest image to embed (KB)")
      .setDesc("Smaller images are usually bullets, icons or logos.")
      .addSlider((sl) =>
        sl.setLimits(0, 200, 5).setValue(s.imageMinKB).setDynamicTooltip().onChange(async (v) => {
          s.imageMinKB = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Re-sync every note")
      .setDesc("Re-convert all notes from their originals (keeps Connections and topic links).")
      .addButton((b) => b.setButtonText("Re-sync all").onClick(() => void this.plugin.sync.syncAll()));

    new Setting(containerEl)
      .setName("Rebuild the image index")
      .setDesc("Finds template logos that repeat across files so they are not embedded.")
      .addButton((b) =>
        b.setButtonText("Rebuild").onClick(async () => {
          const n = new Notice("Scanning originals…", 0);
          await this.plugin.imageIndex.rebuild((d, t) => n.setMessage(`Scanning originals… ${d}/${t}`));
          n.hide();
          new Notice("Image index rebuilt.");
        }),
      );
  }
}
