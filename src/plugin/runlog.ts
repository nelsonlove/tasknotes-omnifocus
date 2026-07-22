import type { App } from "obsidian";

// Persistent per-run log written to the plugin dir. Obsidian Notices auto-dismiss and don't persist,
// so a multi-minute sync leaves no trace of what happened per project. This captures phase-by-phase
// counts + errors to `<pluginDir>/tnof-last-run.log` (overwritten each run) so a failed/partial sync
// is diagnosable after the fact.
export class RunLog {
  private lines: string[] = [];

  constructor(
    private app: App,
    private dir: string,
  ) {}

  line(msg: string): void {
    this.lines.push(msg);
  }

  /** Write the accumulated lines to the log file, prefixed with a header. Returns the vault-relative path. */
  async flush(header: string): Promise<string> {
    const path = `${this.dir}/tnof-last-run.log`;
    const body = `${header}\n${"=".repeat(header.length)}\n\n${this.lines.join("\n")}\n`;
    try {
      await this.app.vault.adapter.write(path, body);
    } catch {
      // Logging must never break a sync.
    }
    return path;
  }
}
