import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../host/config.ts";
import { ConversationService } from "../host/conversations.ts";
import { Hub } from "../host/hub.ts";
import { SystemNotifications } from "../host/system-notifications.ts";
import { Store } from "../host/store.ts";

const scratch = mkdtempSync(join(tmpdir(), "subagent-put-away-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A Claude conversation, put away, on an agent session its stand-in process closes and reopens with its context. */
function putAwayConversation() {
  const store = new Store(":memory:");
  const project = join(scratch, `project-${crypto.randomUUID()}`);
  mkdirSync(project);
  store.saveProfile({ id: "p1", name: "p", harness: "claude", environment: "", prelaunch: "", model: null, mode: null, effort: null, bypassPermissions: false, askMode: "wait", color: null, pluginsOff: [], createdAt: 1 });
  store.insertWorkspace({ id: "w1", name: "p", path: project, defaultLaunch: { harness: "claude", profileId: "p1" }, createdAt: 1 });
  const config = loadConfig({ MIRADOR_DATA_DIR: join(scratch, `data-${crypto.randomUUID()}`) });
  const conversations = new ConversationService(store, new Hub(), config, {} as never, {} as never, {} as never, new SystemNotifications(store, new Hub()));
  // Not `create`, which opens a session on a real agent process at once.
  const conversation = (conversations as unknown as { insertConversation(workspaceId: string, launch: object, title: string, titleSetByUser: boolean): { id: string } }).insertConversation("w1", { harness: "claude", profileId: "p1" }, "Untitled", false);
  const conversationId = conversation.id;
  store.setReminder(conversationId, { at: Date.now() + 3_600_000, mode: "away" });

  const closedSessions: string[] = [];
  const agent = {
    reopening: async () => ({ close: true, resume: false, load: true }),
    closeSession: async (sessionId: string) => void closedSessions.push(sessionId),
    stop: async () => {},
  };
  const inside = conversations as unknown as {
    sessions: { bind(conversationId: string, sessionId: string): void };
    runtime(conversationId: string): { harness?: object; sessionId?: Promise<string> };
    freeSessionIfSettled(conversationId: string, options?: { justPutAway?: boolean }): Promise<void>;
    handleSessionUpdate(notification: unknown): void;
  };
  inside.sessions.bind(conversationId, "s1");
  const runtime = inside.runtime(conversationId);
  runtime.harness = agent;
  runtime.sessionId = Promise.resolve("s1");

  const subagentTaskReported = (toolCallId: string, subagentTaskStatus: string) =>
    inside.handleSessionUpdate({ sessionId: "s1", update: { sessionUpdate: "tool_call_update", toolCallId, _meta: { claudeCode: { subagentTaskStatus } } } });
  return { conversationId, runtime, agent, closedSessions, inside, subagentTaskReported };
}

test("putting away a conversation with no subagent at work frees its session at once", async () => {
  const { conversationId, inside, runtime, closedSessions } = putAwayConversation();
  await inside.freeSessionIfSettled(conversationId, { justPutAway: true });
  expect(closedSessions).toEqual(["s1"]);
  expect(runtime.harness).toBeUndefined();
});

test("putting away a conversation with a subagent at work keeps its session", async () => {
  const { conversationId, inside, runtime, agent, closedSessions, subagentTaskReported } = putAwayConversation();
  subagentTaskReported("a1", "running");
  await inside.freeSessionIfSettled(conversationId, { justPutAway: true });
  expect(closedSessions).toEqual([]);
  expect(runtime.harness).toBe(agent);
});

test("a put-away conversation whose subagent ends has its session freed then, without anyone putting it away again", async () => {
  const { conversationId, inside, runtime, closedSessions, subagentTaskReported } = putAwayConversation();
  subagentTaskReported("a1", "running");
  await inside.freeSessionIfSettled(conversationId, { justPutAway: true });
  expect(closedSessions).toEqual([]);
  subagentTaskReported("a1", "completed");
  await Bun.sleep(20);
  expect(closedSessions).toEqual(["s1"]);
  expect(runtime.harness).toBeUndefined();
});

test("a put-away conversation with two subagents at work keeps its session until the last one ends", async () => {
  const { conversationId, inside, closedSessions, subagentTaskReported } = putAwayConversation();
  subagentTaskReported("a1", "running");
  subagentTaskReported("a2", "running");
  await inside.freeSessionIfSettled(conversationId, { justPutAway: true });
  subagentTaskReported("a1", "completed");
  await Bun.sleep(20);
  expect(closedSessions, "one task still at work").toEqual([]);
  subagentTaskReported("a2", "completed");
  await Bun.sleep(20);
  expect(closedSessions).toEqual(["s1"]);
});
