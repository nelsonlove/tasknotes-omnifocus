import { Notice, Plugin } from "obsidian";
import { SyncStore } from "./store.js";
import { buildReconcileInput, deriveSnapshot } from "./sync.js";
import { executePlan } from "./executor.js";
import { DEFAULT_SETTINGS, SettingTab } from "./settings.js";
import type { TaskNotesOmnifocusSettings } from "./settings.js";
import { buildProjectMembershipFilter, filterIgnored, computeDesurfaceIds } from "./projects.js";
import { createTaskNotesAdapter } from "../adapters/tasknotes.js";
import { createOmniFocusAdapter, defaultRunOmniJS } from "../adapters/omnifocus.js";
import { reconcile } from "../core/reconcile.js";
import type { ReconcileConfig } from "../core/types.js";

export default class TaskNotesOmniFocusPlugin extends Plugin {
  declare settings: TaskNotesOmnifocusSettings;
  store!: SyncStore;

  async onload() {
    const data = (await this.loadData()) as { settings?: Partial<TaskNotesOmnifocusSettings>; state?: unknown } | null;

    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
    this.store = new SyncStore(
      (data?.state as import("./store.js").PersistedState | undefined) ?? undefined,
    );

    this.addCommand({
      id: "tnof-push",
      name: "Push vault → OmniFocus",
      callback: () => this.runSync("push", { dryRun: false }),
    });

    this.addCommand({
      id: "tnof-pull",
      name: "Pull OmniFocus → vault",
      callback: () => this.runSync("pull", { dryRun: false }),
    });

    this.addCommand({
      id: "tnof-sync",
      name: "Sync (bidirectional)",
      callback: () => this.runSync("sync", { dryRun: false }),
    });

    this.addCommand({
      id: "tnof-dry-run",
      name: "Dry-run sync (preview only)",
      callback: () => this.runSync("sync", { dryRun: true }),
    });

    this.addSettingTab(new SettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData({ settings: this.settings, state: this.store.toJSON() });
  }

  private buildConfig(): ReconcileConfig {
    const s = this.settings;
    return {
      optInTag: s.ignoreTag, // ignoreTag is the per-task opt-out; optInTag in ReconcileConfig is not used for filtering here
      conflict: s.conflict,
      bodyPolicy: s.bodyPolicy,
      desurface: s.desurface,
      priorityTags: s.priorityTags,
      doneStatus: s.doneStatus,
      reopenStatus: s.reopenStatus,
    };
  }

  async runSync(direction: "push" | "pull" | "sync", { dryRun }: { dryRun: boolean }) {
    try {
      const config = this.buildConfig();
      const tasknotes = createTaskNotesAdapter({
        baseUrl: this.settings.taskNotesApi,
        fetch: (u, i) => fetch(u, i as RequestInit),
        completedStatuses: this.settings.completedStatuses,
        authToken: this.settings.authToken,
      });
      const omnifocus = createOmniFocusAdapter(defaultRunOmniJS);

      let totalApplied = 0;
      let totalConflicts = 0;
      let totalErrors = 0;
      const dryRunSummaryLines: string[] = [];

      // Accumulate all member ids across all projects (for de-surface pass)
      const allMemberIds = new Set<string>();
      // Accumulate all OF tasks seen (for de-surface pass)
      const allOfTasks = [];

      // Per-project sync pass
      for (const project of this.settings.syncedProjects) {
        // Query members of this project, filtered by ignore tag
        let members = await tasknotes.query(buildProjectMembershipFilter(project));
        members = filterIgnored(members, this.settings.ignoreTag);
        members.forEach((m) => allMemberIds.add(m.id));

        // Read OmniFocus project tasks
        const ofTasks = await omnifocus.readProject(project);
        allOfTasks.push(...ofTasks);

        // Build reconcile input
        const input = buildReconcileInput({
          direction,
          inScopeTasks: members,
          desurfaceTasks: [],
          ofTasks,
          store: this.store,
          config,
          binding: { omnifocusProject: project },
        });

        const plan = reconcile(input);

        if (dryRun) {
          const mutKinds = plan.mutations.map((m) => m.kind);
          const creates = mutKinds.filter((k) => k === "createOFTask").length;
          const updates = mutKinds.filter((k) => k === "updateOFTask" || k === "updateTask").length;
          const deletes = mutKinds.filter((k) => k === "deleteOFTask").length;
          const statuses = mutKinds.filter((k) => k === "setStatus").length;
          const clears = mutKinds.filter((k) => k === "clearLink").length;
          dryRunSummaryLines.push(
            `[${project}] ${creates} creates, ${updates} updates, ${deletes} deletes, ${statuses} status changes, ${clears} link clears, ${plan.conflicts.length} conflicts`,
          );
        } else {
          const result = await executePlan(plan, {
            omnifocus,
            tasknotes,
            store: this.store,
            project,
          });

          totalApplied += result.applied;
          totalErrors += result.errors.length;
          totalConflicts += plan.conflicts.length;

          // Re-snapshot: re-read this project's members + OF tasks
          const freshMembers = filterIgnored(
            await tasknotes.query(buildProjectMembershipFilter(project)),
            this.settings.ignoreTag,
          );
          const freshOf = await omnifocus.readProject(project);
          for (const m of freshMembers) {
            const pk = this.store.getPrimaryKey(m.id);
            const ot = pk && freshOf.find((o) => o.primaryKey === pk);
            if (ot) {
              this.store.setSnapshot(deriveSnapshot(m, ot, config));
            }
          }
        }
      }

      // De-surface pass: tasks that are linked but no longer in any synced project
      if (!dryRun) {
        const linkedIds = Object.keys(this.store.toJSON().links);
        const desurfaceIds = computeDesurfaceIds(allMemberIds, linkedIds);
        if (desurfaceIds.length) {
          const desurfaceTasksRaw = await Promise.all(desurfaceIds.map((id) => tasknotes.getById(id)));
          const desurfaceTasks = desurfaceTasksRaw
            .filter((t): t is NonNullable<typeof t> => t !== null)
            .map((t) => ({ ...t, inScope: false }));

          const input = buildReconcileInput({
            direction,
            inScopeTasks: [],
            desurfaceTasks,
            ofTasks: allOfTasks,
            store: this.store,
            config,
            binding: { omnifocusProject: "" },
          });
          const result = await executePlan(reconcile(input), {
            omnifocus,
            tasknotes,
            store: this.store,
            project: "",
          });
          totalApplied += result.applied;
          totalErrors += result.errors.length;
        }
      }

      if (dryRun) {
        const summary = dryRunSummaryLines.length
          ? dryRunSummaryLines.join("\n")
          : "No synced projects configured.";
        new Notice(`TaskNotes⇄OmniFocus (dry run):\n${summary}`);
      } else {
        await this.saveData({ settings: this.settings, state: this.store.toJSON() });
        new Notice(
          `TaskNotes⇄OmniFocus: ${totalApplied} applied, ${totalConflicts} conflicts, ${totalErrors} errors`,
        );
      }
    } catch (err) {
      new Notice(`TaskNotes⇄OmniFocus: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
