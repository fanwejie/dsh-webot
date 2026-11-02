import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A message must be delivered once, even across a restart.
 *
 * The scenario being pinned: the prompt went out, then the process died before the
 * delivered marker reached the disk, and the message is also sitting on the failure queue.
 * Without the marker the replay runs the turn a second time.
 */
const account = {
  accountId: 'a@im.bot',
  userId: 'u1@im.wechat',
  token: 't',
  baseUrl: 'http://127.0.0.1:9',
  boundAt: Date.now(),
}
const KEY = `${account.accountId}:${account.userId}`

function stateWith(pendingInbound, extra = {}) {
  return {
    version: 1,
    accounts: [account],
    syncBufs: {},
    bindings: { [KEY]: { sessionId: 's1', cwd: '.', createdAt: Date.now() } },
    contextTokens: {},
    pendingInbound,
    ...extra,
  }
}

function queued(id, text) {
  return {
    accountId: account.accountId,
    userId: account.userId,
    message: {
      message_id: id,
      message_type: 1,
      from_user_id: account.userId,
      item_list: [{ type: 1, text_item: { text } }],
    },
    attempts: 1,
  }
}

function makeHome(state) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webot-idem-'))
  process.env.DSH_HOME = home
  const stateDir = path.join(home, 'webot')
  fs.mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, 'state.json')
  fs.writeFileSync(file, JSON.stringify(state), 'utf8')
  return { home, stateDir, file }
}

/** Start a channel against an existing home; returns it plus what it delivered. */
async function startChannel(home) {
  const { createChannel } = await import('../src/channel.js')
  const prompts = []
  const channel = createChannel({
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      prompt: async (request) => {
        prompts.push(request.content[0].text)
        return {}
      },
      list: async () => ({ items: [] }),
    },
    workspaceDirectory: path.join(home, 'dsh_webot'),
  })
  return { channel, prompts }
}

test('a message queued before a restart is not delivered twice after it', async () => {
  const { home, stateDir, file } = makeHome(stateWith([queued('r1', '重启前排队的一条')]))

  // First run: the message is delivered and its id is recorded.
  const first = await startChannel(home)
  await first.channel.replayPendingInbound()
  first.channel.stopAll()
  assert.equal(first.prompts.length, 1, 'delivered once')

  const afterFirst = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(afterFirst.deliveredInbound, ['r1'], 'the id reached the disk')
  assert.equal((afterFirst.pendingInbound || []).length, 0, 'and the queue is empty')

  // A crash that lost the queue removal would leave the message queued again; the marker
  // is what keeps the restart from running it a second time.
  fs.writeFileSync(
    file,
    JSON.stringify({ ...afterFirst, pendingInbound: [queued('r1', '重启前排队的一条')] }),
    'utf8',
  )

  const second = await startChannel(home)
  await second.channel.replayPendingInbound()
  const log = fs.readFileSync(path.join(stateDir, 'events.log'), 'utf8')
  second.channel.stopAll()

  assert.equal(second.prompts.length, 0, 'the restart must not deliver it again')
  assert.match(log, /replay skipped, already delivered \| r1/)
})

test('the same message queued twice in one process is delivered once', async () => {
  const { home, file } = makeHome(stateWith([queued('r2', '重复的一条')]))

  const { channel, prompts } = await startChannel(home)
  try {
    await channel.replayPendingInbound()
    assert.equal(prompts.length, 1)

    // Put the identical message back on the queue, as a partial write would.
    const state = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(
      file,
      JSON.stringify({ ...state, pendingInbound: [queued('r2', '重复的一条')] }),
      'utf8',
    )

    await channel.replayPendingInbound()
    assert.equal(prompts.length, 1, 'still once')
    assert.equal(channel.snapshot().pendingInbound, 0, 'and nothing is left waiting')
  } finally {
    channel.stopAll()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('two different messages are both delivered', async () => {
  const { home } = makeHome(stateWith([queued('r3', '第一条'), queued('r4', '第二条')]))
  const { channel, prompts } = await startChannel(home)
  try {
    await channel.replayPendingInbound()
    assert.equal(prompts.length, 2, 'both, and only once each')
  } finally {
    channel.stopAll()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
