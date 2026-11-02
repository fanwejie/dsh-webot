import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A permission prompt whose notification could not be sent must not leave a registered
 * wait behind.
 *
 * The failure mode this guards against is silent: `pendingApprovals` keeps the entry, so
 * every later prompt for that conversation is delegated with "another prompt is already
 * open" and the phone simply stops receiving them.
 */
async function withChannel(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'webot-approval-'))
  process.env.DSH_HOME = home
  const stateDir = path.join(home, 'webot')
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    JSON.stringify({
      version: 1,
      // An account that cannot possibly send: the base URL resolves nowhere.
      accounts: [
        {
          accountId: 'dead@im.bot',
          userId: 'u1@im.wechat',
          token: 't',
          baseUrl: 'http://127.0.0.1:9',
          boundAt: Date.now(),
        },
      ],
      syncBufs: {},
      bindings: { 'dead@im.bot:u1@im.wechat': { sessionId: 's1', cwd: home, createdAt: Date.now() } },
      contextTokens: { 'dead@im.bot:u1@im.wechat': 'ctx' },
    }),
    'utf8',
  )
  const { createChannel } = await import('../src/channel.js')
  const channel = createChannel({
    sessionController: { create: async () => ({ sessionId: 's1' }), prompt: async () => ({}) },
    workspaceDirectory: path.join(home, 'dsh_webot'),
  })
  try {
    await run(channel, home)
  } finally {
    channel.stopAll()
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('a failed approval notification does not leave a pending entry behind', async () => {
  await withChannel(async (channel) => {
    let delegated = false
    const outcome = await channel.handleApproval(
      {
        agent: { id: 's1' },
        toolName: 'bash',
        reason: 'test',
        signal: new AbortController().signal,
      },
      () => {
        delegated = true
        return 'delegated'
      },
    )

    assert.equal(outcome, 'delegated', 'the request must fall through to the desk')
    assert.equal(delegated, true)
    assert.equal(
      channel.snapshot().pendingApprovals,
      0,
      'the registry must not keep a wait that never reached the phone',
    )
  })
})

test('a second prompt is claimable after the first one failed', async () => {
  await withChannel(async (channel) => {
    const request = () => ({
      agent: { id: 's1' },
      toolName: 'bash',
      reason: 'test',
      signal: new AbortController().signal,
    })

    await channel.handleApproval(request(), () => 'delegated')
    // If the first attempt had leaked, this one would be delegated as "already open"
    // before it ever tried to send.
    const second = await channel.handleApproval(request(), () => 'delegated')
    assert.equal(second, 'delegated')
    assert.equal(channel.snapshot().pendingApprovals, 0)
  })
})
