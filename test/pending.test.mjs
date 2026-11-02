import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The failed-message queue must not lose messages quietly.
 *
 * A message that fails is kept because the poll cursor has already moved past it and the
 * gateway will never resend it. The queue can still lose one three ways — overflow, a
 * failed state write, and a replay of something already delivered — and each has to be
 * visible rather than silent.
 */
const account = {
  accountId: 'a@im.bot',
  userId: 'u1@im.wechat',
  token: 't',
  baseUrl: 'http://127.0.0.1:9',
  boundAt: Date.now(),
}
const KEY = `${account.accountId}:${account.userId}`

function baseState(extra = {}) {
  return {
    version: 1,
    accounts: [account],
    syncBufs: {},
    bindings: { [KEY]: { sessionId: 's1', cwd: '.', createdAt: Date.now() } },
    contextTokens: {},
    ...extra,
  }
}

function message(id, text) {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: account.userId,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

function pendingEntry(id, text, attempts = 1) {
  return { accountId: account.accountId, userId: account.userId, message: message(id, text), attempts }
}

/**
 * Build a home folder, write the state, and start a channel against it.
 *
 * `failPrompt` makes delivery throw, which is what puts a message back on the queue.
 * `failWrites` injects a store whose writes raise EPERM, which is how a real permission
 * failure looks — no file modes involved, so the result does not depend on the account
 * the tests run as or on the filesystem.
 */
async function withChannel(state, run, { failPrompt = false, failWrites = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webot-queue-'))
  process.env.DSH_HOME = home
  const stateDir = path.join(home, 'webot')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(baseState(state)), 'utf8')

  const { createChannel } = await import('../src/channel.js')
  const { readState, updateState } = await import('../src/state.js')
  const writes = []
  const store = failWrites
    ? {
        read: () => readState(),
        write: (patch) => {
          writes.push(Object.keys(patch))
          const error = new Error('EPERM: operation not permitted, rename')
          error.code = 'EPERM'
          throw error
        },
      }
    : {
        read: () => readState(),
        write: (patch) => {
          writes.push(Object.keys(patch))
          return updateState(patch)
        },
      }

  const prompts = []
  const channel = createChannel({
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      prompt: async (request) => {
        if (failPrompt) throw new Error('session refused the prompt')
        prompts.push(request.content[0].text)
        return {}
      },
      list: async () => ({ items: [] }),
    },
    workspaceDirectory: path.join(home, 'dsh_webot'),
    stateStore: store,
  })
  const logPath = path.join(stateDir, 'events.log')
  const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '')
  try {
    await run(channel, { home, prompts, stateDir, readLog, writes })
  } finally {
    channel.stopAll()
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('a queued message is delivered on replay and then removed from the queue', async () => {
  await withChannel(
    { pendingInbound: [pendingEntry('m1', '之前失败的消息', 2)] },
    async (channel, { prompts, stateDir }) => {
      await channel.replayPendingInbound()
      assert.equal(prompts.length, 1, 'the message is handed to the session')
      assert.match(JSON.stringify(prompts[0]), /之前失败的消息/)
      assert.equal(channel.snapshot().pendingInbound, 0, 'the queue is emptied')
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
      assert.equal((state.pendingInbound || []).length, 0)
    },
  )
})

test('a message whose account disappeared is dropped, not retried forever', async () => {
  await withChannel(
    {
      accounts: [],
      bindings: {},
      pendingInbound: [{ accountId: 'gone@im.bot', userId: 'u', message: message('m2', 'x'), attempts: 1 }],
    },
    async (channel) => {
      await channel.replayPendingInbound()
      assert.equal(channel.snapshot().pendingInbound, 0)
    },
  )
})

test('the snapshot reports the queue length', async () => {
  await withChannel(
    { pendingInbound: [pendingEntry('m3', 'x')] },
    async (channel) => {
      assert.equal(channel.snapshot().pendingInbound, 1)
    },
  )
})

// --- the three ways it could lose a message silently ------------------------------

test('the queue never grows past its cap, however often it is replayed', async () => {
  // The state file caps itself at 20 on load, and re-queueing the same id replaces
  // rather than appends, so the overflow branch is not reachable from here. What this
  // asserts is the invariant that matters: repeated failures never grow the queue.
  const entries = []
  for (let index = 0; index < 25; index += 1) {
    entries.push(pendingEntry(`over-${index}`, `失败消息 ${index}`, 0))
  }
  await withChannel({ pendingInbound: entries }, async (channel) => {
    await channel.replayPendingInbound()
    assert.equal(channel.snapshot().pendingInbound, 20, 'the queue is capped at 20')
    await channel.replayPendingInbound()
    assert.equal(channel.snapshot().pendingInbound, 20, 'and stays capped across replays')
  }, { failPrompt: true })
})

test('a failed state write is logged, and the message is still delivered', async () => {
  await withChannel(
    { pendingInbound: [pendingEntry('w1', '写盘会失败')] },
    async (channel, { prompts, readLog, writes }) => {
      await channel.replayPendingInbound()
      assert.equal(prompts.length, 1, 'the message is still delivered')
      assert.ok(
        writes.some((keys) => keys.includes('deliveredInbound')),
        'the write was attempted, so the failure is about the store, not a skipped call',
      )
      assert.match(readLog(), /delivered marker not persisted/, 'the write failure is reported')
      assert.match(readLog(), /will retry/, 'and the retry is announced')
    },
    { failWrites: true },
  )
})

test('a message already delivered is not run twice', async () => {
  await withChannel(
    { pendingInbound: [pendingEntry('d1', '已经投递过的消息')], deliveredInbound: ['d1'] },
    async (channel, { prompts, readLog }) => {
      await channel.replayPendingInbound()
      assert.equal(prompts.length, 0, 'the turn must not run again')
      assert.equal(channel.snapshot().pendingInbound, 0, 'and the entry is cleared')
      assert.match(readLog(), /replay skipped, already delivered/)
    },
  )
})

test('a successful delivery records its id for the next replay', async () => {
  await withChannel(
    { pendingInbound: [pendingEntry('r1', '正常投递')] },
    async (channel, { prompts, stateDir }) => {
      await channel.replayPendingInbound()
      assert.equal(prompts.length, 1)
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
      assert.deepEqual(state.deliveredInbound, ['r1'], 'the id is persisted')
    },
  )
})
