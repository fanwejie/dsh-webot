import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A message that fails twice is kept on disk and retried at the next start.
 *
 * The poll cursor is persisted before the batch is handled, so a message that throws is
 * never fetched again; without this queue it is simply gone.
 */
async function withChannel(state, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webot-pending-'))
  process.env.DSH_HOME = home
  const stateDir = path.join(home, 'webot')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify({ version: 1, ...state }), 'utf8')

  const { createChannel } = await import('../src/channel.js')
  const prompts = []
  const channel = createChannel({
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      prompt: async (request) => {
        prompts.push(request)
        return {}
      },
      list: async () => ({ items: [] }),
    },
    workspaceDirectory: path.join(home, 'dsh_webot'),
  })
  try {
    await run(channel, { home, prompts, stateDir })
  } finally {
    channel.stopAll()
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const account = {
  accountId: 'a@im.bot',
  userId: 'u1@im.wechat',
  token: 't',
  baseUrl: 'http://127.0.0.1:9',
  boundAt: Date.now(),
}

function textMessage(id, text) {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: account.userId,
    item_list: [{ type: 1, text_item: { text } }],
  }
}

test('a queued message is delivered on replay and then removed from the queue', async () => {
  await withChannel(
    {
      accounts: [account],
      bindings: { [`${account.accountId}:${account.userId}`]: { sessionId: 's1', cwd: '.', createdAt: Date.now() } },
      contextTokens: {},
      pendingInbound: [
        { accountId: account.accountId, userId: account.userId, message: textMessage('m1', '之前失败的消息'), attempts: 2 },
      ],
    },
    async (channel, { prompts, stateDir }) => {
      await channel.replayPendingInbound()
      assert.equal(prompts.length, 1, 'the message is handed to the session')
      assert.match(JSON.stringify(prompts[0].content), /之前失败的消息/)

      const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
      assert.equal((state.pendingInbound || []).length, 0, 'the queue is emptied')
    },
  )
})

test('a message whose account disappeared is dropped, not retried forever', async () => {
  await withChannel(
    {
      accounts: [],
      bindings: {},
      contextTokens: {},
      pendingInbound: [
        { accountId: 'gone@im.bot', userId: 'u', message: textMessage('m2', 'x'), attempts: 1 },
      ],
    },
    async (channel, { stateDir }) => {
      await channel.replayPendingInbound()
      const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
      assert.equal((state.pendingInbound || []).length, 0)
    },
  )
})

test('the snapshot reports the queue length', async () => {
  await withChannel(
    {
      accounts: [account],
      bindings: {},
      contextTokens: {},
      pendingInbound: [
        { accountId: account.accountId, userId: account.userId, message: textMessage('m3', 'x'), attempts: 1 },
      ],
    },
    async (channel) => {
      assert.equal(channel.snapshot().pendingInbound, 1)
    },
  )
})
