/**
 * Session Multiplexer
 *
 * Switch between existing sessions with a floating overlay.
 *
 * Usage:
 *   Ctrl+Shift+S  — open the session picker overlay
 *   /sessions     — open the session picker overlay
 *
 * Features:
 *   - Lists all sessions across all projects
 *   - Type to fuzzy-search sessions
 *   - Shows session name (or first user message), date, model, and CWD
 *   - Highlight current session
 *   - Enter to switch, Esc to cancel
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, SessionManager } from "@mariozechner/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	Text,
	Key,
	matchesKey,
	visibleWidth,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

function parseSessionExtras(filePath: string): { firstMessage: string; model: string } {
	let firstMessage = "";
	let model = "";

	try {
		const lines = readFileSync(filePath, "utf-8").trim().split("\n");

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);

				if (entry.type === "message" && entry.message?.role === "user" && !firstMessage) {
					const content = entry.message.content;
					if (typeof content === "string") {
						firstMessage = content.replace(/\n/g, " ").trim();
					} else if (Array.isArray(content)) {
						firstMessage = content
							.filter((c: { type: string }) => c.type === "text")
							.map((c: { text: string }) => c.text)
							.join(" ")
							.replace(/\n/g, " ")
							.trim();
					}
				} else if (entry.type === "model_change" && !model) {
					model = entry.modelId || "";
				}
			} catch {
				// skip malformed lines
			}

			if (firstMessage && model) break;
		}
	} catch {
		// skip unreadable files
	}

	return { firstMessage, model };
}

function formatDate(d: Date): string {
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function fuzzyMatch(query: string, text: string): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	// Simple contains match
	return t.includes(q);
}

export default function sessionMux(pi: ExtensionAPI) {
	async function showSessionPicker(ctx: ExtensionCommandContext) {
		const currentSessionFile = ctx.sessionManager.getSessionFile();

		ctx.ui.setStatus("session-mux", "Loading sessions...");

		let allSessions: Awaited<ReturnType<typeof SessionManager.listAll>>;
		try {
			allSessions = await SessionManager.listAll();
		} catch {
			allSessions = await SessionManager.list(ctx.cwd);
		}

		ctx.ui.setStatus("session-mux", undefined);

		if (allSessions.length === 0) {
			ctx.ui.notify("No sessions found", "info");
			return;
		}

		// Pre-parse extras for all sessions
		const sessionData = allSessions.map((s) => ({
			session: s,
			extras: parseSessionExtras(s.path),
		}));

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			let filter = "";

			const buildItems = (): SelectItem[] => {
				return sessionData
					.filter(({ session, extras }) => {
						const searchable = [
							session.name || "",
							extras.firstMessage,
							session.cwd ? basename(session.cwd) : "",
							extras.model,
						].join(" ");
						return fuzzyMatch(filter, searchable);
					})
					.map(({ session, extras }) => {
						const isCurrent = session.path === currentSessionFile;
						const label = session.name || extras.firstMessage.slice(0, 80) || "(empty session)";
						const prefix = isCurrent ? "● " : "  ";
						const description = [
							formatDate(session.modified),
							session.cwd ? basename(session.cwd) : "",
							extras.model,
						].filter(Boolean).join(" · ");

						return {
							value: session.path,
							label: prefix + label,
							description,
						};
					});
			};

			const container = new Container();

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("📡 Session Multiplexer")), 1, 0));

			// Search input line — updated on every keystroke
			const searchLine = new Text("", 1, 0);
			container.addChild(searchLine);

			const selectList = new SelectList(buildItems(), Math.min(allSessions.length, 15), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);

			const helpText = new Text(theme.fg("dim", "↑↓ navigate • type to search • enter switch • esc cancel"), 1, 0);
			container.addChild(helpText);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			const updateSearchLine = () => {
				const prompt = theme.fg("muted", "🔍 ");
				const query = filter ? theme.fg("text", filter) : theme.fg("dim", "type to filter…");
				const count = theme.fg("dim", ` ${selectList.filteredItems.length}/${allSessions.length}`);
				searchLine.setText(prompt + query + count);
			};

			const refreshList = () => {
				const items = buildItems();
				selectList.setFilter(""); // reset internal filter
				// Rebuild items by replacing them
				selectList.items = items;
				selectList.filteredItems = items;
				selectList.selectedIndex = Math.min(selectList.selectedIndex, Math.max(0, items.length - 1));
				selectList.invalidate();
				updateSearchLine();
			};

			updateSearchLine();

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					// Printable chars go to filter
					if (data.length === 1 && data.charCodeAt(0) >= 32 && !matchesKey(data, Key.enter) && !matchesKey(data, Key.escape)) {
						filter += data;
						refreshList();
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.backspace)) {
						filter = filter.slice(0, -1);
						refreshList();
						tui.requestRender();
						return;
					}

					if (matchesKey(data, Key.ctrl("u"))) {
						filter = "";
						refreshList();
						tui.requestRender();
						return;
					}

					// Everything else (arrows, enter, escape) goes to SelectList
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });

		if (result && result !== currentSessionFile) {
			ctx.ui.notify("Switching session...", "info");
			await ctx.switchSession(result, {
				withSession: async (ctx) => {
					ctx.ui.notify("Switched session ✓", "success");
				},
			});
		} else if (result === currentSessionFile) {
			ctx.ui.notify("Already in this session", "info");
		}
	}

	// Ctrl+Shift+S — queues /sessions since shortcuts lack ExtensionCommandContext
	pi.registerShortcut(Key.ctrlShift("s"), {
		description: "Open session multiplexer",
		handler: async (_ctx) => {
			pi.sendUserMessage("/sessions", { deliverAs: "steer" });
		},
	});

	pi.registerCommand("sessions", {
		description: "Open session multiplexer to switch between sessions",
		handler: async (_args, ctx) => {
			await showSessionPicker(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("session-mux", ctx.ui.theme.fg("muted", "⌘⇧S sessions"));
	});
}
