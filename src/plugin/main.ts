import { Notice, Plugin } from "obsidian";
import { SyncStore } from "./store.js";
import { buildReconcileInput, deriveSnapshot } from "./sync.js";
import { executePlan } from "./executor.js";
import { DEFAULT_SETTINGS, SettingTab } from "./settings.js";
import type { TaskNotesOmnifocusSettings } from "./settings.js";
import { filterIgnored, computeDesurfaceIds } from "./projects.js";
import {
  buildHasParentFilter,
  buildHasSubtasksFilter,
  buildProjectNodeInputs,
  computeIgnoredTitles,
  pruneIgnored,
} from "./discovery.js";
import { buildOFTree, flattenFolders, flattenProjects } from "./tree.js";
import { createTaskNotesAdapter } from "../adapters/tasknotes.js";
import { createOmniFocusAdapter, defaultRunOmniJS } from "../adapters/omnifocus.js";
import type { FolderSpec, OFOp, ProjectSpec, ScaffoldResult } from "../adapters/omnifocus.js";
import { reconcile } from "../core/reconcile.js";
import { reconcileProjectMeta } from "../core/reconcileProject.js";
import type { OmniFocusTask, ReconcileConfig, TaskNote } from "../core/types.js";

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
      const ignoreTag = this.settings.ignoreTag;

      // --- 1. Discover the whole TaskNotes project forest in two queries. ---
      const projectNodes = await tasknotes.query(buildHasSubtasksFilter());
      const childTasks = await tasknotes.query(buildHasParentFilter());

      // --- 2. Build the OmniFocus folder/project tree (pure), honoring the ignore blacklist. ---
      const { inputs, leafById } = buildProjectNodeInputs(projectNodes, childTasks);
      const ignored = computeIgnoredTitles(projectNodes, ignoreTag);
      const roots = buildOFTree(pruneIgnored(inputs, ignored));
      const ofFolders = flattenFolders(roots);
      const ofProjects = flattenProjects(roots);

      const folderSpecs: FolderSpec[] = ofFolders.map((f) => ({ path: [...f.path, f.title] }));
      const projectSpecs: ProjectSpec[] = ofProjects.map((p) => ({ title: p.title, folderPath: p.path }));

      // --- 3. Ensure every folder/project exists before reconciling tasks into it. ---
      let scaffold: ScaffoldResult = { createdFolders: [], createdProjects: [], errors: [] };
      if (!dryRun) {
        scaffold = await omnifocus.ensureStructure(folderSpecs, projectSpecs);
      }

      let totalApplied = 0;
      let totalConflicts = 0;
      let totalErrors = scaffold.errors.length;
      const dryRunSummaryLines: string[] = [];

      // Accumulate all member ids across all projects (for de-surface pass)
      const allMemberIds = new Set<string>();
      // Accumulate all OF tasks seen (for de-surface pass)
      const allOfTasks: OmniFocusTask[] = [];

      // --- 4. Reconcile each discovered project's leaf tasks into its same-named OF project. ---
      for (const proj of ofProjects) {
        const leaves = proj.leafTaskIds
          .map((id) => leafById.get(id))
          .filter((t): t is TaskNote => t !== undefined);
        const members = filterIgnored(leaves, ignoreTag);
        members.forEach((m) => allMemberIds.add(m.id));

        // Nothing opted-in here — the (possibly newly-created) project just stays empty.
        if (members.length === 0) continue;

        const ofTasks = await omnifocus.readProject(proj.title);
        allOfTasks.push(...ofTasks);

        const input = buildReconcileInput({
          direction,
          inScopeTasks: members,
          desurfaceTasks: [],
          ofTasks,
          store: this.store,
          config,
          binding: { omnifocusProject: proj.title },
        });

        const plan = reconcile(input);

        if (dryRun) {
          const mutKinds = plan.mutations.map((m) => m.kind);
          const creates = mutKinds.filter((k) => k === "createOFTask").length;
          const updates = mutKinds.filter((k) => k === "updateOFTask" || k === "updateTask").length;
          const deletes = mutKinds.filter((k) => k === "deleteOFTask").length;
          const statuses = mutKinds.filter((k) => k === "setStatus").length;
          const clears = mutKinds.filter((k) => k === "clearLink").length;
          if (plan.mutations.length > 0 || plan.conflicts.length > 0) {
            dryRunSummaryLines.push(
              `[${proj.title}] ${creates} creates, ${updates} updates, ${deletes} deletes, ${statuses} status changes, ${clears} link clears, ${plan.conflicts.length} conflicts`,
            );
          }
        } else {
          const result = await executePlan(plan, {
            omnifocus,
            tasknotes,
            store: this.store,
            project: proj.title,
          });

          totalApplied += result.applied;
          totalErrors += result.errors.length;
          totalConflicts += plan.conflicts.length;

          // Re-snapshot: re-read this project's OF tasks and snapshot each linked member.
          const freshOf = await omnifocus.readProject(proj.title);
          for (const m of members) {
            const pk = this.store.getPrimaryKey(m.id);
            const ot = pk && freshOf.find((o) => o.primaryKey === pk);
            if (ot) {
              this.store.setSnapshot(deriveSnapshot(m, ot, config));
            }
          }
        }
      }

      // --- ENRICH pass: carry each project-node's OWN fields onto its OmniFocus project. ---
      // A task with subtasks maps to an OF project (a container); enrich round-trips its own
      // due/defer/flag/note/completion so it still surfaces. One read + one write spawn total.
      const nodeById = new Map(projectNodes.map((n) => [n.id, n]));
      const enrichNames = ofProjects.map((p) => p.title);
      const metas = await omnifocus.readProjectsMeta(enrichNames);
      const projectOps: OFOp[] = [];
      const enrichSnapshots: { node: TaskNote; name: string }[] = [];
      let enrichVaultWrites = 0;
      let enrichConflicts = 0;

      for (const proj of ofProjects) {
        const nodeTask = nodeById.get(proj.sourceId);
        if (!nodeTask) continue;
        const meta = metas[proj.title];
        if (!meta) continue; // project should exist post-scaffold; skip if not found
        const pk = meta.primaryKey;
        // Keep the node-link out of the de-surface pass (it isn't a leaf "member").
        allMemberIds.add(nodeTask.id);
        if (dryRun) {
          const res = reconcileProjectMeta(nodeTask, meta, this.store.getSnapshot(pk), direction, config);
          enrichConflicts += res.conflicts.length;
          if (Object.keys(res.projectFields).length) projectOps.push({ op: "updateProject", primaryKey: pk, fields: res.projectFields });
          continue;
        }
        this.store.setLink(nodeTask.id, pk);
        const res = reconcileProjectMeta(nodeTask, meta, this.store.getSnapshot(pk), direction, config);
        enrichConflicts += res.conflicts.length;
        if (Object.keys(res.projectFields).length) projectOps.push({ op: "updateProject", primaryKey: pk, fields: res.projectFields });
        if (Object.keys(res.vaultFields).length) {
          try { await tasknotes.update(nodeTask.id, res.vaultFields); enrichVaultWrites++; }
          catch { totalErrors++; }
        }
        if (res.setStatus) {
          try { await tasknotes.setStatus(nodeTask.id, res.setStatus); enrichVaultWrites++; }
          catch { totalErrors++; }
        }
        enrichSnapshots.push({ node: nodeTask, name: proj.title });
      }

      totalConflicts += enrichConflicts;
      if (dryRun) {
        if (projectOps.length || enrichConflicts) {
          dryRunSummaryLines.push(`[enrich] ${projectOps.length} project-field updates, ${enrichConflicts} conflicts`);
        }
      } else {
        if (projectOps.length) {
          const br = await omnifocus.applyBatch(projectOps);
          totalApplied += projectOps.length - br.errors.length;
          totalErrors += br.errors.length;
        }
        totalApplied += enrichVaultWrites;
        // Re-snapshot enriched projects from their fresh meta.
        if (enrichSnapshots.length) {
          const fresh = await omnifocus.readProjectsMeta(enrichSnapshots.map((e) => e.name));
          for (const { node, name } of enrichSnapshots) {
            const fm = fresh[name];
            if (fm) this.store.setSnapshot(deriveSnapshot(node, fm, config));
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

          // Read the candidates' actual OmniFocus mirrors by primaryKey so reconcile can tell a task
          // that merely left scope (mirror present -> delete/complete per policy) from one whose
          // mirror is genuinely gone (absent -> clearLink). allOfTasks only covers projects that had
          // in-scope members this run, so it is not sufficient on its own.
          const desurfacePks = desurfaceIds
            .map((id) => this.store.getPrimaryKey(id))
            .filter((pk): pk is string => pk !== undefined);
          const desurfaceOf = await omnifocus.readTasksByIds(desurfacePks);

          const input = buildReconcileInput({
            direction,
            inScopeTasks: [],
            desurfaceTasks,
            ofTasks: [...allOfTasks, ...Object.values(desurfaceOf)],
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
        const header = `Discovered ${ofProjects.length} projects / ${ofFolders.length} folders (${projectNodes.length} nodes).`;
        const body = dryRunSummaryLines.length ? dryRunSummaryLines.join("\n") : "No task changes.";
        new Notice(`TaskNotes⇄OmniFocus (dry run):\n${header}\n${body}`);
      } else {
        await this.saveData({ settings: this.settings, state: this.store.toJSON() });
        const created = scaffold.createdFolders.length + scaffold.createdProjects.length;
        new Notice(
          `TaskNotes⇄OmniFocus: ${created} folders/projects created, ${totalApplied} applied, ${totalConflicts} conflicts, ${totalErrors} errors`,
        );
      }
    } catch (err) {
      new Notice(`TaskNotes⇄OmniFocus: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
