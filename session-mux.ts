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
 *   - Fuzzy search to filter sessions
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
} from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

/** Extra info we extract by reading the session file */
interface ParsedExtras {
	firstMessage: string;
	model: string;
}

function parseSessionExtras(filePath: string): ParsedExtras {
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

			// Stop early once we have both
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

		const items: SelectItem[] = allSessions.map((s) => {
			const isCurrent = s.path === currentSessionFile;
			const extras = parseSessionExtras(s.path);
			const label = s.name || extras.firstMessage.slice(0, 80) || "(empty session)";
			const prefix = isCurrent ? "● " : "  ";
			const description = [
				formatDate(s.modified),
				s.cwd ? basename(s.cwd) : "",
				extras.model,
			].filter(Boolean).join(" · ");

			return {
				value: s.path,
				label: prefix + label,
				description,
			};
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("📡 Session Multiplexer")), 1, 0));

			const selectList = new SelectList(items, Math.min(items.length, 15), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to search • enter switch • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
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
