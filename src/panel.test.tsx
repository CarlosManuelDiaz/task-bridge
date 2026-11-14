import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import * as workerMain from './worker'
import { mountWorker } from 'orca/testing'

test('renders ticket queue, dispatches a worktree task, and transitions ticket to In Review', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': null,
      'workspace.list': {
        workspaces: [
          {
            id: 'ws-1',
            kind: 'worktree',
            name: 'main',
            path: '/repo/main',
            branch: 'main',
            hostId: null
          }
        ],
        truncated: false
      }
    }
  })

  const worker = await mountWorker(workerMain, { host })
  const view = await mount(panel, { host })

  // Initial queue shows 3 seeded tickets (Linear, Jira, Notion)
  assert.ok(view.find({ text: /3 tickets/ }))
  assert.ok(view.find({ text: /Start LIN-142/ }))
  assert.ok(view.find({ text: /Start ENG-408/ }))
  assert.ok(view.find({ text: /Start NOT-19/ }))

  // Quick dispatch LIN-142 from the Queue tab
  await view.press({ text: 'Start LIN-142' })
  assert.ok(view.find({ text: /Started \[LIN-142\]/ }))

  // Move ENG-408 to In Review directly from Queue
  await view.press({ text: 'Review ENG-408' })
  assert.ok(view.find({ text: /Moved \[ENG-408\] to In Review/ }))

  // Switch to Workbench tab and verify Target Repository + launch agent
  await view.select({ label: 'Task Bridge Sections' }, 'workbench')
  assert.ok(view.find({ label: 'Target Repository' }))
  assert.ok(view.find({ text: 'Launch Worktree & Agent' }))
  await view.press({ text: 'Launch Worktree & Agent' })

  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])

  await view.unmount()
  await worker.deactivate()
})
