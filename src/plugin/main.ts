import { Notice, Plugin, requestUrl } from "obsidian";
import { SyncStore } from "./store.js";
import { deriveSnapshot, buildReconcileInput } from "./sync.js";
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
import { buildOFForest, collectFolders, collectProjects, forestToCreateOps } from "./hierarchy.js";
import { validateHierarchyLevels, DEFAULT_HIERARCHY_LEVELS } from "./levels.js";
import type { OFLevelType } from "./levels.js";
import { readOmnifocusUrl, readDescription, readBody, readDeferred, readFlagged, writeOmnifocusUrl, clearOmnifocusUrl } from "./frontmatter.js";
import { RunLog } from "./runlog.js";
import { sanitizeFilename, filterUncaptured, buildCaptureFrontmatter } from "./inbox.js";
import { createTaskNotesAdapter } from "../adapters/tasknotes.js";
import { createOmniFocusAdapter, defaultRunOmniJS } from "../adapters/omnifocus.js";
import type { FolderSpec, OFOp, ProjectSpec } from "../adapters/omnifocus.js";
import type { OFWriteFields } from "../core/types.js";
import { ofWriteFieldsFor, reconcile } from "../core/reconcile.js";
import { reconcileProjectMeta } from "../core/reconcileProject.js";
import { parsePrimaryKey } from "../core/types.js";
import type { ReconcileConfig, TaskNote } from "../core/types.js";

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
      // Exclude the TaskNotes identifier tag (read live from TaskNotes' own settings, since every task
      // carries it) plus any additional user-configured excludeTags.
      excludeTags: [...this.taskNotesMarkerTags(), ...s.excludeTags],
      conflict: s.conflict,
      bodyPolicy: s.bodyPolicy,
      desurface: s.desurface,
      priorityTags: s.priorityTags,
      doneStatus: s.doneStatus,
      reopenStatus: s.reopenStatus,
      obsidianVault: this.app.vault.getName(),
    };
  }

  /**
   * The TaskNotes identifier tag(s) to keep out of OmniFocus — read live from TaskNotes' own settings,
   * so it tracks whatever the user has configured there (e.g. "note/task"). Only applies when TaskNotes
   * identifies tasks by tag; returns [] if identification is by property or TaskNotes isn't present.
   */
  private taskNotesMarkerTags(): string[] {
    const tn = (this.app as unknown as { plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> }> } })
      .plugins?.plugins?.["tasknotes"];
    const st = tn?.settings;
    if (st && st["taskIdentificationMethod"] === "tag" && typeof st["taskTag"] === "string" && st["taskTag"]) {
      return [st["taskTag"] as string];
    }
    return [];
  }

  /**
   * How to make a captured note recognizable as a TaskNote. TaskNotes identifies tasks either by a
   * marker TAG or by a frontmatter PROPERTY (name=value) — read live from its own settings (same access
   * pattern as `taskNotesMarkerTags()`). Returns the marker tag to apply plus, when property-based, the
   * identifying property (name+value) to ALSO set so TaskNotes recognizes the capture. If the plugin is
   * in property mode but its property name can't be determined, `propertyModeUnresolved` is set so the
   * caller can warn; the tag is always set as a best-effort fallback.
   */
  private captureIdentity(): {
    markerTag: string;
    identityProperty: { name: string; value: string } | null;
    propertyModeUnresolved: boolean;
  } {
    const markerTag = this.taskNotesMarkerTags()[0] ?? "note/task";
    const st = (this.app as unknown as { plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> }> } })
      .plugins?.plugins?.["tasknotes"]?.settings;
    if (st && st["taskIdentificationMethod"] === "property") {
      const name = typeof st["taskPropertyName"] === "string" ? (st["taskPropertyName"] as string) : "";
      const value = typeof st["taskPropertyValue"] === "string" ? (st["taskPropertyValue"] as string) : "";
      if (name) return { markerTag, identityProperty: { name, value }, propertyModeUnresolved: false };
      return { markerTag, identityProperty: null, propertyModeUnresolved: true };
    }
    // Tag-based (or TaskNotes absent): the marker tag is the identity.
    return { markerTag, identityProperty: null, propertyModeUnresolved: false };
  }

  async runSync(direction: "push" | "pull" | "sync", { dryRun }: { dryRun: boolean }) {
    const log = new RunLog(this.app, this.manifest.dir ?? ".");
    try {
      const config = this.buildConfig();
      const tasknotes = createTaskNotesAdapter({
        baseUrl: this.settings.taskNotesApi,
        // Use Obsidian's requestUrl (not the browser fetch) — the renderer blocks cross-origin
        // requests to localhost with "Failed to fetch"; requestUrl bypasses CORS.
        fetch: async (u, i) => {
          let res;
          try {
            res = await requestUrl({
              url: u,
              method: i?.method ?? "GET",
              headers: i?.headers,
              body: i?.body,
              throw: false,
            });
          } catch (e) {
            // Connection refused / unreachable — the TaskNotes API server isn't listening.
            throw new Error(
              `TaskNotes API unreachable at ${this.settings.taskNotesApi}. Enable it in TaskNotes → Settings → HTTP API (port ${new URL(this.settings.taskNotesApi).port || "8080"}), and if you just reloaded Obsidian, wait a few seconds for it to start.`,
            );
          }
          return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            json: async () => res.json,
            text: async () => res.text,
          };
        },
        completedStatuses: this.settings.completedStatuses,
        authToken: this.settings.authToken,
      });
      const omnifocus = createOmniFocusAdapter(defaultRunOmniJS);
      const app = this.app;
      const ignoreTag = this.settings.ignoreTag;
      log.line(`direction=${direction} dryRun=${dryRun} vault=${config.obsidianVault}`);

      // Validate the configurable depth→type map; fall back to the default on a bad config.
      let levels: OFLevelType[] = this.settings.hierarchyLevels;
      const lv = validateHierarchyLevels(levels);
      if (!lv.valid) {
        new Notice(`TaskNotes⇄OmniFocus: invalid hierarchy levels (${lv.reason}) — using default.`);
        levels = DEFAULT_HIERARCHY_LEVELS;
      }

      // --- 1. Discover the whole TaskNotes project forest in two queries. ---
      const projectNodes = await tasknotes.query(buildHasSubtasksFilter());
      const childTasks = await tasknotes.query(buildHasParentFilter());
      const { inputs, leafById } = buildProjectNodeInputs(projectNodes, childTasks);
      const pruned = pruneIgnored(inputs, computeIgnoredTitles(projectNodes, ignoreTag));

      // Every in-scope TaskNote (project-nodes + leaves). Enrich each with body/description/omnifocusUrl
      // read directly from Obsidian (the TaskNotes API exposes none of them).
      const taskById = new Map<string, TaskNote>();
      for (const n of projectNodes) taskById.set(n.id, n);
      for (const [id, t] of leafById) taskById.set(id, t);
      for (const t of filterIgnored([...taskById.values()], ignoreTag)) {
        t.description = readDescription(app, t.id);
        t.omnifocusUrl = readOmnifocusUrl(app, t.id);
        t.body = await readBody(app, t.id);
        // `deferred` and `flagged` are TaskNotes userFields the /query API doesn't return — read from
        // the metadata cache (same as description/omnifocusUrl) so reconcile sees the real vault values.
        t.deferred = readDeferred(app, t.id);
        t.flagged = readFlagged(app, t.id);
      }

      // Drop ignored LEAF tasks (pruneIgnored only removes ignored project-node subtrees).
      const isIgnored = (id: string) => (taskById.get(id)?.tags ?? []).includes(ignoreTag);
      const scoped = pruned.map((inp) => ({ ...inp, leafTaskIds: inp.leafTaskIds.filter((id) => !isIgnored(id)) }));

      // --- 2. Map subtree depth → OmniFocus folders / single-action projects / (nested) tasks. ---
      const forest = buildOFForest(scoped, (id) => taskById.get(id)?.title ?? id, levels);
      const folders = collectFolders(forest);
      const projects = collectProjects(forest);
      log.line(`discover: ${projectNodes.length} project-nodes, ${childTasks.length} child-tasks`);
      log.line(`forest: ${folders.length} folders, ${projects.length} projects`);

      if (dryRun) {
        // Read-only preview: reconcile each project (and the enrich pass) WITHOUT mutating anything.
        // No applyBatch/executePlan/writeOmnifocusUrl/tasknotes.update/scaffold — every call below is a read.
        // Work on a SCRATCH store (seeded from persisted state + the frontmatter link bridge) so this.store
        // and data.json stay untouched.
        const scratch = new SyncStore(this.store.toJSON());
        // Bridge frontmatter identity → scratch links, verified against live OF (dangling stamps recreate).
        const stampedPks = [...taskById.values()]
          .map((t) => parsePrimaryKey(t.omnifocusUrl ?? null))
          .filter((pk): pk is string => pk !== null);
        const liveOf = stampedPks.length ? await omnifocus.readTasksByIds(stampedPks) : {};
        for (const [id, t] of taskById) {
          const pk = parsePrimaryKey(t.omnifocusUrl ?? null);
          if (pk && liveOf[pk]) scratch.setLink(id, pk);
        }
        const linkedPk = (id: string) => {
          const pk = parsePrimaryKey(taskById.get(id)?.omnifocusUrl ?? null);
          return pk && liveOf[pk] ? pk : null;
        };

        const lines: string[] = [];
        let creates = 0;
        let updates = 0;
        let deletes = 0;
        let statuses = 0;
        let clears = 0;
        let conflicts = 0;

        for (const proj of projects) {
          const leafIds: string[] = [];
          const collect = (items: import("./hierarchy.js").OFItem[]): void => {
            for (const it of items) {
              if (it.type === "task") leafIds.push(it.sourceId);
              collect(it.children);
            }
          };
          collect(proj.tasks);
          // Unlinked in-scope leaves would be CREATED (new-flow: via the create pass, not reconcile).
          const projCreates = leafIds.filter((id) => taskById.get(id) !== undefined && linkedPk(id) === null).length;
          creates += projCreates;
          // Linked leaves are what reconcile compares (values on existing links).
          const members = leafIds
            .map((id) => taskById.get(id))
            .filter((t): t is TaskNote => t !== undefined && linkedPk(t.id) !== null);
          let pCreates = 0, pUpdates = 0, pDeletes = 0, pStatuses = 0, pClears = 0, pConflicts = 0;
          if (members.length > 0) {
            const ofTasks = await omnifocus.readProject(proj.name);
            const plan = reconcile(
              buildReconcileInput({
                direction,
                inScopeTasks: members,
                desurfaceTasks: [],
                ofTasks,
                store: scratch,
                config,
                binding: { omnifocusProject: proj.name },
              }),
            );
            for (const m of plan.mutations) {
              if (m.kind === "createOFTask") pCreates++;
              else if (m.kind === "updateOFTask" || m.kind === "updateTask") pUpdates++;
              else if (m.kind === "deleteOFTask") pDeletes++;
              else if (m.kind === "setStatus") pStatuses++;
              else if (m.kind === "clearLink") pClears++;
            }
            pConflicts = plan.conflicts.length;
            updates += pUpdates;
            deletes += pDeletes;
            statuses += pStatuses;
            clears += pClears;
            conflicts += pConflicts;
            creates += pCreates;
          }
          if (projCreates + pCreates + pUpdates + pDeletes + pStatuses + pClears + pConflicts > 0) {
            lines.push(
              `[${proj.name}] ${projCreates + pCreates} creates, ${pUpdates} updates, ${pDeletes} deletes, ${pStatuses} status changes, ${pClears} link clears, ${pConflicts} conflicts`,
            );
          }
        }

        // Enrich preview: project-node own-field updates back onto their OF projects.
        const metas = await omnifocus.readProjectsMeta(projects.map((p) => p.name));
        let enrichUpdates = 0;
        let enrichConflicts = 0;
        for (const proj of projects) {
          const node = taskById.get(proj.sourceId);
          if (!node) continue;
          const meta = metas[proj.name];
          if (!meta) continue;
          const res = reconcileProjectMeta(node, meta, scratch.getSnapshot(meta.primaryKey), direction, config);
          if (Object.keys(res.projectFields).length) enrichUpdates++;
          enrichConflicts += res.conflicts.length;
        }
        conflicts += enrichConflicts;
        if (enrichUpdates || enrichConflicts) {
          lines.push(`[enrich] ${enrichUpdates} project-field updates, ${enrichConflicts} conflicts`);
        }

        const header = `Discovered ${projects.length} projects / ${folders.length} folders (${projectNodes.length} nodes). Would create ${creates} tasks, ${updates} updates, ${deletes} deletes, ${statuses} status changes, ${clears} link clears, ${conflicts} conflicts.`;
        const body = lines.length ? lines.join("\n") : "No task changes.";
        log.line(`DRY-RUN preview: ${header}`);
        for (const l of lines) log.line(`  ${l}`);
        await log.flush(`tasknotes-omnifocus dry-run @ ${new Date().toISOString()}`);
        new Notice(`TaskNotes⇄OmniFocus (dry run):\n${header}\n${body}`);
        return;
      }

      // --- 3. Ensure the folder/project skeleton (projects are single-action lists). ---
      const folderSpecs: FolderSpec[] = folders.map((f) => ({ path: [...f.path, f.name] }));
      const projectSpecs: ProjectSpec[] = projects.map((p) => ({
        title: p.name,
        folderPath: p.folderPath,
        singleActionList: true,
      }));
      const scaffold = await omnifocus.ensureStructure(folderSpecs, projectSpecs);
      let created = 0;
      let stamped = 0;
      let errors = scaffold.errors.length;
      log.line(`scaffold: +${scaffold.createdFolders.length} folders, +${scaffold.createdProjects.length} projects, ${scaffold.errors.length} errors`);
      for (const e of scaffold.errors) log.line(`  scaffold ERROR ${e.path}: ${e.message}`);

      const ofUrl = (pk: string) => `omnifocus:///task/${pk}`;
      // A note's omnifocusUrl is only a real link if the OF task STILL EXISTS. Clearing OmniFocus
      // out-of-band leaves dangling stamps; verify against live OF so those get recreated, not skipped.
      const stampedPks = [...taskById.values()]
        .map((t) => parsePrimaryKey(t.omnifocusUrl ?? null))
        .filter((pk): pk is string => pk !== null);
      const liveOf = stampedPks.length ? await omnifocus.readTasksByIds(stampedPks) : {};
      const danglingCount = stampedPks.filter((pk) => !liveOf[pk]).length;
      log.line(`links: ${stampedPks.length} stamped, ${danglingCount} dangling (OF task gone → will recreate)`);
      const linkedPk = (id: string) => {
        const pk = parsePrimaryKey(taskById.get(id)?.omnifocusUrl ?? null);
        return pk && liveOf[pk] ? pk : null;
      };
      // Bridge the frontmatter identity → the store link table (verified-live only), so the reconcile
      // core and executor — which key on the store — operate on the current links.
      for (const [id, t] of taskById) {
        const pk = parsePrimaryKey(t.omnifocusUrl ?? null);
        if (pk && liveOf[pk]) this.store.setLink(id, pk);
      }
      const fieldsFor = (id: string, name: string): OFWriteFields => {
        const t = taskById.get(id);
        if (t) return ofWriteFieldsFor(t, config);
        return { name, note: null, dueDate: null, deferDate: null, plannedDate: null, estimatedMinutes: null, flagged: false, tags: [], completed: false };
      };

      // --- 4. Per project: create the missing (unlinked) tasks nested. Collect the omnifocusUrl stamp
      //        jobs and write them to frontmatter in PARALLEL afterward — sequential stamping of ~1000
      //        notes (one awaited processFrontMatter each) was the dominant push cost. ---
      const createdIds = new Set<string>();
      const stampJobs: Array<{ ref: string; url: string }> = [];
      for (const proj of projects) {
        const ops = forestToCreateOps(proj.name, proj.tasks, fieldsFor, linkedPk);
        if (ops.length === 0) continue;
        const br = await omnifocus.applyBatch(ops);
        errors += br.errors.length;
        const nCreated = Object.keys(br.created).length;
        log.line(
          `[${proj.name}] ops=${ops.length} created=${nCreated} errors=${br.errors.length}` +
            (br.errors.length ? ` :: ${br.errors.slice(0, 3).map((e) => e.message).join("; ")}` : ""),
        );
        for (const [ref, pk] of Object.entries(br.created)) {
          created++;
          createdIds.add(ref);
          this.store.setLink(ref, pk); // so the snapshot step + future syncs resolve the link
          const t = taskById.get(ref);
          if (t) t.omnifocusUrl = ofUrl(pk);
          stampJobs.push({ ref, url: ofUrl(pk) });
        }
      }
      // Stamp omnifocusUrl into frontmatter in parallel (chunked so we don't overwhelm Obsidian).
      const STAMP_CHUNK = 25;
      for (let i = 0; i < stampJobs.length; i += STAMP_CHUNK) {
        const results = await Promise.allSettled(
          stampJobs.slice(i, i + STAMP_CHUNK).map((j) => writeOmnifocusUrl(app, j.ref, j.url)),
        );
        for (const r of results) r.status === "fulfilled" ? stamped++ : errors++;
      }
      // Snapshot just-created tasks in ONE batch read (not per-project) so a later sync detects an
      // OmniFocus-side edit instead of clobbering it — field-reconcile skips created tasks below.
      if (createdIds.size > 0) {
        const createdPks = [...createdIds]
          .map((id) => this.store.getPrimaryKey(id))
          .filter((pk): pk is string => pk != null);
        const createdOf = await omnifocus.readTasksByIds(createdPks);
        for (const id of createdIds) {
          const m = taskById.get(id);
          const pk = this.store.getPrimaryKey(id);
          const ot = pk ? createdOf[pk] : undefined;
          if (m && ot) this.store.setSnapshot(deriveSnapshot(m, ot, config));
        }
      }

      // --- 5. Enrich each project-node's OWN fields onto its OF project; stamp its omnifocusUrl. ---
      const metas = await omnifocus.readProjectsMeta(projects.map((p) => p.name));
      const projectOps: OFOp[] = [];
      const enrichSnaps: { node: TaskNote; name: string }[] = [];
      let enrichVaultWrites = 0;
      for (const proj of projects) {
        const node = taskById.get(proj.sourceId);
        if (!node) continue;
        const meta = metas[proj.name];
        if (!meta) continue;
        const pk = meta.primaryKey;
        if (parsePrimaryKey(node.omnifocusUrl ?? null) !== pk) {
          try {
            await writeOmnifocusUrl(app, node.id, ofUrl(pk));
            node.omnifocusUrl = ofUrl(pk);
            stamped++;
          } catch {
            errors++;
          }
        }
        const res = reconcileProjectMeta(node, meta, this.store.getSnapshot(pk), direction, config);
        if (Object.keys(res.projectFields).length) projectOps.push({ op: "updateProject", primaryKey: pk, fields: res.projectFields });
        if (Object.keys(res.vaultFields).length) {
          try { await tasknotes.update(node.id, res.vaultFields); enrichVaultWrites++; } catch { errors++; }
        }
        if (res.setStatus) {
          try { await tasknotes.setStatus(node.id, res.setStatus); enrichVaultWrites++; } catch { errors++; }
        }
        enrichSnaps.push({ node, name: proj.name });
      }
      if (projectOps.length) {
        const br = await omnifocus.applyBatch(projectOps);
        errors += br.errors.length;
      }
      if (enrichSnaps.length) {
        const fresh = await omnifocus.readProjectsMeta(enrichSnaps.map((e) => e.name));
        for (const { node, name } of enrichSnaps) {
          const fm = fresh[name];
          if (fm) this.store.setSnapshot(deriveSnapshot(node, fm, config));
        }
      }

      // --- 6. Field-reconcile linked LEAF tasks: sync scalar fields (title/due/scheduled/completion/
      //        priority/tags) between vault and OmniFocus per `direction`, matched by omnifocusUrl.
      //        Structure is already built; this reconciles VALUES on existing links (both ways), so an
      //        OmniFocus-side edit flows back to the vault and a vault edit pushes to OmniFocus.
      let fieldApplied = 0;
      let fieldConflicts = 0;
      for (const proj of projects) {
        const memberIds: string[] = [];
        const collect = (items: import("./hierarchy.js").OFItem[]): void => {
          for (const it of items) {
            if (it.type === "task") memberIds.push(it.sourceId);
            collect(it.children);
          }
        };
        collect(proj.tasks);
        const members = memberIds
          .map((id) => taskById.get(id))
          // Skip tasks created THIS run — they were just written from the vault and already snapshotted,
          // so there is nothing to reconcile (and it avoids a per-project readProject on a fresh push).
          .filter((t): t is TaskNote => t !== undefined && linkedPk(t.id) !== null && !createdIds.has(t.id));
        if (members.length === 0) continue;
        const ofTasks = await omnifocus.readProject(proj.name);
        const plan = reconcile(
          buildReconcileInput({
            direction,
            inScopeTasks: members,
            desurfaceTasks: [],
            ofTasks,
            store: this.store,
            config,
            binding: { omnifocusProject: proj.name },
          }),
        );
        if (plan.mutations.length === 0 && plan.conflicts.length === 0) continue;
        const result = await executePlan(plan, { omnifocus, tasknotes, store: this.store, project: proj.name });
        fieldApplied += result.applied;
        fieldConflicts += plan.conflicts.length;
        errors += result.errors.length;
        log.line(`[${proj.name}] field-reconcile: ${result.applied} applied, ${plan.conflicts.length} conflicts, ${result.errors.length} errors`);
        // Re-snapshot only this (changed) project so the next sync has a fresh baseline.
        const fresh = await omnifocus.readProject(proj.name);
        for (const m of members) {
          const pk = this.store.getPrimaryKey(m.id);
          const ot = pk ? fresh.find((o) => o.primaryKey === pk) : undefined;
          if (ot) this.store.setSnapshot(deriveSnapshot(m, ot, config));
        }
      }
      log.line(`field-reconcile TOTAL: ${fieldApplied} applied, ${fieldConflicts} conflicts`);

      // --- 7. Inbox capture: pull OmniFocus INBOX tasks (no containing project) into the vault as new
      //        TaskNotes, in the user-configured destination folder. Runs only on pull/sync and only
      //        when a destination is set. Idempotent: an inbox task already linked from an existing
      //        TaskNote (matched by omnifocusUrl primaryKey) is skipped, so it isn't re-created.
      let captured = 0;
      const inboxDestination = this.settings.inboxDestination;
      if (direction !== "push" && inboxDestination) {
        // Scan the whole vault for already-captured OF links (idempotency guard).
        const capturedPks = new Set<string>();
        for (const f of app.vault.getMarkdownFiles()) {
          const url = app.metadataCache.getFileCache(f)?.frontmatter?.omnifocusUrl;
          const pk = parsePrimaryKey(typeof url === "string" ? url : null);
          if (pk) capturedPks.add(pk);
        }
        const inboxTasks = await omnifocus.readInbox();
        const toCapture = filterUncaptured(inboxTasks, capturedPks);
        log.line(`inbox: ${inboxTasks.length} in OF inbox, ${toCapture.length} uncaptured`);
        const identity = this.captureIdentity();
        if (identity.propertyModeUnresolved) {
          log.line(
            `[inbox-capture] WARNING: TaskNotes uses property-based identification but the identifying property name could not be determined — captured notes may not be recognized as tasks (falling back to tag "${identity.markerTag}").`,
          );
        }

        // Ensure the destination folder exists ONCE before the loop (createFolder throws if it already does).
        if (toCapture.length > 0) {
          try {
            await app.vault.createFolder(inboxDestination);
          } catch {
            // Folder already exists — fine.
          }
        }

        for (const task of toCapture) {
          try {
            // Resolve a unique destination path, appending " 2", " 3", … before ".md" on collision.
            const base = `${inboxDestination}/${sanitizeFilename(task.name)}`;
            let destPath = `${base}.md`;
            let n = 2;
            while (app.vault.getAbstractFileByPath(destPath)) {
              destPath = `${base} ${n}.md`;
              n++;
            }
            const file = await app.vault.create(destPath, "");
            await app.fileManager.processFrontMatter(file, (fm) => {
              Object.assign(
                fm,
                buildCaptureFrontmatter(task, {
                  markerTag: identity.markerTag,
                  doneStatus: this.settings.doneStatus,
                  openStatus: this.settings.reopenStatus,
                }),
              );
              // Property-based TaskNotes recognition: also stamp the identifying property.
              if (identity.identityProperty) fm[identity.identityProperty.name] = identity.identityProperty.value;
              fm.uid = crypto.randomUUID();
            });
            if (task.note) {
              await app.vault.process(file, (c) => c + "\n" + task.note);
            }
            captured++;
            log.line(`[inbox-capture] ${task.name} -> ${destPath}`);
          } catch (e) {
            errors++;
            log.line(`[inbox-capture] ERROR ${task.name}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        log.line(`inbox-capture: ${captured} captured`);
      }

      // --- 8. De-surface pass: tasks that ARE linked (frontmatter omnifocusUrl, bridged into the store)
      //        but are no longer a member of ANY synced project. Their OmniFocus mirror is deleted or
      //        completed per config.desurface, and the store link + stale frontmatter link are cleared.
      //        Runs after the main loop (push/sync effectful; the reconcile core no-ops de-surface on pull).
      let desurfaced = 0;
      // allMemberIds = every in-scope task id: all leaf task ids in the forest PLUS every project-node id.
      const allMemberIds = new Set<string>();
      for (const proj of projects) {
        allMemberIds.add(proj.sourceId); // the project-node's own task id
        const collectMembers = (items: import("./hierarchy.js").OFItem[]): void => {
          for (const it of items) {
            if (it.type === "task") allMemberIds.add(it.sourceId);
            collectMembers(it.children);
          }
        };
        collectMembers(proj.tasks);
      }
      // linkedIds = ids currently linked in the store (frontmatter links bridged in + this-run creates).
      const linkedIds = Object.keys(this.store.toJSON().links);
      const desurfaceIds = computeDesurfaceIds(allMemberIds, linkedIds);
      if (desurfaceIds.length) {
        const desurfaceRaw = await Promise.all(desurfaceIds.map((id) => tasknotes.getById(id)));
        const desurfaceTasks = desurfaceRaw
          .filter((t): t is NonNullable<typeof t> => t !== null)
          .map((t) => ({ ...t, inScope: false }));
        // Read the candidates' actual OF mirrors by primaryKey so reconcile can tell a task that merely
        // left scope (mirror present -> delete/complete) from one whose mirror is gone (absent -> clearLink).
        const desurfacePks = desurfaceIds
          .map((id) => this.store.getPrimaryKey(id))
          .filter((pk): pk is string => pk !== undefined);
        const desurfaceOf = await omnifocus.readTasksByIds(desurfacePks);
        const plan = reconcile(
          buildReconcileInput({
            direction,
            inScopeTasks: [],
            desurfaceTasks,
            ofTasks: Object.values(desurfaceOf),
            store: this.store,
            config,
            binding: { omnifocusProject: "" },
          }),
        );
        const result = await executePlan(plan, { omnifocus, tasknotes, store: this.store, project: "" });
        errors += result.errors.length;
        desurfaced = result.applied;
        // New-model: the executor's clearLink only clears the STORE link. For any de-surfaced id whose
        // link was actually cleared (delete policy, or a missing mirror), remove the stale frontmatter
        // omnifocusUrl too. "complete" policy retains the link, so its frontmatter is (correctly) kept.
        for (const id of desurfaceIds) {
          if (this.store.getPrimaryKey(id) === undefined) {
            try { await clearOmnifocusUrl(app, id); } catch { errors++; }
          }
        }
        log.line(`de-surface: ${desurfaceIds.length} candidates, ${result.applied} applied, ${result.errors.length} errors`);
      }

      await this.saveData({ settings: this.settings, state: this.store.toJSON() });
      log.line(`enrich: ${projectOps.length} project-field updates, ${enrichVaultWrites} vault writes`);
      log.line(`TOTAL: ${created} tasks created, ${stamped} linked, ${errors} errors`);

      // Verification: re-read OF and compare to what we intended, so the log catches "created N but
      // OF has M" (silent non-persistence) without trusting the in-run counters.
      try {
        const verify = await defaultRunOmniJS(
          `(function(){return JSON.stringify({folders:flattenedFolders.length,projects:flattenedProjects.length,tasks:flattenedTasks.length});})();`,
        );
        log.line(`VERIFY OF now: ${verify}`);
      } catch (e) {
        log.line(`VERIFY failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      const logPath = await log.flush(`tasknotes-omnifocus run @ ${new Date().toISOString()}`);
      new Notice(
        `TaskNotes⇄OmniFocus: ${scaffold.createdFolders.length} folders, ${scaffold.createdProjects.length} projects, ${created} tasks, ${stamped} linked, ${fieldApplied} field syncs, ${captured} captured, ${desurfaced} de-surfaced, ${errors} errors.\nLog: ${logPath}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.line(`FATAL: ${msg}`);
      const logPath = await log.flush(`tasknotes-omnifocus run (FAILED) @ ${new Date().toISOString()}`);
      new Notice(`TaskNotes⇄OmniFocus FAILED: ${msg}\nLog: ${logPath}`);
    }
  }
}
