import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  selectProvider,
  selectProviderModels,
  type ModelChoice,
  type ProviderListState,
} from "../src/ui.ts";

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type Component = Awaited<ReturnType<Factory>>;
type Interact = (component: Component, terminal: { rows: number }, renders: () => number) => void;

function context(interact: Interact): ExtensionContext {
  const terminal = { rows: 24 };
  let renders = 0;
  return {
    ui: {
      custom(factory: Factory): Promise<unknown> {
        return new Promise<unknown>((done) => {
          const component = factory(
            { terminal, requestRender: () => renders++ } as unknown as Parameters<Factory>[0],
            {
              fg: (color: string, text: string) =>
                color === "warning" ? `\x1b[33m${text}\x1b[39m` : text,
            } as Parameters<Factory>[1],
            {} as Parameters<Factory>[2],
            done,
          );
          assert.ok(!("then" in component));
          interact(component, terminal, () => renders);
        });
      },
    },
  } as ExtensionContext;
}

function run(
  choices: readonly ModelChoice[],
  interact: Interact,
  providerName = "test-provider",
): Promise<string[] | undefined> {
  return selectProviderModels(context(interact), providerName, choices);
}

const choices: readonly ModelChoice[] = [
  { id: "first", checked: true, available: true },
  { id: "missing", checked: true, available: false },
  { id: "third", checked: false, available: true },
];

for (const screen of ["providers", "models"] as const) {
  describe(`${screen} list navigation`, () => {
    function show(count: number, interact: Interact) {
      const names = Array.from({ length: count }, (_, index) => `item-${index}`);
      const ctx = context(interact);
      return screen === "providers"
        ? selectProvider(ctx, names)
        : selectProviderModels(
            ctx,
            "test-provider",
            names.map((id) => ({ id, checked: false, available: true })),
          );
    }

    function assertWindow(component: Component, first: number, selected: number, count = 13) {
      const rows = component.render(200).slice(1, -2);
      assert.equal(rows.length, count);
      assert.ok(rows[0]?.endsWith(`item-${first}`));
      assert.equal(
        rows.findIndex((row) => row.startsWith("> ")),
        selected - first,
      );
      assert.ok(rows[selected - first]?.endsWith(`item-${selected}`));
    }

    it("scrolls by one row at the viewport edges when moving up/down", async () => {
      await show(40, (component, _terminal, renders) => {
        for (let index = 0; index < 12; index++) component.handleInput?.("\x1b[B");
        assertWindow(component, 0, 12);
        component.handleInput?.("\x1b[B");
        assertWindow(component, 1, 13);
        component.handleInput?.("\x1b[B");
        assertWindow(component, 2, 14);
        for (let index = 0; index < 13; index++) component.handleInput?.("\x1b[A");
        assertWindow(component, 1, 1);
        component.handleInput?.("\x1b[A");
        assertWindow(component, 0, 0);
        assert.ok(renders() > 0);
        component.handleInput?.("\x1b");
      });
    });

    it("preserves the cursor row and fills the last viewport when paging", async () => {
      for (const count of [30, 39]) {
        await show(count, (component) => {
          for (let index = 0; index < 3; index++) component.handleInput?.("\x1b[B");
          component.handleInput?.("\x1b[C");
          assertWindow(component, 13, 16);
          component.handleInput?.("\x1b[C");
          const lastFirst = count - 13;
          assertWindow(component, lastFirst, lastFirst + 3);
          component.handleInput?.("\x1b[C");
          assertWindow(component, lastFirst, count - 1);
          component.handleInput?.("\x1b[D");
          const previousFirst = Math.max(0, lastFirst - 13);
          assertWindow(component, previousFirst, previousFirst + 12);
          component.handleInput?.("\x1b[D");
          assertWindow(component, 0, 12);
          component.handleInput?.("\x1b[D");
          assertWindow(component, 0, 0);
          component.handleInput?.("\x1b");
        });
      }
    });

    it("uses the current viewport size after resizing", async () => {
      await show(40, (component, terminal) => {
        for (let index = 0; index < 3; index++) component.handleInput?.("\x1b[B");
        component.handleInput?.("\x1b[C");
        assertWindow(component, 13, 16);
        terminal.rows = 8;
        component.invalidate();
        component.handleInput?.("\x1b[C");
        assertWindow(component, 17, 19, 3);
        component.handleInput?.("\x1b[D");
        assertWindow(component, 14, 16, 3);
        component.handleInput?.("\x1b");
      });
    });

    it("clamps to either end of a single-page list and can confirm", async () => {
      const result = await show(3, (component) => {
        component.handleInput?.("\x1b[C");
        assertWindow(component, 0, 2, 3);
        component.handleInput?.("\x1b[D");
        assertWindow(component, 0, 0, 3);
        component.handleInput?.("\r");
        if (screen === "models") component.handleInput?.("\x13");
      });
      assert.deepEqual(result, screen === "providers" ? "item-0" : ["item-0"]);
    });

    it("handles an empty list and cancels without a selection", async () => {
      assert.equal(
        await show(0, (component) => {
          for (const key of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\r"])
            component.handleInput?.(key);
          assert.ok(
            component.render(200).includes(screen === "providers" ? "No providers" : "No models"),
          );
          component.handleInput?.("\x1b");
        }),
        undefined,
      );
    });
  });
}

describe("selectProvider", () => {
  it("restores the provider and viewport after visiting its models", async () => {
    const names = Array.from({ length: 40 }, (_, index) => `provider-${index}`);
    const state: ProviderListState = { selected: undefined, firstVisible: 0 };
    const selected = await selectProvider(
      context((component) => {
        for (let index = 0; index < 3; index++) component.handleInput?.("\x1b[B");
        component.handleInput?.("\x1b[C");
        assert.deepEqual(state, { selected: "provider-16", firstVisible: 13 });
        component.handleInput?.("\r");
      }),
      names,
      undefined,
      state,
    );
    assert.equal(selected, "provider-16");
    await run(choices, (component) => component.handleInput?.("\x1b"), selected);
    assert.equal(
      await selectProvider(
        context((component) => {
          const rows = component.render(200).slice(1, -2);
          assert.equal(rows[0], "  provider-13");
          assert.equal(rows[3], "> provider-16");
          component.handleInput?.("\r");
        }),
        names,
        undefined,
        state,
      ),
      "provider-16",
    );
  });

  it("restores by name across reordering and resets removed or empty selections", async () => {
    const state: ProviderListState = { selected: "second", firstVisible: 10 };
    await selectProvider(
      context((component) => {
        assert.equal(component.render(200)[1], "> second");
        assert.deepEqual(state, { selected: "second", firstVisible: 0 });
        component.handleInput?.("\r");
      }),
      ["second", "first"],
      undefined,
      state,
    );
    await selectProvider(
      context((component) => {
        assert.equal(component.render(200)[1], "> replacement");
        assert.deepEqual(state, { selected: "replacement", firstVisible: 0 });
        component.handleInput?.("\r");
      }),
      ["replacement"],
      undefined,
      state,
    );
    await selectProvider(
      context((component) => {
        component.render(200);
        assert.deepEqual(state, { selected: undefined, firstVisible: 0 });
        component.handleInput?.("\x1b");
      }),
      [],
      undefined,
      state,
    );
  });

  it("clamps restored scrolling on resize, rendering and confirmation", async () => {
    const names = Array.from({ length: 40 }, (_, index) => `provider-${index}`);
    const state: ProviderListState = { selected: "provider-39", firstVisible: 39 };
    await selectProvider(
      context((component, terminal) => {
        component.render(200);
        assert.deepEqual(state, { selected: "provider-39", firstVisible: 27 });
        terminal.rows = 8;
        component.render(200);
        assert.deepEqual(state, { selected: "provider-39", firstVisible: 37 });
        component.handleInput?.("\x1b[A");
        assert.deepEqual(state, { selected: "provider-38", firstVisible: 37 });
        terminal.rows = 24;
        component.handleInput?.("\r");
        assert.deepEqual(state, { selected: "provider-38", firstVisible: 27 });
      }),
      names,
      undefined,
      state,
    );
  });
  it("sanitizes labels, supports j/k, and confirms the original provider name", async () => {
    const name = "provider\n\x1b[31m";
    const result = await selectProvider(
      context((component) => {
        assert.ok(component.render(200).every((line) => !/\p{Cc}/u.test(line)));
        component.handleInput?.("j");
        component.handleInput?.("k");
        component.handleInput?.("\n");
      }),
      [name, "other"],
    );
    assert.equal(result, name);
  });
});

describe("selectProviderModels", () => {
  it("moves up/down, toggles with Space/Enter and saves checked IDs in row order", async () => {
    const original = structuredClone(choices);
    const result = await run(choices, (component, _terminal, renders) => {
      component.handleInput?.("\x1b[A");
      component.handleInput?.(" ");
      assert.equal(component.render(200)[1], "> [ ] first");
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\r");
      component.handleInput?.("\x1b[B");
      component.handleInput?.(" ");
      component.handleInput?.("\x1b[A");
      component.handleInput?.("\r");
      assert.ok(renders() > 0);
      component.handleInput?.("\x13");
    });
    assert.deepEqual(result, ["missing", "third"]);
    assert.deepEqual(choices, original);
  });

  it("keeps checkbox state while paging in both directions", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      id: `model-${index}`,
      checked: false,
      available: true,
    }));
    const result = await run(many, (component) => {
      for (let index = 0; index < 3; index++) component.handleInput?.("\x1b[B");
      component.handleInput?.(" ");
      component.handleInput?.("\x1b[C");
      component.handleInput?.(" ");
      component.handleInput?.("\x1b[C");
      component.handleInput?.(" ");
      component.handleInput?.("\x1b[D");
      component.handleInput?.("\x13");
    });
    assert.deepEqual(result, ["model-3", "model-16", "model-20"]);
  });

  it("uses warning yellow plus an unavailable label even on the selected row", async () => {
    await run(choices, (component) => {
      component.handleInput?.("\x1b[B");
      const lines = component.render(100);
      assert.ok(lines.includes("\x1b[33m> [x] missing (Not listed by API)\x1b[39m"));
      assert.ok(lines.includes("  [x] first"));
      component.handleInput?.("\x1b");
    });
  });

  it("returns [] when every model is unchecked", async () => {
    assert.deepEqual(
      await run(choices, (component) => {
        component.handleInput?.(" ");
        component.handleInput?.("\x1b[B");
        component.handleInput?.("\r");
        component.handleInput?.("\x13");
      }),
      [],
    );
  });

  it("returns undefined on Escape without changing the input", async () => {
    const original = structuredClone(choices);
    assert.equal(
      await run(choices, (component) => {
        component.handleInput?.(" ");
        component.handleInput?.("\x1b");
      }),
      undefined,
    );
    assert.deepEqual(choices, original);
  });

  it("can save an empty selection from an empty list", async () => {
    assert.deepEqual(await run([], (component) => component.handleInput?.("\x13")), []);
  });

  it("removes control characters only from display text and preserves saved IDs", async () => {
    const id = "model\n\x1b[31m\t\x9bname";
    const result = await run(
      [{ id, checked: true, available: true }],
      (component) => {
        assert.ok(component.render(300).every((line) => !/\p{Cc}/u.test(line)));
        component.handleInput?.("\x13");
      },
      "provider\n\x1b[2J\r\x9bname",
    );
    assert.deepEqual(result, [id]);
  });

  it("recalculates its height and terminal-column width after resize", async () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: `model-${index}-日本語😀`.repeat(5),
      checked: false,
      available: index !== 20,
    }));
    await run(many, (component, terminal) => {
      assert.ok(component.render(100).length <= 16);
      for (let index = 0; index < 20; index++) component.handleInput?.("\x1b[B");
      terminal.rows = 8;
      component.invalidate();
      let lines = component.render(30);
      assert.ok(lines.length <= 6);
      assert.ok(lines.some((line) => line.includes("> [ ] model-20")));
      for (const width of [0, 1, 2, 10, 30]) {
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      }
      terminal.rows = 40;
      lines = component.render(200);
      assert.ok(lines.length <= 16);
      assert.ok(lines.some((line) => line.includes("> [ ] model-20")));
      terminal.rows = 2;
      assert.equal(component.render(30).length, 1);
      component.handleInput?.("\x1b");
    });
  });
});

describe("model search", () => {
  it("counts all checks including hidden ones through toggles and clearing", async () => {
    const result = await run(choices, (component) => {
      const counter = () => component.render(300).at(-2);
      assert.equal(counter(), "Matches 3/3 • Selected 2 • Row 1/3");
      component.handleInput?.("third");
      assert.equal(counter(), "Matches 1/3 • Selected 2 • Row 1/1");
      component.handleInput?.(" ");
      assert.equal(counter(), "Matches 1/3 • Selected 3 • Row 1/1");
      component.handleInput?.("\r");
      assert.equal(counter(), "Matches 1/3 • Selected 2 • Row 1/1");
      component.handleInput?.("\x15");
      component.handleInput?.("\x1b[B");
      assert.equal(counter(), "Matches 3/3 • Selected 2 • Row 2/3");
      component.handleInput?.("\x13");
    });
    assert.deepEqual(result, ["first", "missing"]);
    await run([], (component) => {
      assert.equal(component.render(300).at(-2), "Matches 0/0 • Selected 0 • Row 0/0");
      component.handleInput?.(" ");
      component.handleInput?.("missing");
      assert.equal(component.render(300).at(-2), "Matches 0/0 • Selected 0 • Row 0/0");
      component.handleInput?.("\x1b");
    });
  });

  it("scrolls long queries to the editing cursor without reducing model rows", async () => {
    const query = "abcdefghijklmnopqrstuvwxy".repeat(5) + "TAIL";
    const models = Array.from({ length: 20 }, (_, index) => ({
      id: `${query}-${index}`,
      checked: index === 19,
      available: true,
    }));
    await run(models, (component) => {
      component.handleInput?.(query);
      const lines = component.render(65);
      assert.ok(lines[0]?.startsWith("Models: test-provider • Filter: "));
      assert.ok(lines[0]?.endsWith("TAIL"));
      assert.equal(lines.slice(1, -2).length, 13);
      assert.ok(component.render(25)[0]?.startsWith("Filter: "));
      assert.ok(component.render(25)[0]?.endsWith("TAIL"));
      assert.ok(component.render(10)[0]?.endsWith("TAIL"));
      assert.ok(visibleWidth(component.render(1)[0] ?? "") <= 1);
      assert.equal(component.render(0)[0], "");
      component.handleInput?.("\x01");
      assert.ok(component.render(65)[0]?.includes("Filter: abcdef"));
      component.handleInput?.("START");
      assert.ok(component.render(65)[0]?.includes("Filter: STARTabc"));
      component.handleInput?.("\x1b[F");
      assert.ok(component.render(65)[0]?.endsWith("TAIL"));
      component.handleInput?.("\x7f");
      assert.ok(component.render(65)[0]?.endsWith("TAI"));
      component.handleInput?.("\x15");
      assert.equal(component.render(65)[0], "Models: test-provider");
      component.handleInput?.("\x1b");
    });
  });

  it("uses Unicode cell widths and keeps pasted controls out of scrolled queries", async () => {
    await run(choices, (component) => {
      component.handleInput?.("\x1b[200~" + "日本語😀é".repeat(20) + "\x1b[31m\x9bTAIL\x1b[201~");
      for (const width of [0, 1, 2, 3, 10, 20, 50, 100]) {
        const lines = component.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(!/\p{Cc}/u.test(lines[0] ?? ""));
        if (width >= 10) assert.ok(lines[0]?.endsWith("TAIL"));
      }
      component.handleInput?.("\x7f");
      assert.ok(component.render(50)[0]?.endsWith("TAI"));
      component.handleInput?.("\x15");
      component.handleInput?.("日本語😀".repeat(20));
      assert.ok(component.render(50)[0]?.endsWith("日本語😀"));
      component.handleInput?.("\x7f");
      assert.ok(component.render(50)[0]?.endsWith("日本語"));
      component.handleInput?.("\x1b");
    });
  });
  it("matches model ID substrings case-insensitively and saves hidden checks", async () => {
    const models = [
      { id: "prefix-GPT-Suffix", checked: false, available: true },
      { id: "hidden", checked: true, available: true },
      { id: "gpt-other", checked: false, available: true },
    ];
    const original = structuredClone(models);
    const result = await run(models, (component) => {
      component.handleInput?.("\x1b[B");
      component.handleInput?.("gPt");
      const lines = component.render(300);
      assert.equal(lines[0], "Models: test-provider • Filter: gPt");
      assert.deepEqual(lines.slice(1, -2), ["> [ ] prefix-GPT-Suffix", "  [ ] gpt-other"]);
      assert.equal(lines.at(-2), "Matches 2/3 • Selected 1 • Row 1/2");
      component.handleInput?.(" ");
      component.handleInput?.("\x1b[B");
      component.handleInput?.("\r");
      component.handleInput?.("\x13");
    });
    assert.deepEqual(result, ["prefix-GPT-Suffix", "hidden", "gpt-other"]);
    assert.deepEqual(models, original);
  });

  it("edits and clears search with Backspace and Ctrl+U, restoring the exact title", async () => {
    await run(choices, (component) => {
      component.handleInput?.("thirdx");
      assert.ok(component.render(300).includes("No matching models"));
      component.handleInput?.("\x7f");
      assert.equal(component.render(300)[1], "> [ ] third");
      for (let index = 0; index < 5; index++) component.handleInput?.("\x7f");
      assert.equal(component.render(300)[0], "Models: test-provider");
      assert.equal(component.render(300)[1], "> [x] first");
      component.handleInput?.("missing");
      component.handleInput?.("\x01");
      component.handleInput?.("\x15");
      assert.equal(component.render(300)[0], "Models: test-provider");
      component.handleInput?.("\x1b");
    });
  });

  it("treats j/k as search characters rather than navigation", async () => {
    const models = ["first", "jack", "joke"].map((id) => ({ id, checked: false, available: true }));
    assert.deepEqual(
      await run(models, (component) => {
        component.handleInput?.("j");
        assert.deepEqual(component.render(300).slice(1, -2), ["> [ ] jack", "  [ ] joke"]);
        component.handleInput?.("k");
        assert.ok(component.render(300).includes("No matching models"));
        component.handleInput?.("\x7f");
        component.handleInput?.(" ");
        component.handleInput?.("\x13");
      }),
      ["jack"],
    );
  });

  it("keeps 13 rows and paging/scrolling behavior with an active query", async () => {
    const models = Array.from({ length: 35 }, (_, index) => ({
      id: index < 30 ? `MATCH-${index}` : `other-${index}`,
      checked: false,
      available: true,
    }));
    await run(models, (component) => {
      component.handleInput?.("match");
      for (let index = 0; index < 3; index++) component.handleInput?.("\x1b[B");
      component.handleInput?.("\x1b[C");
      let rows = component.render(300).slice(1, -2);
      assert.equal(rows.length, 13);
      assert.equal(rows[0], "  [ ] MATCH-13");
      assert.equal(rows[3], "> [ ] MATCH-16");
      component.handleInput?.("\x1b[C");
      rows = component.render(300).slice(1, -2);
      assert.equal(rows.length, 13);
      assert.equal(rows[0], "  [ ] MATCH-17");
      assert.equal(rows[3], "> [ ] MATCH-20");
      component.handleInput?.("\x1b[D");
      rows = component.render(300).slice(1, -2);
      assert.equal(rows[0], "  [ ] MATCH-4");
      assert.equal(rows[3], "> [ ] MATCH-7");
      component.handleInput?.("\x15");
      rows = component.render(300).slice(1, -2);
      assert.equal(rows[0], "> [ ] MATCH-0");
      for (let index = 0; index < 13; index++) component.handleInput?.("\x1b[B");
      assert.equal(component.render(300)[1], "  [ ] MATCH-1");
      component.handleInput?.("\x1b");
    });
  });

  it("keeps Save, Escape and Ctrl+C usable with zero matches", async () => {
    for (const key of ["\x13", "\x1b", "\x03"]) {
      const result = await run(choices, (component) => {
        component.handleInput?.("no-such-id");
        for (const input of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", " ", "\r"])
          component.handleInput?.(input);
        assert.ok(component.render(300).includes("No matching models"));
        assert.equal(component.render(300).at(-2), "Matches 0/3 • Selected 2 • Row 0/0");
        component.handleInput?.(key);
      });
      assert.deepEqual(result, key === "\x13" ? ["first", "missing"] : undefined);
    }
  });

  it("sanitizes pasted query display and truncates every line", async () => {
    await run(choices, (component) => {
      component.handleInput?.("\x1b[200~long query\x1b[31m\x9b\t日本語😀\x1b[201~");
      const lines = component.render(300);
      assert.ok(lines[0]?.includes("Filter: long query"));
      assert.ok(lines.every((line) => !/\p{Cc}/u.test(line)));
      for (const width of [0, 1, 10, 30]) {
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      }
      component.handleInput?.("\x1b");
    });
  });
});

for (const screen of ["providers", "models"] as const) {
  describe(`${screen} cancellation`, () => {
    function show(interact: Interact, signal?: AbortSignal) {
      const ctx = context(interact);
      return screen === "providers"
        ? selectProvider(ctx, ["test-provider"], signal)
        : selectProviderModels(ctx, "test-provider", choices, signal);
    }

    it("closes on direct Ctrl+C", async () => {
      assert.equal(await show((component) => component.handleInput?.("\x03")), undefined);
    });

    it("closes on signal abort and removes the abort listener", async () => {
      const controller = new AbortController();
      assert.equal(
        await show(() => {
          assert.equal(getEventListeners(controller.signal, "abort").length, 1);
          controller.abort();
          assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        }, controller.signal),
        undefined,
      );
    });

    it("does not open a dialog with an already-aborted signal", async () => {
      assert.equal(await show(() => assert.fail("dialog opened"), AbortSignal.abort()), undefined);
    });

    it("removes the abort listener on confirmation and cancellation", async () => {
      for (const key of [screen === "providers" ? "\r" : "\x13", "\x1b", "\x03"]) {
        const controller = new AbortController();
        await show((component) => {
          assert.equal(getEventListeners(controller.signal, "abort").length, 1);
          component.handleInput?.(key);
          assert.equal(getEventListeners(controller.signal, "abort").length, 0);
          controller.abort();
        }, controller.signal);
      }
    });

    it("removes the abort listener when disposed", async () => {
      const controller = new AbortController();
      await show((component) => {
        assert.equal(getEventListeners(controller.signal, "abort").length, 1);
        component.dispose?.();
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        component.handleInput?.("\x1b");
      }, controller.signal);
    });
  });
}
