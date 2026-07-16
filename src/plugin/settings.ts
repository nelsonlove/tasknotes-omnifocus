import { App, PluginSettingTab, Setting } from "obsidian";
import type TaskNotesOmniFocusPlugin from "./main.js";

export interface TaskNotesOmnifocusSettings {
  /** Project-note titles (one per synced OmniFocus project). */
  syncedProjects: string[];
  /** Vault tag that opts a task OUT of OmniFocus sync. */
  ignoreTag: string;
  /** Base URL for the TaskNotes API. */
  taskNotesApi: string;
  /** Conflict resolution strategy when both sides changed the same field in a sync. */
  conflict: "vault-canonical" | "of-canonical";
  /** How the OmniFocus task body is treated. */
  bodyPolicy: "create-only" | "of-canonical" | "bidirectional";
  /** What to do when a task leaves scope. */
  desurface: "delete" | "complete";
  /** Priority tag config: enabled flag + level->tag map. */
  priorityTags: {
    enabled: boolean;
    map: { low: string; normal: string; high: string };
  };
  /** Status written when marking a TaskNote done. */
  doneStatus: string;
  /** Status written when reopening a completed TaskNote. */
  reopenStatus: string;
  /** Status values considered completed. */
  completedStatuses: string[];
  /** Optional Bearer token for the TaskNotes API. */
  authToken?: string;
}

export const DEFAULT_SETTINGS: TaskNotesOmnifocusSettings = {
  syncedProjects: [],
  ignoreTag: "omnifocus/ignore",
  taskNotesApi: "http://localhost:8080",
  conflict: "vault-canonical",
  bodyPolicy: "create-only",
  desurface: "delete",
  priorityTags: {
    enabled: true,
    map: {
      low: "priority:low",
      normal: "priority:normal",
      high: "priority:high",
    },
  },
  doneStatus: "done",
  reopenStatus: "open",
  completedStatuses: ["done"],
};

export class SettingTab extends PluginSettingTab {
  plugin: TaskNotesOmniFocusPlugin;

  constructor(app: App, plugin: TaskNotesOmniFocusPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "TaskNotes ⇄ OmniFocus" });

    new Setting(containerEl)
      .setName("TaskNotes API URL")
      .setDesc("Base URL for the TaskNotes MCP server (e.g. http://localhost:8080).")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8080")
          .setValue(this.plugin.settings.taskNotesApi)
          .onChange(async (value) => {
            this.plugin.settings.taskNotesApi = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Ignore tag")
      .setDesc("Tasks carrying this tag will be excluded from OmniFocus sync.")
      .addText((text) =>
        text
          .setPlaceholder("omnifocus/ignore")
          .setValue(this.plugin.settings.ignoreTag)
          .onChange(async (value) => {
            this.plugin.settings.ignoreTag = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Conflict resolution")
      .setDesc("Which side wins when both vault and OmniFocus changed the same field during a sync.")
      .addDropdown((drop) =>
        drop
          .addOption("vault-canonical", "Vault wins")
          .addOption("of-canonical", "OmniFocus wins")
          .setValue(this.plugin.settings.conflict)
          .onChange(async (value) => {
            this.plugin.settings.conflict = value as "vault-canonical" | "of-canonical";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Body policy")
      .setDesc("How to handle the task body/note between vault and OmniFocus.")
      .addDropdown((drop) =>
        drop
          .addOption("create-only", "Create only (never reconcile after first sync)")
          .addOption("of-canonical", "OmniFocus is canonical")
          .addOption("bidirectional", "Bidirectional")
          .setValue(this.plugin.settings.bodyPolicy)
          .onChange(async (value) => {
            this.plugin.settings.bodyPolicy = value as "create-only" | "of-canonical" | "bidirectional";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("De-surface policy")
      .setDesc("What to do to the OmniFocus mirror when a task leaves scope.")
      .addDropdown((drop) =>
        drop
          .addOption("delete", "Delete from OmniFocus")
          .addOption("complete", "Mark complete in OmniFocus")
          .setValue(this.plugin.settings.desurface)
          .onChange(async (value) => {
            this.plugin.settings.desurface = value as "delete" | "complete";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Done status")
      .setDesc("Status written to a TaskNote when it is marked done from OmniFocus.")
      .addText((text) =>
        text
          .setPlaceholder("done")
          .setValue(this.plugin.settings.doneStatus)
          .onChange(async (value) => {
            this.plugin.settings.doneStatus = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Reopen status")
      .setDesc("Status written to a TaskNote when it is reopened from OmniFocus.")
      .addText((text) =>
        text
          .setPlaceholder("open")
          .setValue(this.plugin.settings.reopenStatus)
          .onChange(async (value) => {
            this.plugin.settings.reopenStatus = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Completed statuses")
      .setDesc("Comma-separated list of status values considered 'done'.")
      .addText((text) =>
        text
          .setPlaceholder("done")
          .setValue(this.plugin.settings.completedStatuses.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.completedStatuses = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auth token")
      .setDesc("Optional Bearer token for the TaskNotes API.")
      .addText((text) =>
        text
          .setPlaceholder("(none)")
          .setValue(this.plugin.settings.authToken ?? "")
          .onChange(async (value) => {
            const trimmed = value.trim();
            this.plugin.settings.authToken = trimmed || undefined;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Synced Projects" });
    containerEl.createEl("p", {
      text: "One TaskNotes project-note title per line. Each project's tasks will be synced to a matching OmniFocus project of the same name.",
      cls: "setting-item-description",
    });

    const projectsArea = containerEl.createEl("textarea", {
      cls: "tnof-projects-textarea",
    });
    projectsArea.style.width = "100%";
    projectsArea.style.minHeight = "120px";
    projectsArea.style.fontFamily = "monospace";
    projectsArea.style.fontSize = "12px";
    projectsArea.value = this.plugin.settings.syncedProjects.join("\n");

    projectsArea.addEventListener("blur", async () => {
      this.plugin.settings.syncedProjects = projectsArea.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await this.plugin.saveSettings();
    });
  }
}
