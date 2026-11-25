// The reader's words for D1ResultPaging.tla: what the card shows and what the user did.
const result = (v) => (v.shown === 'agent' ? "Agent's result" : 'Your result')
const loading = (v) =>
  v.fetch.status === 'paging'
    ? `, page ${v.fetch.page + 1} loading`
    : v.fetch.status === 'sorting'
      ? `, D1 sorting ${v.fetch.sort === 'none' ? 'back to the query order' : v.fetch.sort === 'asc' ? 'ascending' : 'descending'}`
      : v.fetch.status === 'failed'
        ? ', read failed'
        : ''
const order = (v) => (v.sort === 'none' ? '' : v.sort === 'asc' ? ', ascending' : ', descending')

export const title = 'D1 Studio: reading more of a result'

export const state = (v) =>
  `${result(v)}${order(v)}, page ${v.page + 1} on screen${loading(v)}` +
  `${v.run.status === 'running' ? ', your run in flight' : ''} (you asked for page ${v.asked + 1})`

export const group = (v) =>
  v.fetch.status === 'paging' || v.fetch.status === 'sorting' ? 'loading' : v.fetch.status === 'failed' ? 'failed' : 'shown'

export const colors = { shown: 'teal', loading: 'blue', failed: 'orange' }

const busy = (v) =>
  v.fetch.status === 'paging'
    ? ` [while page ${v.fetch.page + 1} loads]`
    : v.fetch.status === 'sorting'
      ? ' [while D1 sorts]'
      : ''

export const step = (action, from, to) => {
  switch (action) {
    case 'YouGoToPage':
      return `you go to page ${to.asked + 1}${busy(from)}`
    case 'YouSort':
      return 'you click the column header'
    case 'YouRun':
      return to.run.sql === 'agent' ? "you run the agent's SQL again" : 'you run your SQL'
    case 'YouRevert':
      return 'you press Revert'
    case 'RunLands':
      return 'your run lands'
    case 'RunFails':
      return 'your run fails'
    case 'TheReadStarts':
      return 'the read goes to D1'
    case 'TheReadLands':
      return from.fetch.status !== to.fetch.status ? 'the rows land' : 'a late reply lands and is ignored'
    case 'TheReadFails':
      return 'the read fails'
    case 'AnAbortedReadEnds':
      return 'an abandoned read ends'
    default:
      return action
  }
}
