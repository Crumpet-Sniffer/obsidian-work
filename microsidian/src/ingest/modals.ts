import { App, Modal, Setting } from "obsidian";
import type { Catalogue } from "../ai/catalogue";
import type { Proposal } from "./proposal";

/** "Send this file to Claude?" with the size and rough cost. */
export function confirmSend(app: App, fileName: string, tokens: number, costUsd: number, model: string): Promise<boolean> {
  return new Promise((resolve) => {
    const m = new (class extends Modal {
      done = false;
      onOpen() {
        this.titleEl.setText("Send to Claude?");
        this.contentEl.createEl("p", { text: `"${fileName}" will be read and filed using ${model}.` });
        this.contentEl.createEl("p", {
          text: `The text of this file and a list of your notes (folders, titles, topics) are sent to the Anthropic API. About ${tokens.toLocaleString()} tokens, roughly $${costUsd.toFixed(3)}.`,
        });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText("Send").setCta().onClick(() => { this.done = true; resolve(true); this.close(); }))
          .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
      }
      onClose() {
        if (!this.done) resolve(false);
        this.contentEl.empty();
      }
    })(app);
    m.open();
  });
}

/** Shows what Claude proposed; the user can edit it, tick/untick items, then accept. */
export function reviewProposal(app: App, fileName: string, proposal: Proposal, cat: Catalogue, note: string): Promise<Proposal | null> {
  return new Promise((resolve) => {
    const p: Proposal = JSON.parse(JSON.stringify(proposal));
    const keepTopic = new Set(p.topics.map((t) => t.name));
    const keepNew = new Set(p.newTopics.map((t) => t.name));
    const keepRel = new Set(p.related.map((r) => r.path));

    const m = new (class extends Modal {
      done = false;
      onOpen() {
        const el = this.contentEl;
        this.titleEl.setText(`File "${fileName}"`);
        el.empty();
        if (note) el.createEl("p", { text: note, cls: "setting-item-description" });

        if (!p.suitable) {
          const w = el.createDiv({ cls: "callout" });
          w.setAttr("data-callout", "warning");
          w.createDiv({ cls: "callout-title", text: "Claude suggests not filing this document" });
          w.createDiv({ cls: "callout-content", text: p.reason });
        } else if (p.reason) el.createEl("p", { text: p.reason, cls: "setting-item-description" });
        for (const w of p.warnings) el.createEl("p", { text: "Note: " + w, cls: "mod-warning" });

        const datalist = el.createEl("datalist", { attr: { id: "microsidian-folder-list" } });
        cat.folders.forEach((f) => datalist.createEl("option", { value: f }));

        new Setting(el).setName("Folder").setDesc("From the vault root. A new name creates a new folder.").addText((t) => {
          t.setValue(p.folderPath).onChange((v) => (p.folderPath = v.split("/").map((s) => s.trim()).filter(Boolean).join("/")));
          t.inputEl.setAttr("list", "microsidian-folder-list");
          t.inputEl.style.width = "100%";
        });

        if (p.topics.length) {
          el.createEl("h4", { text: "Topics to link" });
          for (const t of p.topics)
            new Setting(el).setName(t.name).setDesc(t.phrases.length ? `links: ${t.phrases.join(", ")}` : "listed under Connections only")
              .addToggle((x) => x.setValue(true).onChange((v) => (v ? keepTopic.add(t.name) : keepTopic.delete(t.name))));
        }
        if (p.newTopics.length) {
          el.createEl("h4", { text: "New topics to create" });
          for (const t of p.newTopics)
            new Setting(el).setName(t.name).setDesc(`${t.theme ? t.theme + ": " : ""}${t.definition}`)
              .addToggle((x) => x.setValue(true).onChange((v) => (v ? keepNew.add(t.name) : keepNew.delete(t.name))));
        }
        if (p.related.length) {
          el.createEl("h4", { text: "Related notes" });
          for (const r of p.related)
            new Setting(el).setName(r.path.split("/").pop()!).setDesc(r.reason)
              .addToggle((x) => x.setValue(true).onChange((v) => (v ? keepRel.add(r.path) : keepRel.delete(r.path))));
        }

        new Setting(el)
          .addButton((b) => b.setButtonText(p.suitable ? "File it" : "File it anyway").setCta().onClick(() => {
            this.done = true;
            resolve({
              ...p,
              topics: p.topics.filter((t) => keepTopic.has(t.name)),
              newTopics: p.newTopics.filter((t) => keepNew.has(t.name)),
              related: p.related.filter((r) => keepRel.has(r.path)),
            });
            this.close();
          }))
          .addButton((b) => b.setButtonText("Leave in Ingest").onClick(() => this.close()));
      }
      onClose() {
        if (!this.done) resolve(null);
        this.contentEl.empty();
      }
    })(app);
    m.open();
  });
}
