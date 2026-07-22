import { App, PluginSettingTab, Setting } from "obsidian";
import type TaskNotesOmniFocusPlugin from "./main.js";

export interface TaskNotesOmnifocusSettings {
  /** Vault tag that opts a task (or a project subtree) OUT of OmniFocus sync. */
  ignoreTag: string;
  /** Tags never mirrored to OmniFocus (e.g. the TaskNotes marker tag "task" that everything carries). */
  excludeTags: string[];
  /** Depth→type map: hierarchyLevels[depth] ∈ {folder,project,task}; deeper → task. See levels.ts. */
  hierarchyLevels: ("folder" | "project" | "task")[];
  /** Base URL for the TaskNotes API. */
  taskNotesApi: string;
  /** Conflict resolution strategy when both sides changed the same field in a sync. */
  conflict: "vault-canonical" | "of-canonical" | "flag-and-hold";
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
  /** Vault folder where OmniFocus inbox tasks are captured as new TaskNotes. Blank = disabled. */
  inboxDestination: string;
}

export const DEFAULT_SETTINGS: TaskNotesOmnifocusSettings = {
  ignoreTag: "omnifocus/ignore",
  // The TaskNotes identifier tag is read live from TaskNotes' own settings (see main.ts buildConfig);
  // this list is only for ADDITIONAL tags the user wants kept out of OmniFocus.
  excludeTags: [],
  hierarchyLevels: ["folder", "project", "task"],
  taskNotesApi: "http://localhost:8080",
  conflict: "vault-canonical",
  bodyPolicy: "create-only",
  // "complete" (not "delete") by default: when a task leaves scope (ignored/archived/moved out),
  // mark its OmniFocus mirror done rather than destroying it — reversible, never loses OF-side data.
  desurface: "complete",
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
  inboxDestination: "",
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
      .setDesc("What happens when both vault and OmniFocus changed the same field during a sync.")
      .addDropdown((drop) =>
        drop
          .addOption("vault-canonical", "Vault wins")
          .addOption("of-canonical", "OmniFocus wins")
          .addOption("flag-and-hold", "Flag & hold (leave both, report conflict)")
          .setValue(this.plugin.settings.conflict)
          .onChange(async (value) => {
            this.plugin.settings.conflict = value as "vault-canonical" | "of-canonical" | "flag-and-hold";
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

    new Setting(containerEl)
      .setName("Inbox capture folder")
      .setDesc(
        "Vault folder where OmniFocus inbox tasks are captured as new TaskNotes. Blank = disabled. Only runs on pull/sync.",
      )
      .addText((text) =>
        text
          .setPlaceholder("(disabled)")
          .setValue(this.plugin.settings.inboxDestination)
          .onChange(async (value) => {
            this.plugin.settings.inboxDestination = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Scope" });
    containerEl.createEl("p", {
      text: "The whole TaskNotes project hierarchy is synced automatically: nested projects become OmniFocus folders/projects, and each project's tasks sync into it. To exclude a project and its entire subtree, add the ignore tag (above) to that project note.",
      cls: "setting-item-description",
    });
  }
}
