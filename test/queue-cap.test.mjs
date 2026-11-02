import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The queue's drop branch, reached from its only reachable direction.
 *
 * A state file can hold more entries than the cap — written by an older version, restored
 * from a backup, or edited by hand. Trimming that on load is fine; doing it silently is
 * not, so this pins both the count and the log line.
 *
 * The cap is lowered through `WEBOT_PENDING_LIMIT`, which is also the knob a busy
 * deployment would raise.
 */
process.env.WEBOT_PENDING_LIMIT = '2'

const account = {
  accountId: 'a@im.bot',
  userId: 'u1@im.wechat',
  token: 't',
  baseUrl: 'http://127.0.0.1:9',
  boundAt: Date.now(),
}

function entry(id) {
  return {
    accountId: account.accountId,
    userId: account.userId,
    message: {
      message_id: id,
      message_type: 1,
      from_user_id: account.userId,
      item_list: [{ type: 1, text_item: { text: `消息 ${id}` } }],
    },
    attempts: 0,
  }
}

test('loading more entries than the cap drops the oldest, and logs each one', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webot-cap-'))
  process.env.DSH_HOME = home
  const stateDir = path.join(home, 'webot')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      version: 1,
      accounts: [account],
      syncBufs: {},
      bindings: {},
      contextTokens: {},
      pendingInbound: [entry('cap-1'), entry('cap-2'), entry('cap-3'), entry('cap-4')],
    }),
    'utf8',
  )

  const { createChannel } = await import('../src/channel.js')
  const channel = createChannel({
    sessionController: { create: async () => ({ sessionId: 's1' }), prompt: async () => ({}) },
    workspaceDirectory: path.join(home, 'dsh_webot'),
  })
  try {
    const snapshot = channel.snapshot()
    assert.equal(snapshot.pendingInbound, 2, 'only the cap survives')
    assert.equal(snapshot.pendingDropped, 2, 'each drop is counted')
    const log = fs.readFileSync(path.join(stateDir, 'events.log'), 'utf8')
    assert.match(log, /pending queue over limit \(2\) on load \| dropped cap-1/)
    assert.match(log, /dropped cap-2/)
  } finally {
    channel.stopAll()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
