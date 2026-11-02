import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The full prompt is re-sent by turn count, not on every restart.
 *
 * It used to live in memory only, so a restart emptied the schedule and the next
 * message re-sent the whole note — pure token cost, since the conversation's transcript
 * still contains it.
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

/** Run one channel against `home`, feed it one message, and return the prompt text. */
async function runOnce(home, text, id) {
  process.env.DSH_HOME = home
  const stateDir = path.join(home, 'webot')
  if (!fs.existsSync(path.join(stateDir, 'state.json'))) {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(baseState()), 'utf8')
  }
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
  state.pendingInbound = [
    { accountId: account.accountId, userId: account.userId, message: message(id, text), attempts: 1 },
  ]
  fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(state), 'utf8')

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
  try {
    await channel.replayPendingInbound()
  } finally {
    channel.stopAll()
  }
  return prompts[0] || ''
}

function withHome(run) {
  return async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webot-prompt-'))
    try {
      await run(home)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
}

/** The full note is long; the anchor line is ~48 characters. */
const looksFull = (prompt) => prompt.length > 500

test(
  'the first message of a session carries the full note',
  withHome(async (home) => {
    const prompt = await runOnce(home, '你好', 'm1')
    assert.equal(looksFull(prompt), true)
  }),
)

test(
  'a restart does not re-send the note',
  withHome(async (home) => {
    const first = await runOnce(home, '第一条', 'm1')
    assert.equal(looksFull(first), true)

    // A new channel object on the same DSH_HOME is exactly what a restart looks like.
    const second = await runOnce(home, '重启后的第一条', 'm2')
    assert.equal(looksFull(second), false, 'the second turn must be the anchor only')
  }),
)

test(
  'the note comes back when the schedule reaches its turn count',
  withHome(async (home) => {
    await runOnce(home, '第一条', 'm1')
    // The counter goes up by one per anchor turn and the note is due once it reaches
    // the interval, so seeding it at the interval is the boundary case.
    const stateDir = path.join(home, 'webot')
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    state.promptMarks = { s1: { turns: 20, text: state.promptMarks.s1.text } }
    state.promptRefreshTurns = 20
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(state), 'utf8')

    const prompt = await runOnce(home, '到点了', 'm2')
    assert.equal(looksFull(prompt), true)
  }),
)

test(
  'one turn short of the interval stays on the anchor',
  withHome(async (home) => {
    await runOnce(home, '第一条', 'm1')
    const stateDir = path.join(home, 'webot')
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    state.promptMarks = { s1: { turns: 19, text: state.promptMarks.s1.text } }
    state.promptRefreshTurns = 20
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(state), 'utf8')

    const prompt = await runOnce(home, '还差一轮', 'm2')
    assert.equal(looksFull(prompt), false)
  }),
)

test(
  'editing the prompt re-sends it on the next turn',
  withHome(async (home) => {
    await runOnce(home, '第一条', 'm1')
    const stateDir = path.join(home, 'webot')
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8'))
    state.scenarios = [{ id: 'default', name: '默认', content: '全新的人格设定' }]
    state.activeScenarioId = 'default'
    fs.writeFileSync(path.join(stateDir, 'state.json'), JSON.stringify(state), 'utf8')

    const prompt = await runOnce(home, '改完提示词后的第一条', 'm2')
    assert.match(prompt, /全新的人格设定/)
  }),
)
