/**
 * Session Multiplexer
 *
 * Switch between existing sessions with a floating overlay.
 *
 * Usage:
 *   Ctrl+Shift+S  — open the session picker overlay
 *   /sessions     — open the session picker overlay
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
			} catch { /* skip */ }
			if (firstMessage && model) break;
		}
	} catch { /* skip */ }

	return { firstMessage, model };
}

function formatDate(d: Date): string {
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

		const sessionData = allSessions.map((s) => ({
			session: s,
			extras: parseSessionExtras(s.path),
		}));

		const allItems: SelectItem[] = sessionData.map(({ session, extras }) => {
			const isCurrent = session.path === currentSessionFile;
			const label = session.name || extras.firstMessage.slice(0, 80) || "(empty session)";
			const prefix = isCurrent ? "● " : "  ";
			const description = [
				formatDate(session.modified),
				session.cwd ? basename(session.cwd) : "",
				extras.model,
			].filter(Boolean).join(" · ");

			return { value: session.path, label: prefix + label, description };
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			let filter = "";

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("📡 Session Multiplexer")), 1, 0));

			// Search line — updated on every keystroke
			const searchLine = new Text("", 1, 0);
			container.addChild(searchLine);

			const selectList = new SelectList(allItems, Math.min(allItems.length, 15), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			selectList.onSelect = (item) => done(item.value);
			// Don't use onCancel — we handle escape ourselves

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to search • enter switch • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			const updateSearchLine = () => {
				const prompt = theme.fg("muted", "🔍 ");
				const query = filter ? theme.fg("text", filter) : theme.fg("dim", "type to filter…");
				const count = theme.fg("dim", ` (${selectList.filteredItems.length}/${allItems.length})`);
				searchLine.setText(prompt + query + count);
			};

			// Use SelectList's built-in setFilter for matching
			const applyFilter = () => {
				selectList.setFilter(filter);
				updateSearchLine();
			};

			updateSearchLine();

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					// Escape — close overlay
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
						done(null);
						return;
					}

					// Enter — select current item
					if (matchesKey(data, Key.enter)) {
						const selected = selectList.getSelectedItem();
						if (selected) {
							done(selected.value);
						}
						return;
					}

					// Arrow keys — navigate
					if (matchesKey(data, Key.up) || matchesKey(data, Key.down) ||
						matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
						selectList.handleInput(data);
						tui.requestRender();
						return;
					}

					// Backspace — delete last filter char
					if (data === "\x7f" || data === "\x08" || matchesKey(data, Key.backspace)) {
						if (filter.length > 0) {
							filter = filter.slice(0, -1);
							applyFilter();
							tui.requestRender();
						}
						return;
					}

					// Ctrl+U — clear filter
					if (matchesKey(data, Key.ctrl("u"))) {
						filter = "";
						applyFilter();
						tui.requestRender();
						return;
					}

					// Printable chars — add to filter
					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						filter += data;
						applyFilter();
						tui.requestRender();
						return;
					}

					// Swallow everything else
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
