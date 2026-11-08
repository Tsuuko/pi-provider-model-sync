import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface ModelChoice {
  id: string;
  checked: boolean;
  available: boolean;
}

function displayText(text: string): string {
  return text.replace(/\p{Cc}/gu, " ");
}

function listNavigation(length: number) {
  return {
    selected: 0,
    firstVisible: 0,
    update(visibleCount: number): void {
      this.firstVisible = Math.max(0, Math.min(this.firstVisible, length - visibleCount));
      if (this.selected < this.firstVisible) this.firstVisible = this.selected;
      if (this.selected >= this.firstVisible + visibleCount) {
        this.firstVisible = this.selected - visibleCount + 1;
      }
    },
    handleInput(data: string, visibleCount: number): boolean {
      this.update(visibleCount);
      if (matchesKey(data, Key.up) || data === "k") {
        this.selected = Math.max(0, this.selected - 1);
      } else if (matchesKey(data, Key.down) || data === "j") {
        this.selected = Math.max(0, Math.min(length - 1, this.selected + 1));
      } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
        const direction = matchesKey(data, Key.left) ? -1 : 1;
        const nextFirst = Math.max(
          0,
          Math.min(this.firstVisible + direction * visibleCount, length - visibleCount),
        );
        if (nextFirst === this.firstVisible) {
          this.selected = direction < 0 ? 0 : Math.max(0, length - 1);
        } else {
          this.selected += nextFirst - this.firstVisible;
          this.firstVisible = nextFirst;
        }
      } else {
        return false;
      }
      this.update(visibleCount);
      return true;
    },
  };
}

function dialogCompletion<T>(done: (result: T | undefined) => void, signal?: AbortSignal) {
  let finished = false;
  const dispose = () => signal?.removeEventListener("abort", abort);
  const finish = (result: T | undefined) => {
    if (finished) return;
    finished = true;
    dispose();
    done(result);
  };
  const abort = () => finish(undefined);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return { finish, dispose };
}

function viewHeight(terminalRows: number): number {
  return Math.max(1, Math.min(16, terminalRows - 2));
}

export interface ProviderListState {
  selected: string | undefined;
  firstVisible: number;
}

export async function selectProvider(
  ctx: ExtensionContext,
  providers: readonly string[],
  signal?: AbortSignal,
  state?: ProviderListState,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const navigation = listNavigation(providers.length);
    if (state) {
      const selected = providers.findIndex((provider) => provider === state.selected);
      navigation.selected = Math.max(0, selected);
      navigation.firstVisible = selected < 0 ? 0 : state.firstVisible;
    }
    const remember = () => {
      navigation.update(Math.max(1, viewHeight(tui.terminal.rows) - 3));
      if (state) {
        state.selected = providers[navigation.selected];
        state.firstVisible = navigation.firstVisible;
      }
    };
    remember();
    const { finish, dispose } = dialogCompletion(done, signal);
    return {
      render(width: number): string[] {
        const height = viewHeight(tui.terminal.rows);
        const visibleCount = Math.max(1, height - 3);
        remember();
        const rows = providers
          .slice(navigation.firstVisible, navigation.firstVisible + visibleCount)
          .map(
            (provider, index) =>
              `${navigation.firstVisible + index === navigation.selected ? ">" : " "} ${displayText(provider)}`,
          );
        if (rows.length === 0) rows.push(theme.fg("dim", "No providers"));
        const lines =
          height < 4
            ? rows
            : [
                theme.fg("accent", "Select a provider"),
                ...rows,
                theme.fg(
                  "dim",
                  `${providers.length === 0 ? 0 : navigation.selected + 1}/${providers.length}`,
                ),
                theme.fg("dim", "↑↓ Move • ←→ Page • Enter Select • Esc Back • Ctrl+C Exit"),
              ];
        return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
      },
      handleInput(data: string): void {
        remember();
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          finish(undefined);
        } else if (matchesKey(data, Key.enter) || data === "\n") {
          const provider = providers[navigation.selected];
          if (provider !== undefined) finish(provider);
        } else if (navigation.handleInput(data, Math.max(1, viewHeight(tui.terminal.rows) - 3))) {
          remember();
          tui.requestRender();
        }
      },
      invalidate(): void {},
      dispose,
    };
  });
}

export async function selectProviderModels(
  ctx: ExtensionContext,
  providerName: string,
  choices: readonly ModelChoice[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  if (signal?.aborted) return undefined;
  return ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
    const models = choices.map((choice) => ({ ...choice }));
    const input = new Input();
    let filtered = models;
    let navigation = listNavigation(filtered.length);
    const { finish, dispose } = dialogCompletion(done, signal);
    return {
      render(width: number): string[] {
        const height = viewHeight(tui.terminal.rows);
        const visibleCount = Math.max(1, height - 3);
        navigation.update(visibleCount);
        const rows = filtered
          .slice(navigation.firstVisible, navigation.firstVisible + visibleCount)
          .map((model, index) => {
            const prefix = `${navigation.firstVisible + index === navigation.selected ? ">" : " "} [${model.checked ? "x" : " "}] `;
            const label = `${displayText(model.id)}${model.available ? "" : " (Not listed by API)"}`;
            return model.available ? prefix + label : theme.fg("warning", prefix + label);
          });
        if (rows.length === 0)
          rows.push(theme.fg("dim", input.getValue() ? "No matching models" : "No models"));
        const title = `Models: ${displayText(providerName)}`;
        let heading = title;
        if (input.getValue()) {
          const fullPrefix = `${title} • Filter: `;
          const prefix =
            width >= visibleWidth(fullPrefix) + 12 ? fullPrefix : width >= 20 ? "Filter: " : "";
          const queryWidth = Math.max(0, width - visibleWidth(prefix));
          // Input owns cursor-aware horizontal scrolling; omit its prompt and fake cursor styling.
          const query = stripTerminalSequences(input.render(queryWidth + 3)[0] ?? "").slice(2);
          heading = prefix + sliceByColumn(query, 0, queryWidth, true).trimEnd();
        }
        const selectedCount = models.filter((model) => model.checked).length;
        const lines =
          height < 4
            ? rows
            : [
                theme.fg("accent", heading),
                ...rows,
                theme.fg(
                  "dim",
                  `Matches ${filtered.length}/${models.length} • Selected ${selectedCount} • Row ${filtered.length === 0 ? 0 : navigation.selected + 1}/${filtered.length}`,
                ),
                theme.fg(
                  "dim",
                  "Type to filter • ^S save • ^C exit • Esc back • Space/Enter toggle • ↑↓/←→ move",
                ),
              ];
        return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
      },
      handleInput(data: string): void {
        if (matchesKey(data, Key.ctrl("s"))) {
          finish(models.filter((model) => model.checked).map((model) => model.id));
          return;
        }
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          finish(undefined);
          return;
        }
        if (matchesKey(data, Key.space) || matchesKey(data, Key.enter) || data === "\n") {
          const model = filtered[navigation.selected];
          if (model) model.checked = !model.checked;
        } else if (
          data === "j" ||
          data === "k" ||
          !navigation.handleInput(data, Math.max(1, viewHeight(tui.terminal.rows) - 3))
        ) {
          const previous = input.getValue();
          if (matchesKey(data, Key.ctrl("u"))) input.setValue("");
          else input.handleInput(data);
          input.setValue(displayText(input.getValue()));
          if (input.getValue() !== previous) {
            const query = input.getValue().toLowerCase();
            filtered = models.filter((model) => model.id.toLowerCase().includes(query));
            navigation = listNavigation(filtered.length);
          }
        }
        tui.requestRender();
      },
      invalidate(): void {},
      dispose,
    };
  });
}
