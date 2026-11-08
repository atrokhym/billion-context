import test from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_REF, createInitialState, syncBlocks, type CompressionBlock, type CoreMessage } from "acp-kernel";
import { planForkAdoption, applyForkAdoption } from "../src/fork-adoption.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import type { Session } from "../src/session.ts";

/**
 * #1486 unit pin for planForkAdoption's seedAllRefs semantics. The e2e resume
 * scenario (resume-ref-inheritance.test.ts) resends the parent transcript in
 * the same order, so fresh numbering coincides with the parent's — mutation
 * `seedAllRefs: false` survives it. These unit cases craft the hazard
 * directly: the parent assigned refs to messages the resumed client does NOT
 * resend (folded originals, pruned tool noise). Without seeding the refs of
 * every PRESENT message, the seeded prefix ends at the block edge and the
 * child cursor restarts below the parent's max — surviving messages get
 * renumbered and the model's stale citations (it cites any ref it has ever
 * seen) resolve to the wrong messages.
 */

type MinimalSession = { state: { blocks: unknown[]; messageRefs: Record<string, Record<string, string>>; tokenSnapshot?: Record<string, number> } };

function fakeParent(): Session {
    const byRaw: Record<string, string> = {
        raw1: "m00001", raw2: "m00002", raw3: "m00003", raw4: "m00004",
        raw5: "m00005", raw6: "m00006", raw7: "m00007", raw8: "m00008",
    };
    const byRef: Record<string, string> = {};
    for (const [raw, ref] of Object.entries(byRaw)) byRef[ref] = raw;
    const s: MinimalSession = {
        state: {
            blocks: [
                { blockId: "b1", active: true, effectiveMessageIds: ["raw1", "raw2", "raw3"], directBlockIds: [], compressedTokens: 900 },
            ],
            messageRefs: { byRaw, byRef },
            tokenSnapshot: {},
        },
    };
    return s as unknown as Session;
}

test("planForkAdoption seedAllRefs: present-but-uncovered refs keep their parent numbers and hold the cursor at the parent max (#1486)", () => {
    const parent = fakeParent();
    // Resumed body: the block's originals (raw1-3) ARE resent, the tail
    // (raw5-8) is resent; raw4 was pruned tool noise the client never resends
    // — a numbering hole between the block edge and the tail.
    const incoming = new Set(["raw1", "raw2", "raw3", "raw5", "raw6", "raw7", "raw8"]);
    const plan = planForkAdoption(parent, incoming, { seedAllRefs: true, includeBlocks: true });
    assert.equal(plan.refs.byRaw.raw5, "m00005", "present tail message keeps its parent ref");
    assert.equal(plan.refs.byRaw.raw8, "m00008", "last present message keeps its parent ref");
    assert.equal(plan.maxRef, "m00008", "cursor holds at the PARENT max (raw8), not at the block edge — raw4's number is never re-issued");
});

test("planForkAdoption default (no seedAllRefs) seeds only block coverage — documents the resume hazard it exists to close", () => {
    const parent = fakeParent();
    const incoming = new Set(["raw1", "raw2", "raw3", "raw5", "raw6", "raw7", "raw8"]);
    const plan = planForkAdoption(parent, incoming, { seedAllRefs: false, includeBlocks: true });
    assert.equal(plan.refs.byRaw.raw5, undefined, "present-but-uncovered ref is NOT seeded by default");
    assert.equal(plan.maxRef, "m00003", "default cursor stops at the block edge — a resumed child would renumber the tail (why maybeAdoptResume passes seedAllRefs: true)");
});

test("resume adoption never writes the kernel BLOCKED sentinel into byRef (#2620)", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const parent = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: { p1: BLOCKED_REF, p2: BLOCKED_REF, r1: "m00001" }, byRef: { m00001: "r1" } },
        },
    } as unknown as Session;
    const child = {
        state: {
            blocks: [] as unknown[],
            tokenSnapshot: {} as Record<string, number>,
            nextBlockId: 1,
            nextRunId: 1,
            messageRefs: { byRaw: {} as Record<string, string>, byRef: {} as Record<string, string> },
        },
        blockContents: new Map(),
    } as unknown as Session;
    const plan = planForkAdoption(parent, new Set(["p1", "p2", "r1"]), { seedAllRefs: true, includeBlocks: false });
    assert.equal(plan.refs.byRaw.p1, BLOCKED_REF, "plan carries the sentinel in byRaw");
    assert.equal(plan.refs.byRef[BLOCKED_REF], undefined, "plan builder already excludes the sentinel from byRef");
    applyForkAdoption(child, plan, parent);
    assert.equal(child.state.messageRefs.byRaw.p1, BLOCKED_REF);
    assert.equal(child.state.messageRefs.byRef["m00001"], "r1");
    assert.equal(child.state.messageRefs.byRef[BLOCKED_REF], undefined, "applier must not reintroduce byRef[BLOCKED]");
});

// --- #5968: fork adoption must judge complete spans against the CHILD's incoming
// ids, not the parent's transient `active` flag. The parent's LAST request may be
// a short/unrelated view (a subagent call) whose syncBlocks pass deactivates every
// retained fold; a fork resending the full content must still inherit them. The two
// exclusions preserved are the INTENTIONAL deactivations: expanded (user-decompressed)
// and consumed-tier (rides along only as a descendant). ---

function makeBlock(over: Partial<CompressionBlock> & { blockId: string; effectiveMessageIds: string[] }): CompressionBlock {
    const base: CompressionBlock = {
        blockId: over.blockId,
        runId: "run_1",
        tier: 1,
        summary: "S",
        effectiveMessageIds: over.effectiveMessageIds.slice(),
        directMessageIds: over.effectiveMessageIds.slice(),
        directBlockIds: [],
        compressedTokens: 100,
        createdAt: 0,
        survivedCount: 0,
        generation: "young",
        active: true,
    };
    return { ...base, ...over };
}

function seedRefs(state: ReturnType<typeof createInitialState>, count: number): void {
    for (let i = 1; i <= count; i++) {
        const ref = "m" + String(i).padStart(5, "0");
        state.messageRefs.byRaw[`raw${i}`] = ref;
        state.messageRefs.byRef[ref] = `raw${i}`;
    }
}

test("#5968: a fork resending full content inherits folds deactivated by the source's last short view", () => {
    const state = createInitialState();
    state.blocks.push(makeBlock({ blockId: "blk_1", effectiveMessageIds: ["raw1", "raw2"] }));
    seedRefs(state, 2);
    assert.equal(state.blocks[0].active, true);

    // The parent's LAST request is a short, unrelated view (a subagent call):
    // syncBlocks deactivates the retained fold because its raws are absent.
    const afterShort = syncBlocks([{ id: "raw9" } as CoreMessage], state);
    assert.equal(afterShort.state.blocks[0].active, false, "short view deactivates the retained fold");

    // A fork resends the FULL content — it must still adopt the fold.
    const plan = planForkAdoption({ state: afterShort.state } as unknown as Session, new Set(["raw1", "raw2"]));
    assert.equal(plan.adoptedActive, 1, "complete-span fold is adopted despite being inactive in the source");
    assert.equal(plan.blocks.length, 1);
    assert.equal(plan.blocks[0].blockId, "blk_1");
    assert.equal(plan.blocks[0].active, true, "adopted fold is copied ACTIVE into the child");
    assert.equal(afterShort.state.blocks[0].active, false, "planning must not reactivate the source fold");
});

test("#5968: adopted blocks are deep-copied — mutating the child never leaks into the source", () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    const state = createInitialState();
    state.blocks.push(makeBlock({ blockId: "blk_1", effectiveMessageIds: ["raw1", "raw2"], summary: "original" }));
    seedRefs(state, 2);
    const afterShort = syncBlocks([{ id: "raw9" } as CoreMessage], state);
    const parent = { state: afterShort.state, blockContents: new Map() } as unknown as Session;
    const child = { state: createInitialState(), blockContents: new Map() } as unknown as Session;

    const plan = planForkAdoption(parent, new Set(["raw1", "raw2"]));
    applyForkAdoption(child, plan, parent);

    assert.equal(child.state.blocks.length, 1);
    assert.equal(child.state.blocks[0].active, true);
    (child.state.blocks[0] as CompressionBlock).summary = "MUTATED";
    (child.state.blocks[0] as CompressionBlock).directMessageIds.push("leak");
    assert.equal(afterShort.state.blocks[0].summary, "original", "source summary unaffected by child mutation");
    assert.deepEqual(afterShort.state.blocks[0].directMessageIds, ["raw1", "raw2"], "source ids unaffected by child mutation");
});

test("#5968: an explicitly-expanded block stays excluded even when its span is fully present", () => {
    const state = createInitialState();
    state.blocks.push(makeBlock({ blockId: "blk_1", effectiveMessageIds: ["raw1", "raw2"], active: false, expanded: true }));
    seedRefs(state, 2);
    const plan = planForkAdoption({ state } as unknown as Session, new Set(["raw1", "raw2"]));
    assert.equal(plan.adoptedActive, 0, "expanded (user-decompressed) block is NOT re-folded into the child");
    assert.equal(plan.blocks.length, 0);
});

test("#5968: an incomplete span is straddled (not adopted) whether active or short-view-deactivated", () => {
    const state = createInitialState();
    state.blocks.push(makeBlock({ blockId: "blk_1", effectiveMessageIds: ["raw1", "raw2", "raw3"], active: false }));
    seedRefs(state, 3);
    const plan = planForkAdoption({ state } as unknown as Session, new Set(["raw1", "raw2"])); // missing raw3
    assert.equal(plan.adoptedActive, 0, "partial span is not adopted");
    assert.equal(plan.straddled, 1, "partial span counted as straddled");
});

test("#5968: adopting a tier block recovers its consumed children as inactive descendants", () => {
    const state = createInitialState();
    const child = makeBlock({ blockId: "tier_1", effectiveMessageIds: ["raw1"], active: false }); // consumed by its parent
    const top = makeBlock({ blockId: "tier_2", tier: 2, effectiveMessageIds: ["raw1", "raw2"], directBlockIds: ["tier_1"], active: false });
    state.blocks.push(child, top);
    seedRefs(state, 2);
    const plan = planForkAdoption({ state } as unknown as Session, new Set(["raw1", "raw2"]));
    assert.equal(plan.adoptedActive, 1, "only the top-level block counts as adopted-active");
    const byId = new Map(plan.blocks.map((b) => [b.blockId, b]));
    assert.equal(byId.get("tier_2")?.active, true, "top block copied ACTIVE");
    assert.equal(byId.get("tier_1")?.active, false, "consumed child rides along INACTIVE");
});

test("#5968: includeBlocks=false seeds no blocks even for complete spans", () => {
    const state = createInitialState();
    state.blocks.push(makeBlock({ blockId: "blk_1", effectiveMessageIds: ["raw1", "raw2"], active: false }));
    seedRefs(state, 2);
    const plan = planForkAdoption({ state } as unknown as Session, new Set(["raw1", "raw2"]), { includeBlocks: false });
    assert.equal(plan.adoptedActive, 0);
    assert.equal(plan.blocks.length, 0);
});

test("#5968: adopting a fold carries its covered refs so the child can retrieve originals behind them", () => {
    const state = createInitialState();
    state.blocks.push(makeBlock({ blockId: "blk_1", effectiveMessageIds: ["raw1", "raw2"], active: false }));
    seedRefs(state, 2);
    const plan = planForkAdoption({ state } as unknown as Session, new Set(["raw1", "raw2"]));
    assert.equal(plan.adoptedActive, 1);
    assert.equal(plan.refs.byRaw.raw1, "m00001", "covered ref carried into the child's numbering");
    assert.equal(plan.refs.byRaw.raw2, "m00002");
    assert.equal(plan.refs.byRef["m00001"], "raw1");
});
