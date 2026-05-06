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
 *   - Session list on the left with fuzzy search
 *   - Preview panel on the right showing conversation messages
 *   - Ctrl+U to clear search, Esc to cancel
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
	type OverlayHandle,
	type TUI,
	type Theme,
} from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";

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

/** Extract conversation messages from a session file for preview */
function parseSessionMessages(filePath: string): Array<{ role: string; text: string }> {
	const messages: Array<{ role: string; text: string }> = [];

	try {
		const lines = readFileSync(filePath, "utf-8").trim().split("\n");
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session_info" && entry.name) {
					messages.push({ role: "name", text: entry.name });
				} else if (entry.type === "message" && entry.message) {
					const msg = entry.message;
					let text = "";

					if (typeof msg.content === "string") {
						text = msg.content;
					} else if (Array.isArray(msg.content)) {
						text = msg.content
							.filter((c: { type: string }) => c.type === "text")
							.map((c: { text: string }) => c.text)
							.join(" ");
					}

					if (!text && msg.role === "assistant" && Array.isArray(msg.content)) {
						// Try to get thinking content if no text
						const thinking = msg.content.find((c: { type: string }) => c.type === "thinking");
						if (thinking) text = "(thinking...)";
					}

					if (text) {
						// For assistant messages, try to get a meaningful summary
						if (msg.role === "assistant" && Array.isArray(msg.content)) {
							const textContent = msg.content.find((c: { type: string }) => c.type === "text");
							if (textContent) text = textContent.text;
						}
						text = text.replace(/\n/g, " ").trim();
						if (text.length > 200) text = text.slice(0, 197) + "...";
						messages.push({ role: msg.role, text });
					}
				}
			} catch { /* skip */ }
		}
	} catch { /* skip */ }

	return messages;
}

function formatDate(d: Date): string {
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fuzzyMatch(query: string, text: string): boolean {
	if (!query) return true;
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	let qi = 0;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) qi++;
	}
	return qi === q.length;
}

/** Preview panel — a non-capturing overlay on the right side */
class PreviewPanel {
	private messages: Array<{ role: string; text: string }> = [];
	private scrollOffset = 0;
	private sessionName = "";
	private sessionDate = "";
	private sessionCwd = "";

	constructor(private theme: Theme) {}

	setSession(path: string) {
		this.messages = parseSessionMessages(path);
		this.scrollOffset = 0;

		// Extract metadata from first few entries
		this.sessionName = "";
		this.sessionDate = "";
		this.sessionCwd = "";

		try {
			const lines = readFileSync(path, "utf-8").trim().split("\n");
			for (const line of lines) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "session") {
						this.sessionDate = entry.timestamp
							? formatDate(new Date(entry.timestamp))
							: "";
						this.sessionCwd = entry.cwd
							? entry.cwd.replace(/^\/Users\/\w+/, "~")
							: "";
					} else if (entry.type === "session_info" && entry.name) {
						this.sessionName = entry.name;
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}

	scrollUp() {
		this.scrollOffset = Math.max(0, this.scrollOffset - 1);
	}

	scrollDown(maxLines: number) {
		this.scrollOffset = Math.min(
			Math.max(0, this.messages.length + 4 - maxLines), // +4 for header lines
			this.scrollOffset + 1
		);
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const lines: string[] = [];

		// Border top
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		// Header
		const title = this.sessionName || "Preview";
		lines.push(th.fg("border", "│") + truncateToWidth(` ${th.fg("accent", th.bold(title))}`, innerW, "") + th.fg("border", "│"));

		if (this.sessionDate || this.sessionCwd) {
			const meta = [this.sessionDate, this.sessionCwd].filter(Boolean).join(" · ");
			lines.push(th.fg("border", "│") + truncateToWidth(` ${th.fg("muted", meta)}`, innerW, "") + th.fg("border", "│"));
		}

		lines.push(th.fg("border", "├" + "─".repeat(innerW) + "┤"));

		// Messages
		for (let i = this.scrollOffset; i < this.messages.length; i++) {
			const msg = this.messages[i]!;
			const prefix = msg.role === "user"
				? th.fg("accent", "▸ ")
				: msg.role === "assistant"
					? th.fg("muted", "│ ")
					: msg.role === "name"
						? th.fg("dim", "🏷 ")
						: "  ";

			const text = msg.role === "user"
				? th.fg("text", msg.text)
				: th.fg("dim", msg.text);

			lines.push(th.fg("border", "│") + truncateToWidth(` ${prefix}${text}`, innerW, "") + th.fg("border", "│"));
		}

		// Pad to at least show something
		if (this.messages.length === 0) {
			lines.push(th.fg("border", "│") + truncateToWidth(` ${th.fg("dim", "(no messages)")}`, innerW, "") + th.fg("border", "│"));
		}

		// Border bottom
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
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
			const label = session.name || extras.firstMessage.slice(0, 120) || "(empty session)";
			const prefix = isCurrent ? "● " : "  ";
			const description = [
				formatDate(session.modified),
				session.cwd ? session.cwd.replace(/^\/Users\/\w+/, "~") : "",
				extras.model,
			].filter(Boolean).join(" · ");

			return { value: session.path, label: prefix + label, description };
		});

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			let filter = "";

			// Preview panel — non-capturing overlay on the right
			const preview = new PreviewPanel(theme);
			const previewHandle = tui.showOverlay(preview, {
				nonCapturing: true,
				anchor: "right-center",
				width: "45%",
				margin: { right: 1 },
			});

			// Load preview for initial selection
			if (allItems.length > 0) {
				preview.setSession(allItems[0]!.value);
			}

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold("📡 Session Multiplexer")), 1, 0));

			const searchLine = new Text("", 1, 0);
			container.addChild(searchLine);

			const selectList = new SelectList(allItems, Math.min(allItems.length, 25), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			}, {
				minPrimaryColumnWidth: 40,
				maxPrimaryColumnWidth: 999,
			});

			selectList.onSelect = (item) => {
				previewHandle.hide();
				done(item.value);
			};

			selectList.onSelectionChange = (item) => {
				// Update preview when navigation changes
				preview.setSession(item.value);
				tui.requestRender();
			};

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to search • enter switch • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			const updateSearchLine = () => {
				const prompt = theme.fg("muted", "🔍 ");
				const query = filter ? theme.fg("text", filter) : theme.fg("dim", "type to filter…");
				const count = theme.fg("dim", ` (${selectList.filteredItems.length}/${allItems.length})`);
				searchLine.setText(prompt + query + count);
			};

			const applyFilter = () => {
				const filtered = allItems.filter((item) => {
					return fuzzyMatch(filter, item.label + " " + (item.description || ""));
				});
				selectList.items = filtered;
				selectList.filteredItems = filtered;
				selectList.selectedIndex = Math.min(selectList.selectedIndex, Math.max(0, filtered.length - 1));
				selectList.invalidate();
				updateSearchLine();

				// Update preview to show first filtered item
				if (filtered.length > 0) {
					preview.setSession(filtered[selectList.selectedIndex!]?.value ?? filtered[0]!.value);
				}
			};

			updateSearchLine();

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
						previewHandle.hide();
						done(null);
						return;
					}

					if (matchesKey(data, Key.enter)) {
						const selected = selectList.getSelectedItem();
						if (selected) {
							previewHandle.hide();
							done(selected.value);
						}
						return;
					}

					if (matchesKey(data, Key.up) || matchesKey(data, Key.down) ||
						matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
						selectList.handleInput(data);
						// Update preview after navigation
						const selected = selectList.getSelectedItem();
						if (selected) {
							preview.setSession(selected.value);
						}
						tui.requestRender();
						return;
					}

					// Shift+Up/Down scrolls the preview
					if (matchesKey(data, Key.shift("up"))) {
						preview.scrollUp();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, Key.shift("down"))) {
						preview.scrollDown(20);
						tui.requestRender();
						return;
					}

					if (data === "\x7f" || data === "\x08" || matchesKey(data, Key.backspace)) {
						if (filter.length > 0) {
							filter = filter.slice(0, -1);
							applyFilter();
							tui.requestRender();
						}
						return;
					}

					if (matchesKey(data, Key.ctrl("u"))) {
						filter = "";
						applyFilter();
						tui.requestRender();
						return;
					}

					if (data.length === 1 && data.charCodeAt(0) >= 32) {
						filter += data;
						applyFilter();
						tui.requestRender();
						return;
					}
				},
			};
		}, { overlay: true, overlayOptions: { width: "45%", maxHeight: "90%", margin: { left: 1 } } });

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
