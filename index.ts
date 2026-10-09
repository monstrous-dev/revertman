/**
 * Revert Extension
 *
 * Snapshots file state before each assistant turn (via git stash create)
 * and provides a `/revert` command that lets you pick an earlier user message,
 * undo all file changes since then, and rewind the conversation tree.
 *
 * Requirements:
 *   - The project must be a git repository
 *   - Changes should be committed or at least trackable by git
 *
 * Usage:
 *   /revert           Pick a user message to revert to (files + conversation)
 *   /revert-snapshots Show stored snapshots (debug)
 *
 * How it works:
 *   1. Before each agent turn, creates a git stash ref of the working tree
 *   2. On /revert, shows a list of user messages with snapshot status
 *   3. Restores files by doing git reset --hard + git stash apply <ref>
 *   4. Navigates the session tree back to before the selected message
 */

import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────

interface Snapshot {
	/** Git stash ref (from git stash create) */
	ref: string;
	/** HEAD commit hash at snapshot time */
	head: string;
}

// ── State ────────────────────────────────────────────────────

/** Maps user message entry ID → git snapshot data */
const snapshots = new Map<string, Snapshot>();

// ── Git helpers ──────────────────────────────────────────────

async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	try {
		const r = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd, timeout: 3000 });
		return r.code === 0;
	} catch {
		return false;
	}
}

async function getHeadCommit(pi: ExtensionAPI, cwd: string): Promise<string> {
	const { stdout, code } = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 3000 });
	return code === 0 ? stdout.trim() : "";
}

/**
 * Create a stash ref without applying it. Returns undefined if there's
 * nothing to stash (clean working tree).
 */
async function createStashRef(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const { stdout, code } = await pi.exec("git", ["stash", "create"], { cwd, timeout: 5000 });
	if (code !== 0) return undefined;
	const ref = stdout.trim();
	return ref.length > 0 ? ref : undefined;
}

/** Restore files to the snapshot state */
async function restoreToSnapshot(
	pi: ExtensionAPI,
	cwd: string,
	snapshot: Snapshot,
): Promise<{ success: boolean; message: string }> {
	// Step 1: Reset to the HEAD commit from snapshot time
	let { code, stderr } = await pi.exec("git", ["reset", "--hard", snapshot.head], { cwd, timeout: 5000 });
	if (code !== 0) {
		return { success: false, message: `git reset --hard failed: ${stderr.trim()}` };
	}

	// Step 2: Apply the stash to restore any uncommitted changes
	({ code, stderr } = await pi.exec("git", ["stash", "apply", snapshot.ref], { cwd, timeout: 10000 }));
	if (code !== 0) {
		// Stash apply might fail if there are conflicts, but reset already succeeded
		return {
			success: false,
			message: `Files reset to commit but stash apply failed: ${stderr.trim()}`,
		};
	}

	return { success: true, message: "Files restored to snapshot state" };
}

// ── Session helpers ──────────────────────────────────────────

interface UserMessageInfo {
	entryId: string;
	text: string;
	timestamp: string;
}

/**
 * Find user messages on the current branch, ordered most-recent-first.
 * Skips the very last user message (the current prompt that triggered the agent).
 */
function findRevertibleUserMessages(
	branch: SessionEntry[],
	currentLeafId: string | undefined,
): UserMessageInfo[] {
	const results: UserMessageInfo[] = [];
	const leafId = currentLeafId;

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;
		if (entry.message.role !== "user") continue;

		// Skip the current leaf user message (the one that just triggered the agent)
		if (leafId && entry.id === leafId) continue;

		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");

		const preview = text.length > 120 ? text.slice(0, 120) + "…" : text;
		results.push({
			entryId: entry.id,
			text: preview,
			timestamp: entry.timestamp,
		});
	}

	return results;
}

// ── Extension ────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let cwd = "";
	let gitAvailable = false;

	// ── Lifecycle ────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		snapshots.clear();
		gitAvailable = await isGitRepo(pi, cwd);
	});

	pi.on("session_shutdown", async () => {
		snapshots.clear();
	});

	// ── Snapshot creation ────────────────────────────────────
	//
	// We snapshot at the start of each agent turn, before the LLM
	// makes any file changes. The snapshot is keyed to the user
	// message that triggered the turn.

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!gitAvailable) return;

		// Find the last user message on the branch — that's the trigger
		const branch = ctx.sessionManager.getBranch();
		let lastUserEntryId: string | undefined;
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i].type === "message" && branch[i].message.role === "user") {
				lastUserEntryId = branch[i].id;
				break;
			}
		}
		if (!lastUserEntryId) return;

		// Only snapshot if we haven't already for this message
		if (snapshots.has(lastUserEntryId)) return;

		// Capture HEAD and stash ref
		const head = await getHeadCommit(pi, cwd);
		const ref = await createStashRef(pi, cwd);

		if (ref) {
			// There were uncommitted changes — store both ref and head
			snapshots.set(lastUserEntryId, { ref, head });
		} else if (head) {
			// Clean working tree — we can restore by just resetting to HEAD
			// Store a synthetic snapshot with ref = head
			snapshots.set(lastUserEntryId, { ref: head, head });
		}

		// Update status
		if (ctx.hasUI && snapshots.size > 0) {
			ctx.ui.setStatus("revert", `📦 ${snapshots.size} revert snapshot(s) | /revert`);
		}
	});

	// ── /revert command ──────────────────────────────────────

	pi.registerCommand("revert", {
		description: "Revert to an earlier user message, undoing all file changes since then",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/revert requires interactive mode", "error");
				return;
			}

			// Wait for any in-progress agent work to finish
			await ctx.waitForIdle();

			if (!gitAvailable) {
				// Re-check in case git was initialized mid-session
				gitAvailable = await isGitRepo(pi, ctx.cwd);
				if (!gitAvailable) {
					ctx.ui.notify("Not a git repository — /revert requires git", "error");
					return;
				}
			}

			const branch = ctx.sessionManager.getBranch();
			const leafId = ctx.sessionManager.getLeafId();
			const userMessages = findRevertibleUserMessages(branch, leafId);

			if (userMessages.length === 0) {
				ctx.ui.notify("No earlier messages to revert to", "warning");
				return;
			}

			// Build selection items
			const items = userMessages.map((msg) => {
				const hasSnapshot = snapshots.has(msg.entryId);
				const ts = new Date(msg.timestamp).toLocaleTimeString();
				const icon = hasSnapshot ? "📦" : "⚠️";
				return {
					label: `${icon} [${ts}] ${msg.text}`,
					value: msg.entryId,
					hasSnapshot,
				};
			});

			const choice = await ctx.ui.select(
				"Revert to which message?",
				items.map((i) => i.label),
			);

			if (!choice) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const selected = items.find((i) => i.label === choice);
			if (!selected) {
				ctx.ui.notify("Selection error", "error");
				return;
			}

			const targetEntryId = selected.value;

			// Warn if no file snapshot
			const snapshot = snapshots.get(targetEntryId);
			const hasFileRestore = !!snapshot;

			// Confirm
			const warning = hasFileRestore
				? "  • Restore all files to their state before that turn\n"
				: "  ⚠️ No file snapshot available — only conversation will rewind\n";
			const confirmed = await ctx.ui.confirm(
				"Revert?",
				`This will:\n${warning}  • Rewind the conversation to that point\n  • Subsequent history moves to an alternate branch\n\nContinue?`,
			);

			if (!confirmed) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// ── Step 1: Restore files ──────────────────────────
			if (hasFileRestore && snapshot) {
				// Check if ref === head (clean tree case)
				if (snapshot.ref === snapshot.head) {
					// Just reset to that commit
					const { code, stderr } = await pi.exec(
						"git",
						["reset", "--hard", snapshot.head],
						{ cwd: ctx.cwd, timeout: 5000 },
					);
					if (code === 0) {
						ctx.ui.notify("📁 Files restored to snapshot state (clean tree)", "info");
					} else {
						ctx.ui.notify(`File restore failed: ${stderr.trim()}`, "error");
					}
				} else {
					const result = await restoreToSnapshot(pi, ctx.cwd, snapshot);
					if (result.success) {
						ctx.ui.notify("📁 Files restored to snapshot state", "info");
					} else {
						ctx.ui.notify(`⚠️ ${result.message}`, "warning");
					}
				}
			}

			// ── Step 2: Rewind conversation tree ───────────────
			//
			// We navigate to the entry BEFORE the target user message,
			// so the user message text gets restored to the editor
			// (same behavior as /fork).

			const targetEntry = ctx.sessionManager.getEntry(targetEntryId);
			if (!targetEntry) {
				ctx.ui.notify("Could not find target entry", "error");
				return;
			}

			if (!targetEntry.parentId) {
				// This is the very first entry — navigate directly to it
				// The user message will be the new leaf
				const result = await ctx.navigateTree(targetEntryId, {
					summarize: true,
					label: `revert-${Date.now()}`,
				});
				return;
			}

			// Navigate to the parent so the user message is restored to editor
			await ctx.navigateTree(targetEntry.parentId, {
				summarize: true,
				label: `revert-${Date.now()}`,
			});

			// Note: after navigateTree, the original ctx is stale.
			// The tree has been rewound and the user message should be
			// in the editor for re-editing.
		},
	});

	// ── /revert-snapshots command (debug) ────────────────────

	pi.registerCommand("revert-snapshots", {
		description: "Show stored file snapshots for the current session",
		handler: async (_args, ctx) => {
			if (snapshots.size === 0) {
				ctx.ui.notify("No snapshots stored", "info");
				return;
			}
			const branch = ctx.sessionManager.getBranch();
			const lines: string[] = [];

			for (const [entryId, snap] of snapshots) {
				const entry = branch.find((e) => e.id === entryId);
				let text = "(unknown)";
				if (entry?.type === "message" && entry.message.role === "user") {
					const content = entry.message.content;
					text = typeof content === "string"
						? content.slice(0, 60)
						: content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join(" ")
							.slice(0, 60);
				}
				const isClean = snap.ref === snap.head;
				lines.push(`  ${entryId} → ${snap.ref.slice(0, 12)}… (head: ${snap.head.slice(0, 8)}${isClean ? ", clean" : ", dirty"}) "${text}"`);
			}

			ctx.ui.notify(`📦 ${snapshots.size} snapshot(s):\n${lines.join("\n")}`, "info");
		},
	});
}
