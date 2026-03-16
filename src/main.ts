import { RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	type PluginValue,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	type MarkdownPostProcessorContext,
} from "obsidian";

type SectionInfo = ReturnType<MarkdownPostProcessorContext["getSectionInfo"]>;

interface InteractiveDayCounterSettings {
	borderRadius: number;
	borderWidth: number;
	borderColor: string;
	backgroundMode: "transparent" | "solid";
	backgroundColor: string;
	counterSize: number;
}

const DAY_TOKEN_REGEX = /<day-(\d+)\/(\d+)>/g;
const DAY_TOKEN_PLAIN_REGEX = /<day-(\d+)\/(\d+)>/;
const DEFAULT_SETTINGS: InteractiveDayCounterSettings = {
	borderRadius: 8,
	borderWidth: 1,
	borderColor: "var(--background-modifier-border)",
	backgroundMode: "solid",
	backgroundColor: "var(--background-primary)",
	counterSize: 100,
};
const HEX_COLOR_REGEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const BORDER_COLOR_PICKER_FALLBACK = "#cbd5e1";
const BACKGROUND_COLOR_PICKER_FALLBACK = "#ffffff";

function makeDayToken(current: number, goal: number): string {
	return `<day-${current}/${goal}>`;
}

function sanitizeNumberInput(rawValue: string, fallback: number): number {
	const digits = rawValue.replace(/\D+/g, "");
	return digits === "" ? fallback : Number(digits);
}

function createNumericInput(value: number): HTMLInputElement {
	const input = document.createElement("input");
	input.className = "interactive-day-counter__value-input";
	input.type = "number";
	input.min = "0";
	input.step = "1";
	input.inputMode = "numeric";
	input.pattern = "[0-9]*";
	input.value = String(value);
	return input;
}

interface CounterElements {
	chip: HTMLSpanElement;
	currentSlot: HTMLSpanElement;
	goalSlot: HTMLSpanElement;
}

function createValueButton(
	value: number,
	kind: "current" | "goal",
	disabled = false,
): HTMLButtonElement {
	const button = document.createElement("button");
	button.className = `interactive-day-counter__value interactive-day-counter__${kind}`;
	button.type = "button";
	button.textContent = String(value);
	button.disabled = disabled;
	button.setAttribute(
		"aria-label",
		kind === "current" ? "Edit current value" : "Edit goal",
	);
	return button;
}

function createCounterElements(): CounterElements {
	const chip = document.createElement("span");
	chip.className = "interactive-day-counter";

	const numbers = document.createElement("span");
	numbers.className = "interactive-day-counter__numbers";

	const currentSlot = document.createElement("span");
	currentSlot.className =
		"interactive-day-counter__value-slot interactive-day-counter__current-slot";

	const separator = document.createElement("span");
	separator.className = "interactive-day-counter__separator";
	separator.textContent = "/";

	const goalSlot = document.createElement("span");
	goalSlot.className =
		"interactive-day-counter__value-slot interactive-day-counter__goal-slot";

	numbers.append(currentSlot, separator, goalSlot);
	chip.append(numbers);

	return {
		chip,
		currentSlot,
		goalSlot,
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clampSetting(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}

	return Math.min(max, Math.max(min, value));
}

function normalizeColor(value: unknown, fallback: string): string {
	if (typeof value !== "string") {
		return fallback;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return fallback;
	}

	if (HEX_COLOR_REGEX.test(trimmed)) {
		return trimmed;
	}

	if (/^var\(--[^)]+\)$/i.test(trimmed)) {
		return trimmed;
	}

	if (typeof CSS !== "undefined" && CSS.supports("color", trimmed)) {
		return trimmed;
	}

	return fallback;
}

function normalizeBackgroundMode(
	value: unknown,
	fallback: InteractiveDayCounterSettings["backgroundMode"],
): InteractiveDayCounterSettings["backgroundMode"] {
	return value === "solid" || value === "transparent" ? value : fallback;
}

function getColorPickerValue(value: string, fallback: string): string {
	return HEX_COLOR_REGEX.test(value.trim()) ? value.trim() : fallback;
}

function cleanCssValue(value: string): string {
	return value.replace(/\s*!important\s*/gi, "").trim();
}

function extractCssBlock(cssText: string, selector: string): string | null {
	const match = cssText.match(
		new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\}`, "i"),
	);
	return match?.[1] ?? null;
}

function extractCssDeclaration(block: string | null, property: string): string | null {
	if (!block) {
		return null;
	}

	const match = block.match(
		new RegExp(`${escapeRegExp(property)}\\s*:\\s*([^;]+);`, "i"),
	);
	return match?.[1]?.trim() ?? null;
}

function parsePixelValue(value: string | null): number | null {
	if (!value) {
		return null;
	}

	const match = cleanCssValue(value).match(/([0-9.]+)px/i);
	if (!match) {
		return null;
	}

	const parsed = Number.parseFloat(match[1]);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseCounterSize(value: string | null): number | null {
	if (!value) {
		return null;
	}

	const match = cleanCssValue(value).match(/^([0-9.]+)(%|em|rem)?$/i);
	if (!match) {
		return null;
	}

	const amount = Number.parseFloat(match[1]);
	if (!Number.isFinite(amount)) {
		return null;
	}

	switch (match[2]?.toLowerCase()) {
		case "%":
			return amount;
		case "rem":
		case "em":
		case undefined:
			return amount * 100;
		default:
			return null;
	}
}

function migrateLegacySettings(rawSettings: {
	cssText?: string;
	customCss?: string;
	borderColor?: string;
}): Partial<InteractiveDayCounterSettings> {
	const cssText = [rawSettings.cssText, rawSettings.customCss]
		.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
		.join("\n\n");

	const chipBlock = extractCssBlock(cssText, ".interactive-day-counter");
	const numbersBlock = extractCssBlock(cssText, ".interactive-day-counter__numbers");
	const rootBlock = extractCssBlock(cssText, ":root");
	const borderDeclaration = extractCssDeclaration(chipBlock, "border");
	const backgroundValue = cleanCssValue(
		extractCssDeclaration(chipBlock, "background-color") ??
			extractCssDeclaration(chipBlock, "background") ??
			"",
	);
	const borderColorValue =
		cleanCssValue(
			extractCssDeclaration(rootBlock, "--interactive-day-counter-border-color") ??
				"",
		) || rawSettings.borderColor;
	const migratedBackgroundColor = normalizeColor(
		backgroundValue,
		DEFAULT_SETTINGS.backgroundColor,
	);

	return {
		borderRadius:
			parsePixelValue(extractCssDeclaration(chipBlock, "border-radius")) ??
			undefined,
		borderWidth: parsePixelValue(borderDeclaration) ?? undefined,
		borderColor: borderColorValue
			? normalizeColor(borderColorValue, DEFAULT_SETTINGS.borderColor)
			: undefined,
		backgroundMode:
			backgroundValue.toLowerCase() === "transparent"
				? "transparent"
				: backgroundValue.length > 0
					? "solid"
					: undefined,
		backgroundColor:
			backgroundValue.toLowerCase() === "transparent"
				? DEFAULT_SETTINGS.backgroundColor
				: migratedBackgroundColor,
		counterSize:
			parseCounterSize(
				extractCssDeclaration(chipBlock, "font-size") ??
					extractCssDeclaration(numbersBlock, "font-size"),
			) ?? undefined,
	};
}

class DayCounterWidget extends WidgetType {
	constructor(
		private readonly current: number,
		private readonly goal: number,
		private readonly from: number,
		private readonly to: number,
	) {
		super();
	}

	override eq(other: DayCounterWidget): boolean {
		return (
			this.current === other.current &&
			this.goal === other.goal &&
			this.from === other.from &&
			this.to === other.to
		);
	}

	override toDOM(view: EditorView): HTMLElement {
		let currentValue = this.current;
		let goalValue = this.goal;

		const { chip, currentSlot, goalSlot } = createCounterElements();
		chip.contentEditable = "false";
		const currentButton = createValueButton(currentValue, "current");
		const goalButton = createValueButton(goalValue, "goal");

		const syncDisplay = () => {
			currentButton.textContent = String(currentValue);
			goalButton.textContent = String(goalValue);
		};

		const dispatchTokenUpdate = (nextCurrent: number, nextGoal: number) => {
			view.dispatch({
				changes: {
					from: this.from,
					to: this.to,
					insert: makeDayToken(nextCurrent, nextGoal),
				},
			});
		};

		const startEdit = (event: MouseEvent, target: "current" | "goal") => {
			event.preventDefault();
			event.stopPropagation();

			const input = createNumericInput(
				target === "current" ? currentValue : goalValue,
			);

			const restoreButton = () => {
				if (target === "current") {
					currentSlot.replaceChildren(currentButton);
					return;
				}

				goalSlot.replaceChildren(goalButton);
			};

			const commit = () => {
				const nextValue = sanitizeNumberInput(
					input.value,
					target === "current" ? currentValue : goalValue,
				);
				restoreButton();

				if (target === "current") {
					if (nextValue === currentValue) {
						return;
					}

					dispatchTokenUpdate(nextValue, goalValue);
					return;
				}

				if (nextValue === goalValue) {
					return;
				}

				dispatchTokenUpdate(currentValue, nextValue);
			};

			input.addEventListener("mousedown", (inputEvent) => {
				inputEvent.preventDefault();
				inputEvent.stopPropagation();
			});
			input.addEventListener("click", (inputEvent) => {
				inputEvent.preventDefault();
				inputEvent.stopPropagation();
			});
			input.addEventListener("keydown", (keyboardEvent) => {
				if (keyboardEvent.key === "Enter") {
					keyboardEvent.preventDefault();
					commit();
				}

				if (keyboardEvent.key === "Escape") {
					keyboardEvent.preventDefault();
					restoreButton();
				}
			});
			input.addEventListener("blur", commit, { once: true });

			if (target === "current") {
				currentSlot.replaceChildren(input);
			} else {
				goalSlot.replaceChildren(input);
			}

			window.requestAnimationFrame(() => {
				input.focus();
				input.select();
			});
		};

		currentButton.addEventListener("mousedown", (event) => {
			startEdit(event, "current");
		});
		goalButton.addEventListener("mousedown", (event) => {
			startEdit(event, "goal");
		});

		syncDisplay();
		currentSlot.replaceChildren(currentButton);
		goalSlot.replaceChildren(goalButton);
		return chip;
	}

	override ignoreEvent(): boolean {
		return true;
	}
}

function buildDayCounterDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const processedLines = new Set<number>();

	for (const { from, to } of view.visibleRanges) {
		const firstLine = view.state.doc.lineAt(from).number;
		const lastLine = view.state.doc.lineAt(to).number;

		for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
			if (processedLines.has(lineNumber)) {
				continue;
			}

			processedLines.add(lineNumber);
			const line = view.state.doc.line(lineNumber);
			const regex = new RegExp(DAY_TOKEN_REGEX);
			let match: RegExpExecArray | null;

			while ((match = regex.exec(line.text)) !== null) {
				const start = line.from + match.index;
				const end = start + match[0].length;
				builder.add(
					start,
					end,
					Decoration.replace({
						widget: new DayCounterWidget(
							Number(match[1]),
							Number(match[2]),
							start,
							end,
						),
					}),
				);
			}
		}
	}

	return builder.finish();
}

const livePreviewDayCounterExtension = ViewPlugin.fromClass(
	class DayCounterViewPlugin implements PluginValue {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildDayCounterDecorations(view);
		}

		update(update: ViewUpdate): void {
			if (
				update.docChanged ||
				update.viewportChanged ||
				update.geometryChanged ||
				update.selectionSet ||
				update.focusChanged
			) {
				this.decorations = buildDayCounterDecorations(update.view);
			}
		}

		destroy(): void {}
	},
	{
		decorations: (value) => value.decorations,
	},
);

export default class InteractiveDayCountersPlugin extends Plugin {
	settings: InteractiveDayCounterSettings = DEFAULT_SETTINGS;
	private readonly appearanceVariables = [
		"--interactive-day-counter-border-color",
		"--interactive-day-counter-border-radius",
		"--interactive-day-counter-border-width",
		"--interactive-day-counter-background-color",
		"--interactive-day-counter-size",
	] as const;

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.applyAppearance();

		this.registerEditorExtension(livePreviewDayCounterExtension);
		this.addSettingTab(new InteractiveDayCounterSettingTab(this.app, this));

		this.addCommand({
			id: "insert-day-counter",
			name: "Insert token",
			editorCallback: (editor) => {
				editor.replaceSelection(this.makeCounterFromSelection(editor.getSelection()));
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				menu.addItem((item) => {
					item
						.setSection("formatting")
						.setTitle("Insert token")
						.setIcon("calendar-range")
						.onClick(() => {
							editor.replaceSelection(
								this.makeCounterFromSelection(editor.getSelection()),
							);
						});
				});
			}),
		);

		this.registerMarkdownPostProcessor((element, context) => {
			const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
			if (!(file instanceof TFile)) {
				return;
			}

			this.decorateReadingView(element, context, file);
		});
	}

	override onunload(): void {
		this.clearAppearance();
	}

	async loadSettings(): Promise<void> {
		const rawSettings = Object.assign({}, await this.loadData()) as Partial<
			InteractiveDayCounterSettings & {
				cssText?: string;
				customCss?: string;
				borderColor?: string;
			}
		>;
		const legacySettings = migrateLegacySettings(rawSettings);

		this.settings = {
			borderRadius: clampSetting(
				rawSettings.borderRadius ?? legacySettings.borderRadius,
				0,
				32,
				DEFAULT_SETTINGS.borderRadius,
			),
			borderWidth: clampSetting(
				rawSettings.borderWidth ?? legacySettings.borderWidth,
				0,
				10,
				DEFAULT_SETTINGS.borderWidth,
			),
			borderColor: normalizeColor(
				rawSettings.borderColor ?? legacySettings.borderColor,
				DEFAULT_SETTINGS.borderColor,
			),
			backgroundMode: normalizeBackgroundMode(
				rawSettings.backgroundMode ?? legacySettings.backgroundMode,
				DEFAULT_SETTINGS.backgroundMode,
			),
			backgroundColor: normalizeColor(
				rawSettings.backgroundColor ?? legacySettings.backgroundColor,
				DEFAULT_SETTINGS.backgroundColor,
			),
			counterSize: clampSetting(
				rawSettings.counterSize ?? legacySettings.counterSize,
				70,
				180,
				DEFAULT_SETTINGS.counterSize,
			),
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.applyAppearance();
	}

	private applyAppearance(): void {
		const styleRoot = document.body ?? document.documentElement;
		const backgroundColor =
			this.settings.backgroundMode === "solid"
				? this.settings.backgroundColor
				: "transparent";

		styleRoot.style.setProperty(
			"--interactive-day-counter-border-color",
			this.settings.borderColor,
		);
		styleRoot.style.setProperty(
			"--interactive-day-counter-border-radius",
			`${this.settings.borderRadius}px`,
		);
		styleRoot.style.setProperty(
			"--interactive-day-counter-border-width",
			`${this.settings.borderWidth}px`,
		);
		styleRoot.style.setProperty(
			"--interactive-day-counter-background-color",
			backgroundColor,
		);
		styleRoot.style.setProperty(
			"--interactive-day-counter-size",
			`${this.settings.counterSize}%`,
		);
	}

	private clearAppearance(): void {
		const styleRoot = document.body ?? document.documentElement;

		for (const variableName of this.appearanceVariables) {
			styleRoot.style.removeProperty(variableName);
		}
	}

	async updateAppearance(
		changes: Partial<InteractiveDayCounterSettings>,
	): Promise<void> {
		this.settings = {
			...this.settings,
			...changes,
		};
		await this.saveSettings();
	}

	private makeCounterFromSelection(selection: string): string {
		const trimmed = selection.trim();
		if (/^\d+\/\d+$/.test(trimmed)) {
			return `<day-${trimmed}>`;
		}

		if (/^\d+$/.test(trimmed)) {
			return `<day-${trimmed}/0>`;
		}

		return "<day-0/0>";
	}

	private decorateReadingView(
		root: HTMLElement,
		context: MarkdownPostProcessorContext,
		file: TFile,
	): void {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node: Node) => {
				if (!node.nodeValue || !DAY_TOKEN_PLAIN_REGEX.test(node.nodeValue)) {
					return NodeFilter.FILTER_REJECT;
				}

				const parent = node.parentElement;
				if (parent?.closest(".interactive-day-counter")) {
					return NodeFilter.FILTER_REJECT;
				}

				return NodeFilter.FILTER_ACCEPT;
			},
		});

		const textNodes: Text[] = [];
		let currentNode: Node | null;

		while ((currentNode = walker.nextNode()) !== null) {
			if (currentNode instanceof Text) {
				textNodes.push(currentNode);
			}
		}

		for (const textNode of textNodes) {
			this.replaceTokensInReadingTextNode(textNode, root, context, file);
		}
	}

	private replaceTokensInReadingTextNode(
		textNode: Text,
		root: HTMLElement,
		context: MarkdownPostProcessorContext,
		file: TFile,
	): void {
		const text = textNode.nodeValue ?? "";
		const fragment = document.createDocumentFragment();
		let lastIndex = 0;
		let didReplace = false;

		for (const match of text.matchAll(new RegExp(DAY_TOKEN_REGEX))) {
			didReplace = true;
			const fullMatch = match[0];
			const current = Number(match[1]);
			const goal = Number(match[2]);
			const matchIndex = match.index ?? 0;

			if (matchIndex > lastIndex) {
				fragment.appendChild(document.createTextNode(text.slice(lastIndex, matchIndex)));
			}

			const hostEl =
				textNode.parentElement?.closest("li, p, td, blockquote") ??
				textNode.parentElement ??
				root;
			const sectionTarget = hostEl instanceof HTMLElement ? hostEl : root;
			const sectionInfo = context.getSectionInfo(sectionTarget);
			fragment.appendChild(
				this.createReadingChip(file, current, goal, sectionInfo),
			);

			lastIndex = matchIndex + fullMatch.length;
		}

		if (!didReplace) {
			return;
		}

		if (lastIndex < text.length) {
			fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
		}

		textNode.replaceWith(fragment);
	}

	private createReadingChip(
		file: TFile,
		current: number,
		goal: number,
		sectionInfo: SectionInfo,
	): HTMLElement {
		let currentValue = current;
		let goalValue = goal;

		const { chip, currentSlot, goalSlot } = createCounterElements();
		const currentButton = createValueButton(currentValue, "current");
		const goalButton = createValueButton(goalValue, "goal");

		const syncDisplay = () => {
			currentButton.textContent = String(currentValue);
			goalButton.textContent = String(goalValue);
		};

		const saveToken = async (
			nextCurrent: number,
			nextGoal: number,
			errorMessage: string,
		) => {
			const updated = await this.updateCounterInFile(
				file,
				currentValue,
				nextCurrent,
				goalValue,
				nextGoal,
				sectionInfo,
			);
			if (!updated) {
				new Notice(errorMessage);
				return false;
			}

			currentValue = nextCurrent;
			goalValue = nextGoal;
			syncDisplay();
			return true;
		};

		const startEdit = (event: MouseEvent, target: "current" | "goal") => {
			event.preventDefault();
			event.stopPropagation();

			const input = createNumericInput(
				target === "current" ? currentValue : goalValue,
			);

			const restoreButton = () => {
				if (target === "current") {
					currentSlot.replaceChildren(currentButton);
					return;
				}

				goalSlot.replaceChildren(goalButton);
			};

			const commit = async () => {
				const nextValue = sanitizeNumberInput(
					input.value,
					target === "current" ? currentValue : goalValue,
				);
				restoreButton();

				if (target === "current") {
					if (nextValue === currentValue) {
						return;
					}

					await saveToken(
						nextValue,
						goalValue,
						`Could not update the counter in ${file.basename}.`,
					);
					return;
				}

				if (nextValue === goalValue) {
					return;
				}

				await saveToken(
					currentValue,
					nextValue,
					`Could not update the goal in ${file.basename}.`,
				);
			};

			input.addEventListener("mousedown", (inputEvent) => {
				inputEvent.preventDefault();
				inputEvent.stopPropagation();
			});
			input.addEventListener("click", (inputEvent) => {
				inputEvent.preventDefault();
				inputEvent.stopPropagation();
			});
			input.addEventListener("keydown", (keyboardEvent) => {
				if (keyboardEvent.key === "Enter") {
					keyboardEvent.preventDefault();
					void commit();
				}

				if (keyboardEvent.key === "Escape") {
					keyboardEvent.preventDefault();
					restoreButton();
				}
			});
			input.addEventListener("blur", () => {
				void commit();
			}, { once: true });

			if (target === "current") {
				currentSlot.replaceChildren(input);
			} else {
				goalSlot.replaceChildren(input);
			}

			window.requestAnimationFrame(() => {
				input.focus();
				input.select();
			});
		};

		currentButton.addEventListener("click", (event) => {
			startEdit(event, "current");
		});
		goalButton.addEventListener("click", (event) => {
			startEdit(event, "goal");
		});

		syncDisplay();
		currentSlot.replaceChildren(currentButton);
		goalSlot.replaceChildren(goalButton);
		return chip;
	}

	private async updateCounterInFile(
		file: TFile,
		oldCurrentValue: number,
		newCurrentValue: number,
		oldGoalValue: number,
		newGoalValue: number,
		sectionInfo: SectionInfo,
	): Promise<boolean> {
		const exactToken = makeDayToken(oldCurrentValue, oldGoalValue);
		const replacementToken = makeDayToken(newCurrentValue, newGoalValue);
		let didUpdate = false;

		await this.app.vault.process(file, (content) => {
			const lines = content.split(/\r?\n/);

			if (sectionInfo) {
				for (
					let index = sectionInfo.lineStart - 1;
					index <= sectionInfo.lineEnd;
					index += 1
				) {
					if (index < 0 || typeof lines[index] !== "string") {
						continue;
					}

					if (!lines[index].includes(exactToken)) {
						continue;
					}

					lines[index] = lines[index].replace(exactToken, replacementToken);
					didUpdate = true;
					return lines.join("\n");
				}
			}

			const fallbackIndex = lines.findIndex((line) => line.includes(exactToken));
			if (fallbackIndex === -1) {
				return content;
			}

			lines[fallbackIndex] = lines[fallbackIndex].replace(
				exactToken,
				replacementToken,
			);
			didUpdate = true;
			return lines.join("\n");
		});

		return didUpdate;
	}
}

class InteractiveDayCounterSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: InteractiveDayCountersPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("interactive-day-counter-settings");

		const hero = containerEl.createDiv({
			cls: "interactive-day-counter-settings__hero",
		});
		const heroHeading = new Setting(hero)
			.setName("Counter")
			.setDesc(
				"Simple counters for goals, streaks, or progress. Use the controls below to adjust the corners, border, background, and size.",
			)
			.setHeading();
		heroHeading.settingEl.addClass("interactive-day-counter-settings__hero-heading");

		const preview = hero.createDiv({
			cls: "interactive-day-counter-settings__preview",
		});
		preview.append(
			this.createPreviewChip(3, 10),
			this.createPreviewChip(12, 21),
		);

		const tokenHint = hero.createDiv({
			cls: "interactive-day-counter-settings__token",
			text: "Counter token: <day-3/10>",
		});
		tokenHint.setAttribute("aria-label", "Token format");

		new Setting(containerEl)
			.setName("Appearance")
			.setHeading();

		new Setting(containerEl)
			.setName("Border radius")
			.setDesc("Round the counter corners.")
			.addSlider((slider) => {
				slider
					.setLimits(0, 32, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.borderRadius)
					.onChange(async (value) => {
						await this.plugin.updateAppearance({ borderRadius: value });
					});
			});

		new Setting(containerEl)
			.setName("Border stroke")
			.setDesc("Make the outline thinner or thicker.")
			.addSlider((slider) => {
				slider
					.setLimits(0, 10, 1)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.borderWidth)
					.onChange(async (value) => {
						await this.plugin.updateAppearance({ borderWidth: value });
					});
			});

		new Setting(containerEl)
			.setName("Border color")
			.setDesc("Pick the outline color.")
			.addColorPicker((color) => {
				color
					.setValue(
						getColorPickerValue(
							this.plugin.settings.borderColor,
							BORDER_COLOR_PICKER_FALLBACK,
						),
					)
					.onChange(async (value) => {
						await this.plugin.updateAppearance({ borderColor: value });
					});
			});

		new Setting(containerEl)
			.setName("Background")
			.setDesc("Pick a fill color or keep the counter transparent.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("transparent", "Transparent")
					.addOption("solid", "Solid")
					.setValue(this.plugin.settings.backgroundMode)
					.onChange(async (value) => {
						await this.plugin.updateAppearance({
							backgroundMode: normalizeBackgroundMode(
								value,
								DEFAULT_SETTINGS.backgroundMode,
							),
						});
						this.display();
					});
			})
			.addColorPicker((color) => {
				color
					.setValue(
						getColorPickerValue(
							this.plugin.settings.backgroundColor,
							BACKGROUND_COLOR_PICKER_FALLBACK,
						),
					)
					.onChange(async (value) => {
						await this.plugin.updateAppearance({
							backgroundMode: "solid",
							backgroundColor: value,
						});
					});
			})
			.addExtraButton((button) => {
				button
					.setIcon("reset")
					.setTooltip("Make background transparent")
					.onClick(async () => {
						await this.plugin.updateAppearance({
							backgroundMode: "transparent",
						});
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("Counter size")
			.setDesc("Scale the whole counter up or down.")
			.addSlider((slider) => {
				slider
					.setLimits(70, 180, 5)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.counterSize)
					.onChange(async (value) => {
						await this.plugin.updateAppearance({ counterSize: value });
					});
			});

		new Setting(containerEl)
			.setName("Reset appearance")
			.setDesc("Go back to the default counter look.")
			.addButton((button) => {
				button
					.setButtonText("Reset")
					.setCta()
					.onClick(async () => {
						this.plugin.settings = { ...DEFAULT_SETTINGS };
						await this.plugin.saveSettings();
						this.display();
					});
			});
	}

	private createPreviewChip(current: number, goal: number): HTMLElement {
		const { chip, currentSlot, goalSlot } = createCounterElements();
		currentSlot.replaceChildren(createValueButton(current, "current", true));
		goalSlot.replaceChildren(createValueButton(goal, "goal", true));
		return chip;
	}
}
