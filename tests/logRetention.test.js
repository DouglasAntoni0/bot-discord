const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LogRetentionManager,
  partitionOwnedMessages,
  walkMessageHistory,
} = require("../dist/logRetention.js");

function createFakeClock(initialNow = 0) {
  let now = initialNow;
  const timers = [];

  function setTimer(callback, delayMs) {
    const timer = {
      callback,
      dueAt: now + delayMs,
      cleared: false,
      unref() {},
    };
    timers.push(timer);
    return timer;
  }

  function clearTimer(timer) {
    timer.cleared = true;
  }

  async function advance(ms) {
    now += ms;

    while (true) {
      const due = timers
        .filter((timer) => !timer.cleared && timer.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;

      due.cleared = true;
      due.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return { now: () => now, setTimer, clearTimer, advance, timers };
}

test("exclui a mensagem no instante exato da retenção", async () => {
  const clock = createFakeClock();
  const marked = [];
  let deletions = 0;
  const manager = new LogRetentionManager({
    retentionMs: 7_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    markAutomaticDelete: (id) => marked.push(id),
  });
  const message = {
    id: "log-1",
    createdTimestamp: 0,
    async delete() {
      deletions++;
    },
  };

  manager.schedule(message);
  await clock.advance(6_999);
  assert.equal(deletions, 0);

  await clock.advance(1);
  assert.equal(deletions, 1);
  assert.deepEqual(marked, ["log-1"]);
});

test("rearma temporizadores maiores que o limite do Node", async () => {
  const clock = createFakeClock();
  let deletions = 0;
  const manager = new LogRetentionManager({
    retentionMs: 2_500,
    maxTimerDelayMs: 1_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const message = {
    id: "long-timer",
    createdTimestamp: 0,
    async delete() {
      deletions++;
    },
  };

  manager.schedule(message);
  await clock.advance(1_000);
  await clock.advance(1_000);
  assert.equal(deletions, 0);
  await clock.advance(500);
  assert.equal(deletions, 1);
});

test("remove a marca e tenta novamente após uma falha", async () => {
  const clock = createFakeClock(10_000);
  const marked = [];
  const unmarked = [];
  let attempts = 0;
  const manager = new LogRetentionManager({
    retentionMs: 1_000,
    retryDelayMs: 60_000,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    markAutomaticDelete: (id) => marked.push(id),
    unmarkAutomaticDelete: (id) => unmarked.push(id),
  });
  const message = {
    id: "retry-log",
    createdTimestamp: 0,
    async delete() {
      attempts++;
      if (attempts === 1) throw new Error("temporary failure");
    },
  };

  assert.equal(await manager.deleteNow(message), false);
  assert.equal(manager.isScheduled(message.id), true);
  assert.deepEqual(unmarked, [message.id]);

  await clock.advance(60_000);
  assert.equal(attempts, 2);
  assert.equal(manager.isScheduled(message.id), false);
  assert.deepEqual(marked, [message.id, message.id]);
});

test("pagina todo o histórico além das primeiras 100 mensagens", async () => {
  const history = Array.from({ length: 250 }, (_, index) => ({
    id: `message-${index}`,
  }));
  const visited = [];
  const pageSizes = [];

  await walkMessageHistory({
    fetchPage: async (before) => {
      const start = before
        ? history.findIndex((message) => message.id === before) + 1
        : 0;
      return history.slice(start, start + 100);
    },
    handlePage: async (messages) => {
      pageSizes.push(messages.length);
      visited.push(...messages.map((message) => message.id));
    },
  });

  assert.deepEqual(pageSizes, [100, 100, 50]);
  assert.deepEqual(visited, history.map((message) => message.id));
});

test("preserva outros autores e recupera logs vencidas após reinício", () => {
  const day = 24 * 60 * 60 * 1000;
  const messages = [
    { id: "bot-active", author: { id: "bot" }, createdTimestamp: 2 * day },
    { id: "bot-expired", author: { id: "bot" }, createdTimestamp: 0 },
    { id: "human-expired", author: { id: "human" }, createdTimestamp: 0 },
  ];

  const result = partitionOwnedMessages(messages, "bot", 8 * day, 7 * day);

  assert.deepEqual(result.active.map((message) => message.id), ["bot-active"]);
  assert.deepEqual(result.expired.map((message) => message.id), ["bot-expired"]);
});
