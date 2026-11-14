import { defineCheck } from 'orca/testing'

export default defineCheck({
  defaultQueue: {},
  fleetView: {
    persisted: {
      plugin: {
        activeTab: 'fleet'
      }
    }
  },
  workbenchView: {
    persisted: {
      plugin: {
        activeTab: 'workbench',
        selectedTaskId: 'linear:LIN-142'
      }
    },
    storage: {
      activeTaskId: 'linear:LIN-142'
    }
  },
  addAndConnectView: {
    persisted: {
      plugin: {
        activeTab: 'create'
      }
    },
    secrets: {
      notionToken: 'ntn_test_token'
    }
  }
})
